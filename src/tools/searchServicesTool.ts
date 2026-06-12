/**
 * search_services — multi-filter service/product discovery over
 * GetClientsProducts (read-only).
 *
 * Accepts ARRAYS of native WHMCS filters (serviceids, product_ids, clientids,
 * domains, usernames) fanned out as one WHMCS query per filter combination,
 * deduplicated by serviceid, then locally filtered (statuses, domain_contains),
 * sorted, and paged. Three response shapes: 'services' pages service rows,
 * 'clients' pages per-client groups, 'products' pages per-product groups.
 *
 * Follows the list-tool patterns: read-only annotations, `{ items, total,
 * count, offset, limit }` envelope with opaque forward cursor, optional
 * governance projection (items are always canonical-service projections when
 * governance is ON; group summaries degrade to ids/counts only).
 */

import { z } from 'zod';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient, WhmcsBusinessError } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { config, isToolAllowed } from '../config.js';
import {
  ensureToolAuth,
  isClientMode,
  ensureClientAllowed,
  AUTH_SHAPE,
} from '../security.js';
import { normalizeToArray } from '../whmcs/normalizers.js';
import {
  READ_ONLY_ANNOTATIONS,
  LIST_TOOL_OUTPUT_SCHEMA,
  encodeCursor,
  decodeCursor,
} from './listTools.js';
import {
  applyGovernanceOrLegacy,
  governedListResult,
  governanceEnabled,
} from '../governance/pipeline.js';
import { mapToCanonicalService } from '../canonical/index.js';

const TOOL_VERSION = 'v1';

/** Hard ceiling on records scanned across all fanned-out WHMCS queries. */
const MAX_SEARCH_SCAN = 20_000;

/**
 * Ceiling on the cartesian fan-out of native filter combinations. Each
 * combination costs at least one WHMCS request; beyond this the caller must
 * narrow the filters instead of brute-forcing the API.
 */
const MAX_QUERY_COMBINATIONS = 100;

const serviceStatusSchema = z.enum([
  'Pending',
  'Active',
  'Suspended',
  'Terminated',
  'Cancelled',
  'Fraud',
]);

export const searchServicesSchema = z.object({
  serviceids: z
    .array(z.number().int().positive())
    .min(1)
    .max(config.MCP_MAX_PAGE_SIZE)
    .optional()
    .describe('One or more WHMCS service IDs. Maps to GetClientsProducts serviceid.'),

  product_ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(config.MCP_MAX_PAGE_SIZE)
    .optional()
    .describe('One or more WHMCS product IDs. Maps to GetClientsProducts pid.'),

  clientids: z
    .array(z.number().int().positive())
    .min(1)
    .max(config.MCP_MAX_PAGE_SIZE)
    .optional()
    .describe('One or more WHMCS client IDs. Maps to GetClientsProducts clientid.'),

  domains: z
    .array(z.string().min(1))
    .min(1)
    .max(config.MCP_MAX_PAGE_SIZE)
    .optional()
    .describe('Exact domain filters. Maps to GetClientsProducts domain.'),

  usernames: z
    .array(z.string().min(1))
    .min(1)
    .max(config.MCP_MAX_PAGE_SIZE)
    .optional()
    .describe('Exact username filters. Maps to GetClientsProducts username2.'),

  statuses: z
    .array(serviceStatusSchema)
    .min(1)
    .optional()
    .describe('Service statuses. Not a native WHMCS filter; applied locally after fetching.'),

  domain_contains: z
    .string()
    .min(1)
    .optional()
    .describe('Case-insensitive local contains filter for service domain.'),

  view: z
    .enum(['services', 'clients', 'products'])
    .default('services')
    .describe(
      "Response shape and pagination unit: 'services' pages service rows, 'clients' pages client groups, 'products' pages product groups."
    ),

  include_client_details: z
    .boolean()
    .default(false)
    .describe(
      'When true, adds basic client identity fields to returned services/groups for the current page. Ignored when governance is enabled.'
    ),

  include_server: z.boolean().default(true),
  include_usage: z.boolean().default(false),
  include_custom_fields: z.boolean().default(false),
  include_config_options: z.boolean().default(false),

  limit: z
    .number()
    .int()
    .min(1)
    .max(config.MCP_MAX_PAGE_SIZE)
    .default(50)
    .describe(
      'Number of result items returned in this MCP response. The item type depends on view.'
    ),

  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Offset into the final aggregated result, in units of the selected view.'),

  cursor: z
    .string()
    .optional()
    .describe(
      "Opaque pagination cursor from a prior response's nextCursor; pages forward through ALL matched results. When set it overrides offset."
    ),

  sort_by: z
    .enum(['serviceid', 'clientid', 'product_id', 'next_due_date', 'status'])
    .default('serviceid'),

  sort_order: z.enum(['asc', 'desc']).default('asc'),

  allow_broad_search: z
    .boolean()
    .default(false)
    .describe('Required when no primary filters are provided. Prevents accidental full scans.'),

  contract: z
    .string()
    .optional()
    .describe('Requested data contract (honoured only if the resolved consumer permits it)'),
});

type SearchServicesParams = z.infer<typeof searchServicesSchema>;
type SortBy = SearchServicesParams['sort_by'];
type SortOrder = SearchServicesParams['sort_order'];

interface WhmcsServiceRecord {
  id?: unknown;
  qty?: unknown;
  clientid?: unknown;
  orderid?: unknown;
  ordernumber?: unknown;
  pid?: unknown;
  regdate?: unknown;
  name?: unknown;
  translated_name?: unknown;
  groupname?: unknown;
  translated_groupname?: unknown;
  domain?: unknown;
  dedicatedip?: unknown;
  serverid?: unknown;
  servername?: unknown;
  serverip?: unknown;
  serverhostname?: unknown;
  suspensionreason?: unknown;
  firstpaymentamount?: unknown;
  recurringamount?: unknown;
  paymentmethod?: unknown;
  paymentmethodname?: unknown;
  billingcycle?: unknown;
  nextduedate?: unknown;
  status?: unknown;
  username?: unknown;
  password?: unknown;
  ns1?: unknown;
  ns2?: unknown;
  diskusage?: unknown;
  disklimit?: unknown;
  bwusage?: unknown;
  bwlimit?: unknown;
  lastupdate?: unknown;
  customfields?: unknown;
  configoptions?: unknown;
}

interface WhmcsGetClientsProductsResponse {
  products?: { product?: unknown };
  totalresults?: unknown;
  numreturned?: unknown;
  startnumber?: unknown;
}

interface WhmcsClientDetailsResponse {
  id?: unknown;
  firstname?: unknown;
  lastname?: unknown;
  fullname?: unknown;
  email?: unknown;
  companyname?: unknown;
  status?: unknown;
}

interface BasicClientDetails {
  clientid: number;
  firstname: string;
  lastname: string;
  fullname: string;
  email: string;
  companyname: string | null;
  status: string;
}

export interface NormalizedService {
  serviceid: number;
  qty: number | null;
  clientid: number;
  orderid: number | null;
  ordernumber: string | null;
  product_id: number | null;
  registration_date: string | null;
  product_name: string | null;
  translated_product_name: string | null;
  group_name: string | null;
  translated_group_name: string | null;
  domain: string | null;
  status: string | null;
  suspension_reason: string | null;
  first_payment_amount: string | null;
  recurring_amount: string | null;
  payment_method: string | null;
  payment_method_name: string | null;
  billing_cycle: string | null;
  next_due_date: string | null;
  server?: {
    id: number | null;
    name: string | null;
    ip: string | null;
    hostname: string | null;
  };
  nameservers?: {
    ns1: string | null;
    ns2: string | null;
  };
  usage?: {
    disk_usage: string | null;
    disk_limit: string | null;
    bandwidth_usage: string | null;
    bandwidth_limit: string | null;
    last_update: string | null;
  };
  custom_fields?: { id?: number; name?: string; value?: string }[];
  config_options?: { id?: number; option?: string; type?: string; value?: string }[];
  client?: BasicClientDetails;
}

interface ClientGroup {
  clientid: number;
  service_count: number;
  product_count: number;
  product_ids: number[];
  serviceids: number[];
  services: NormalizedService[];
  client?: BasicClientDetails;
}

interface ProductGroup {
  product_id: number | null;
  product_name: string | null;
  translated_product_name: string | null;
  group_name: string | null;
  translated_group_name: string | null;
  service_count: number;
  client_count: number;
  clientids: number[];
  serviceids: number[];
  services: NormalizedService[];
}

interface ToolResponse {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function toolError(message: string, extra?: Record<string, unknown>): ToolResponse {
  const payload = { isError: true, error: message, ...(extra ?? {}) };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function uniqueValues<T extends string | number>(values?: T[]): T[] | undefined {
  if (!values || values.length === 0) return undefined;
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const value of values) {
    const key = typeof value === 'string' ? value : String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  return unique;
}

function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean' &&
    typeof value !== 'bigint'
  ) {
    return null;
  }
  const normalized = `${value}`.trim();
  return normalized.length === 0 ? null : normalized;
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (normalized.length === 0) return null;
    const parsed = Number.parseInt(normalized, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toNullableDate(value: unknown): string | null {
  const normalized = toNullableString(value);
  if (!normalized) return null;
  if (normalized === '0000-00-00' || normalized === '0000-00-00 00:00:00') return null;
  return normalized;
}

function toComparableString(value: unknown): string | null {
  const normalized = toNullableString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function hasPrimaryFilter(params: SearchServicesParams): boolean {
  return [
    params.serviceids?.length ?? 0,
    params.product_ids?.length ?? 0,
    params.clientids?.length ?? 0,
    params.domains?.length ?? 0,
    params.usernames?.length ?? 0,
    params.statuses?.length ?? 0,
    params.domain_contains?.length ?? 0,
  ].some((value) => value > 0);
}

/**
 * Resolve the effective client-id scope. In client access mode the requested
 * ids must each pass `ensureClientAllowed`; with no ids requested the scope
 * defaults to the whole MCP_ALLOWED_CLIENT_IDS allowlist.
 */
function resolveScopedClientIds(params: SearchServicesParams): {
  clientids?: number[];
  error?: ToolResponse;
} {
  const requestedClientIds = uniqueValues(params.clientids);

  if (!isClientMode()) {
    return { clientids: requestedClientIds };
  }

  const allowedClientIds = uniqueValues(config.MCP_ALLOWED_CLIENT_IDS) ?? [];
  if (allowedClientIds.length === 0) {
    return {
      error: toolError('Client access mode requires MCP_ALLOWED_CLIENT_IDS to be configured.'),
    };
  }

  if (!requestedClientIds) {
    return { clientids: allowedClientIds };
  }

  for (const clientId of requestedClientIds) {
    const scopeError = ensureClientAllowed(clientId) as ToolResponse | null;
    if (scopeError) return { error: scopeError };
  }

  return { clientids: requestedClientIds };
}

/**
 * Fan the array filters out into one native GetClientsProducts query per
 * combination of values (WHMCS accepts only scalar filter params).
 */
function buildNativeQueries(
  params: SearchServicesParams,
  scopedClientIds?: number[]
): Record<string, unknown>[] {
  const nativeFilters: [string, (string | number)[]][] = [];

  const serviceIds = uniqueValues(params.serviceids);
  const productIds = uniqueValues(params.product_ids);
  const domainFilters = uniqueValues(params.domains);
  const usernameFilters = uniqueValues(params.usernames);

  if (serviceIds) nativeFilters.push(['serviceid', serviceIds]);
  if (productIds) nativeFilters.push(['pid', productIds]);
  if (scopedClientIds) nativeFilters.push(['clientid', scopedClientIds]);
  if (domainFilters) nativeFilters.push(['domain', domainFilters]);
  if (usernameFilters) nativeFilters.push(['username2', usernameFilters]);

  if (nativeFilters.length === 0) return [{}];

  let combinations: Record<string, unknown>[] = [{}];
  for (const [key, values] of nativeFilters) {
    const next: Record<string, unknown>[] = [];
    for (const combination of combinations) {
      for (const value of values) {
        next.push({ ...combination, [key]: value });
      }
    }
    combinations = next;
  }

  const seen = new Set<string>();
  return combinations.filter((combination) => {
    const key = JSON.stringify(
      Object.entries(combination).sort(([left], [right]) => left.localeCompare(right))
    );
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Drain all WHMCS pages for one native query, bounded by the caller's
 * remaining scan budget. Returns the records plus whether the query was
 * exhausted within budget.
 */
async function fetchProductsForQuery(
  whmcsClient: WhmcsClient,
  query: Record<string, unknown>,
  scanBudget: number
): Promise<{ records: WhmcsServiceRecord[]; exhausted: boolean }> {
  const records: WhmcsServiceRecord[] = [];
  const limitnum = config.MCP_MAX_PAGE_SIZE;
  let limitstart = 0;

  while (records.length < scanBudget) {
    const response = await whmcsClient.read<WhmcsGetClientsProductsResponse>(
      'GetClientsProducts',
      {
        ...query,
        limitstart,
        limitnum: Math.min(limitnum, scanBudget - records.length),
      }
    );

    const pageRecords = normalizeToArray<WhmcsServiceRecord>(response.products?.product);
    records.push(...pageRecords);

    const numreturned = toNullableNumber(response.numreturned) ?? pageRecords.length;
    const totalresults = toNullableNumber(response.totalresults);
    const startnumber = toNullableNumber(response.startnumber);

    if (pageRecords.length === 0 || numreturned < Math.min(limitnum, scanBudget)) {
      return { records, exhausted: true };
    }
    if (
      startnumber !== null &&
      totalresults !== null &&
      startnumber + numreturned >= totalresults
    ) {
      return { records, exhausted: true };
    }

    limitstart += pageRecords.length;
  }

  return { records, exhausted: false };
}

function normalizeCustomFields(value: unknown): { id?: number; name?: string; value?: string }[] {
  const container = (value as { customfield?: unknown } | undefined)?.customfield ?? value;
  return normalizeToArray<Record<string, unknown>>(container)
    .map((field) => {
      const normalizedField: { id?: number; name?: string; value?: string } = {};
      const id = toNullableNumber(field.id);
      const name = toNullableString(field.name);
      const fieldValue = toNullableString(field.value);
      if (id !== null) normalizedField.id = id;
      if (name !== null) normalizedField.name = name;
      if (fieldValue !== null) normalizedField.value = fieldValue;
      return normalizedField;
    })
    .filter((field) => Object.keys(field).length > 0);
}

function normalizeConfigOptions(
  value: unknown
): { id?: number; option?: string; type?: string; value?: string }[] {
  const container = (value as { configoption?: unknown } | undefined)?.configoption ?? value;
  return normalizeToArray<Record<string, unknown>>(container)
    .map((option) => {
      const normalizedOption: { id?: number; option?: string; type?: string; value?: string } = {};
      const id = toNullableNumber(option.id);
      const name = toNullableString(option.option);
      const type = toNullableString(option.type);
      const optionValue = toNullableString(option.value);
      if (id !== null) normalizedOption.id = id;
      if (name !== null) normalizedOption.option = name;
      if (type !== null) normalizedOption.type = type;
      if (optionValue !== null) normalizedOption.value = optionValue;
      return normalizedOption;
    })
    .filter((option) => Object.keys(option).length > 0);
}

function matchesFilters(
  record: WhmcsServiceRecord,
  params: SearchServicesParams,
  scopedClientIds?: number[]
): boolean {
  const serviceIds = uniqueValues(params.serviceids);
  const productIds = uniqueValues(params.product_ids);
  const domains = uniqueValues(params.domains)?.map((domain) => domain.toLowerCase());
  const usernames = uniqueValues(params.usernames);
  const statuses = params.statuses ? new Set<string>(params.statuses) : undefined;
  const serviceId = toNullableNumber(record.id);
  const clientId = toNullableNumber(record.clientid);
  const productId = toNullableNumber(record.pid);
  const domain = toComparableString(record.domain);
  const username = toNullableString(record.username);
  const status = toNullableString(record.status);
  const domainContains = params.domain_contains?.trim().toLowerCase();

  if (serviceIds && (serviceId === null || !serviceIds.includes(serviceId))) return false;
  if (productIds && (productId === null || !productIds.includes(productId))) return false;
  if (scopedClientIds && (clientId === null || !scopedClientIds.includes(clientId))) return false;
  if (domains && (domain === null || !domains.includes(domain))) return false;
  if (usernames && (username === null || !usernames.includes(username))) return false;
  if (statuses && (status === null || !statuses.has(status))) return false;
  if (domainContains && !domain?.includes(domainContains)) return false;

  return true;
}

/**
 * Project one raw WHMCS record into the legacy response shape. Credentials
 * (username/password) are NEVER exposed; usage/custom fields/config options
 * are opt-in.
 */
function normalizeService(
  record: WhmcsServiceRecord,
  params: SearchServicesParams
): NormalizedService | null {
  const serviceid = toNullableNumber(record.id);
  const clientid = toNullableNumber(record.clientid);
  if (serviceid === null || clientid === null) return null;

  const normalized: NormalizedService = {
    serviceid,
    qty: toNullableNumber(record.qty),
    clientid,
    orderid: toNullableNumber(record.orderid),
    ordernumber: toNullableString(record.ordernumber),
    product_id: toNullableNumber(record.pid),
    registration_date: toNullableDate(record.regdate),
    product_name: toNullableString(record.name),
    translated_product_name: toNullableString(record.translated_name),
    group_name: toNullableString(record.groupname),
    translated_group_name: toNullableString(record.translated_groupname),
    domain: toNullableString(record.domain),
    status: toNullableString(record.status),
    suspension_reason: toNullableString(record.suspensionreason),
    first_payment_amount: toNullableString(record.firstpaymentamount),
    recurring_amount: toNullableString(record.recurringamount),
    payment_method: toNullableString(record.paymentmethod),
    payment_method_name: toNullableString(record.paymentmethodname),
    billing_cycle: toNullableString(record.billingcycle),
    next_due_date: toNullableDate(record.nextduedate),
  };

  if (params.include_server) {
    normalized.server = {
      id: toNullableNumber(record.serverid),
      name: toNullableString(record.servername),
      ip: toNullableString(record.serverip),
      hostname: toNullableString(record.serverhostname),
    };
  }

  const ns1 = toNullableString(record.ns1);
  const ns2 = toNullableString(record.ns2);
  if (ns1 !== null || ns2 !== null) {
    normalized.nameservers = { ns1, ns2 };
  }

  if (params.include_usage) {
    normalized.usage = {
      disk_usage: toNullableString(record.diskusage),
      disk_limit: toNullableString(record.disklimit),
      bandwidth_usage: toNullableString(record.bwusage),
      bandwidth_limit: toNullableString(record.bwlimit),
      last_update: toNullableDate(record.lastupdate),
    };
  }

  if (params.include_custom_fields) {
    normalized.custom_fields = normalizeCustomFields(record.customfields);
  }

  if (params.include_config_options) {
    normalized.config_options = normalizeConfigOptions(record.configoptions);
  }

  return normalized;
}

function compareNullableValues<T>(
  left: T | null,
  right: T | null,
  compare: (leftValue: T, rightValue: T) => number,
  order: SortOrder
): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const result = compare(left, right);
  return order === 'asc' ? result : -result;
}

function compareNumbers(left: number, right: number): number {
  return left - right;
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareServices(
  left: NormalizedService,
  right: NormalizedService,
  sortBy: SortBy,
  sortOrder: SortOrder
): number {
  const compareByField = (() => {
    switch (sortBy) {
      case 'clientid':
        return compareNullableValues(left.clientid, right.clientid, compareNumbers, sortOrder);
      case 'product_id':
        return compareNullableValues(
          left.product_id,
          right.product_id,
          compareNumbers,
          sortOrder
        );
      case 'next_due_date':
        return compareNullableValues(
          left.next_due_date,
          right.next_due_date,
          compareStrings,
          sortOrder
        );
      case 'status':
        return compareNullableValues(left.status, right.status, compareStrings, sortOrder);
      case 'serviceid':
      default:
        return compareNullableValues(left.serviceid, right.serviceid, compareNumbers, sortOrder);
    }
  })();

  if (compareByField !== 0) return compareByField;
  if (left.serviceid !== right.serviceid) return left.serviceid - right.serviceid;
  return left.clientid - right.clientid;
}

async function fetchClientDetails(
  whmcsClient: WhmcsClient,
  clientIds: number[]
): Promise<{ details: Map<number, BasicClientDetails>; warnings: string[] }> {
  const details = new Map<number, BasicClientDetails>();
  const warnings: string[] = [];

  for (const clientId of uniqueValues(clientIds) ?? []) {
    try {
      const response = await whmcsClient.read<WhmcsClientDetailsResponse>('GetClientsDetails', {
        clientid: clientId,
      });

      const firstname = toNullableString(response.firstname) ?? '';
      const lastname = toNullableString(response.lastname) ?? '';
      const fallbackFullname = `${firstname} ${lastname}`.trim() || firstname || lastname;
      const fullname = toNullableString(response.fullname) ?? fallbackFullname;

      details.set(clientId, {
        clientid: clientId,
        firstname,
        lastname,
        fullname,
        email: toNullableString(response.email) ?? '',
        companyname: toNullableString(response.companyname),
        status: toNullableString(response.status) ?? 'Unknown',
      });
    } catch (error) {
      if (error instanceof WhmcsBusinessError) {
        warnings.push(`Client details could not be enriched for clientid ${clientId}.`);
        continue;
      }
      throw error;
    }
  }

  return { details, warnings };
}

function attachClientDetails(
  services: NormalizedService[],
  clientDetails: Map<number, BasicClientDetails>
): NormalizedService[] {
  return services.map((service) => {
    const client = clientDetails.get(service.clientid);
    return client ? { ...service, client } : service;
  });
}

function buildClientGroups(services: NormalizedService[]): ClientGroup[] {
  const groups = new Map<number, ClientGroup>();

  for (const service of services) {
    let group = groups.get(service.clientid);
    if (!group) {
      group = {
        clientid: service.clientid,
        service_count: 0,
        product_count: 0,
        product_ids: [],
        serviceids: [],
        services: [],
      };
      groups.set(service.clientid, group);
    }

    group.service_count += 1;
    group.serviceids.push(service.serviceid);
    group.services.push(service);

    if (service.product_id !== null && !group.product_ids.includes(service.product_id)) {
      group.product_ids.push(service.product_id);
      group.product_count += 1;
    }
  }

  return Array.from(groups.values());
}

function buildProductGroups(services: NormalizedService[]): ProductGroup[] {
  const groups = new Map<string, ProductGroup>();

  for (const service of services) {
    const key = service.product_id === null ? '__null__' : String(service.product_id);
    let group = groups.get(key);
    if (!group) {
      group = {
        product_id: service.product_id,
        product_name: service.product_name,
        translated_product_name: service.translated_product_name,
        group_name: service.group_name,
        translated_group_name: service.translated_group_name,
        service_count: 0,
        client_count: 0,
        clientids: [],
        serviceids: [],
        services: [],
      };
      groups.set(key, group);
    }

    group.service_count += 1;
    group.serviceids.push(service.serviceid);
    group.services.push(service);

    if (!group.clientids.includes(service.clientid)) {
      group.clientids.push(service.clientid);
      group.client_count += 1;
    }
  }

  return Array.from(groups.values());
}

function buildFiltersApplied(
  params: SearchServicesParams,
  scopedClientIds?: number[]
): Record<string, unknown> {
  const { cursor: _cursor, contract: _contract, ...rest } = params;
  const filtersApplied: Record<string, unknown> = { ...rest };

  if (isClientMode() && !params.clientids && scopedClientIds) {
    filtersApplied.clientids = scopedClientIds;
    filtersApplied.client_scope_enforced = true;
  }

  return filtersApplied;
}

function finalizeWarnings(warnings: string[]): string[] | undefined {
  const uniqueWarnings = uniqueValues(warnings);
  return uniqueWarnings && uniqueWarnings.length > 0 ? uniqueWarnings : undefined;
}

/** Strip nested service rows from group summaries for governed responses. */
function groupSummaryIdsOnly(
  group: ClientGroup | ProductGroup
): Record<string, unknown> {
  const { services: _services, ...summary } = group as unknown as Record<string, unknown> & {
    services: unknown;
  };
  delete (summary as { client?: unknown }).client;
  return summary;
}

export function registerSearchServicesTool(
  server: McpServer,
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter
): void {
  if (!isToolAllowed('search_services')) return;

  const handler: ToolCallback<z.ZodRawShape> = (async (rawParams: Record<string, unknown>) => {
    const log = logger.child();
    const t0 = Date.now();

    try {
      const authToken =
        typeof rawParams.auth_token === 'string' ? rawParams.auth_token : undefined;

      const authErr = ensureToolAuth(rawParams);
      if (authErr) return authErr;

      log.logToolCall('search_services', rawParams, false);
      if (!rl.tryConsume()) throw new RateLimitError();

      const params = searchServicesSchema.parse(rawParams);
      const requestedContract = params.contract;
      const primaryFilterPresent = hasPrimaryFilter(params);

      if (!primaryFilterPresent && !params.allow_broad_search) {
        return toolError('At least one filter is required unless allow_broad_search=true.');
      }

      const scopeResolution = resolveScopedClientIds(params);
      if (scopeResolution.error) return scopeResolution.error;

      const scopedClientIds = scopeResolution.clientids;
      const queries = buildNativeQueries(params, scopedClientIds);
      if (queries.length > MAX_QUERY_COMBINATIONS) {
        return toolError(
          `Filter fan-out produces ${queries.length} WHMCS queries (max ${MAX_QUERY_COMBINATIONS}). Narrow the array filters or split the search.`
        );
      }

      const warnings: string[] = [];
      if (!primaryFilterPresent && params.allow_broad_search) {
        warnings.push('Broad search executed because allow_broad_search=true.');
      }
      if (params.statuses?.length || params.domain_contains) {
        warnings.push('Local filters were applied after fetching WHMCS records.');
      }

      const governed = governanceEnabled();
      if (governed && params.include_client_details) {
        warnings.push(
          'include_client_details is ignored when governance is enabled; use get_client_details for governed client data.'
        );
      }

      const recordsByServiceId = new Map<number, WhmcsServiceRecord>();
      let scanned = 0;
      let completeScan = true;

      for (const query of queries) {
        const budget = MAX_SEARCH_SCAN - scanned;
        if (budget <= 0) {
          completeScan = false;
          break;
        }

        const { records: pageRecords, exhausted } = await fetchProductsForQuery(
          whmcs,
          query,
          budget
        );
        scanned += pageRecords.length;
        if (!exhausted) completeScan = false;

        for (const record of pageRecords) {
          const serviceId = toNullableNumber(record.id);
          if (serviceId === null) continue;
          if (!matchesFilters(record, params, scopedClientIds)) continue;
          if (!recordsByServiceId.has(serviceId)) {
            recordsByServiceId.set(serviceId, record);
          }
        }
      }

      if (!completeScan) {
        warnings.push(
          `Scan stopped at ${MAX_SEARCH_SCAN} records; results may be partial. Narrow the filters.`
        );
      }

      let services = Array.from(recordsByServiceId.values())
        .map((record) => normalizeService(record, params))
        .filter((service): service is NormalizedService => service !== null);

      if (isClientMode() && scopedClientIds) {
        services = services.filter((service) => scopedClientIds.includes(service.clientid));
      }

      services.sort((left, right) =>
        compareServices(left, right, params.sort_by, params.sort_order)
      );

      if (services.length === 0) {
        warnings.push('No matching services were found.');
      }

      const filtersApplied = buildFiltersApplied(params, scopedClientIds);
      const totalMatched = services.length;
      const effectiveOffset =
        typeof params.cursor === 'string' ? decodeCursor(params.cursor) : params.offset;

      const rawByServiceId = (page: NormalizedService[]): WhmcsServiceRecord[] =>
        page
          .map((service) => recordsByServiceId.get(service.serviceid))
          .filter((record): record is WhmcsServiceRecord => record !== undefined);

      const baseEnvelope = (unitTotal: number, count: number) => {
        const hasMore = effectiveOffset + count < unitTotal;
        const nextCursor =
          hasMore && count === params.limit
            ? encodeCursor(effectiveOffset + count)
            : undefined;
        return {
          total: unitTotal,
          count,
          offset: effectiveOffset,
          limit: params.limit,
          ...(nextCursor !== undefined ? { nextCursor } : {}),
          view: params.view,
          total_matched: totalMatched,
          scanned,
          complete_scan: completeScan,
          filters_applied: filtersApplied,
        };
      };

      if (params.view === 'services') {
        const page = services.slice(effectiveOffset, effectiveOffset + params.limit);
        let items = page;

        if (!governed && params.include_client_details && page.length > 0) {
          const enrichment = await fetchClientDetails(
            whmcs,
            page.map((service) => service.clientid)
          );
          warnings.push(...enrichment.warnings);
          items = attachClientDetails(page, enrichment.details);
        }

        const envelope = {
          ...baseEnvelope(totalMatched, page.length),
          ...(finalizeWarnings(warnings) ? { warnings: finalizeWarnings(warnings) } : {}),
        };

        log.logToolResult('search_services', true, Date.now() - t0);

        const legacy = { items, ...envelope };
        return applyGovernanceOrLegacy({
          enabled: governed,
          legacy,
          govern: () =>
            governedListResult({
              rows: rawByServiceId(page),
              mapItem: mapToCanonicalService,
              envelope,
              authToken,
              requestedContract,
            }),
        });
      }

      const groups: (ClientGroup | ProductGroup)[] =
        params.view === 'clients' ? buildClientGroups(services) : buildProductGroups(services);
      const pagedGroups = groups.slice(effectiveOffset, effectiveOffset + params.limit);

      if (!governed && params.include_client_details && pagedGroups.length > 0) {
        const clientIds = pagedGroups.flatMap((group) =>
          'clientid' in group ? [group.clientid] : group.clientids
        );
        const enrichment = await fetchClientDetails(whmcs, clientIds);
        warnings.push(...enrichment.warnings);

        for (const group of pagedGroups) {
          if ('clientid' in group) {
            const client = enrichment.details.get(group.clientid);
            if (client) group.client = client;
          }
          group.services = attachClientDetails(group.services, enrichment.details);
        }
      }

      const groupCountKey = params.view === 'clients' ? 'total_clients' : 'total_products';
      const envelope = {
        ...baseEnvelope(groups.length, pagedGroups.length),
        [groupCountKey]: groups.length,
        ...(finalizeWarnings(warnings) ? { warnings: finalizeWarnings(warnings) } : {}),
      };

      log.logToolResult('search_services', true, Date.now() - t0);

      const legacy = { items: pagedGroups, ...envelope };
      return applyGovernanceOrLegacy({
        enabled: governed,
        legacy,
        govern: () => {
          // Governed group views: items are the canonical-service projections of
          // every service inside the paged groups; group summaries degrade to
          // ids/counts only so no ungoverned service fields leak via the envelope.
          const pageServices = pagedGroups.flatMap((group) => group.services);
          return governedListResult({
            rows: rawByServiceId(pageServices),
            mapItem: mapToCanonicalService,
            envelope: {
              ...envelope,
              groups: pagedGroups.map(groupSummaryIdsOnly),
            },
            authToken,
            requestedContract,
          });
        },
      });
    } catch (e) {
      log.logToolResult(
        'search_services',
        false,
        Date.now() - t0,
        e instanceof Error ? e.message : String(e)
      );
      if (e instanceof RateLimitError || e instanceof WhmcsBusinessError) {
        return toolError(e.message);
      }
      throw e;
    }
  }) as unknown as ToolCallback<z.ZodRawShape>;

  server.registerTool(
    'search_services',
    {
      description: `Search WHMCS client services/products via GetClientsProducts (read-only). Pass arrays such as product_ids, clientids, serviceids, domains, or usernames to search multiple values in one call; statuses and domain_contains filter locally. view='services' pages service rows, view='clients' groups by client, view='products' groups by product. Page with limit/offset or the opaque nextCursor. Version: ${TOOL_VERSION}`,
      inputSchema: { ...searchServicesSchema.shape, ...AUTH_SHAPE },
      outputSchema: LIST_TOOL_OUTPUT_SCHEMA,
      annotations: { ...READ_ONLY_ANNOTATIONS },
    },
    handler
  );
}
