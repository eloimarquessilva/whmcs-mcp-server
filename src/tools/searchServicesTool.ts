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
import { ensureToolAuth, isClientMode, ensureClientAllowed, AUTH_SHAPE } from '../security.js';
import { normalizeToArray } from '../whmcs/normalizers.js';
import { READ_ONLY_ANNOTATIONS, LIST_TOOL_OUTPUT_SCHEMA } from './listTools.js';
import {
  applyGovernanceOrLegacy,
  governedListResult,
  governListProjection,
  governanceEnabled,
  getProjectionEnv,
  getConsumerRegistry,
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

  include_group_services: z
    .boolean()
    .default(false)
    .describe(
      "Group views only ('clients'/'products'): when true, nest the full (or projected) service rows inside each group. Default false returns each group as ids and counts (serviceids[]) without the nested services, keeping the payload small."
    ),

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
type ViewType = SearchServicesParams['view'];

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

/**
 * Error responses mirror the rest of the repo's read tools: human-readable
 * `content` + `isError`, but NO `structuredContent`. Emitting structuredContent
 * here would make a strict MCP runtime validate the error payload against the
 * success `outputSchema` (which requires items/total/count/offset/limit) and
 * reject it. (Governed consumer-denied errors keep structuredContent — they go
 * through the governance pipeline, not this helper.)
 */
function toolError(message: string, extra?: Record<string, unknown>): ToolResponse {
  const payload = { isError: true, error: message, ...(extra ?? {}) };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
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

/**
 * A NATIVE primary filter is one that narrows the WHMCS query itself
 * (serviceids/product_ids/clientids/domains/usernames). `statuses` and
 * `domain_contains` are applied LOCALLY after fetching and do NOT reduce the
 * backend scan, so they must not satisfy the broad-search guard.
 */
function hasNativePrimaryFilter(params: SearchServicesParams): boolean {
  return [
    params.serviceids?.length ?? 0,
    params.product_ids?.length ?? 0,
    params.clientids?.length ?? 0,
    params.domains?.length ?? 0,
    params.usernames?.length ?? 0,
  ].some((value) => value > 0);
}

/** Local-only filters: honoured client-side, never narrow the WHMCS query. */
function hasLocalFilter(params: SearchServicesParams): boolean {
  return (params.statuses?.length ?? 0) > 0 || (params.domain_contains?.length ?? 0) > 0;
}

/**
 * Product of the de-duplicated cardinalities of every native filter dimension
 * — i.e. how many GetClientsProducts queries the fan-out WOULD create —
 * computed WITHOUT materializing the cartesian product, so an oversized
 * request is rejected before any memory is spent (worst case 100^5).
 */
function nativeCombinationCount(params: SearchServicesParams, scopedClientIds?: number[]): number {
  const cardinalities = [
    uniqueValues(params.serviceids)?.length,
    uniqueValues(params.product_ids)?.length,
    scopedClientIds?.length,
    uniqueValues(params.domains)?.length,
    uniqueValues(params.usernames)?.length,
  ].filter((value): value is number => typeof value === 'number' && value > 0);

  return cardinalities.reduce((product, value) => product * value, 1);
}

/**
 * View-tagged opaque cursor, LOCAL to search_services (the shared
 * encode/decodeCursor in listTools are reused by other tools and must stay
 * view-agnostic). Encodes `{ offset, view }`; a cursor minted for a different
 * view decodes to the first page and flags `viewMismatch` so the caller can
 * warn. Legacy offset-only cursors (no `view`) are still accepted.
 */
function encodeSearchServicesCursor(offset: number, view: ViewType): string {
  const safe = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  return Buffer.from(JSON.stringify({ offset: safe, view }), 'utf8').toString('base64');
}

function decodeSearchServicesCursor(
  token: string | undefined,
  expectedView: ViewType
): { offset: number; viewMismatch: boolean } {
  if (typeof token !== 'string' || token.length === 0) {
    return { offset: 0, viewMismatch: false };
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') {
      return { offset: 0, viewMismatch: false };
    }
    const record = parsed as Record<string, unknown>;
    const rawOffset = record.offset;
    const offset =
      typeof rawOffset === 'number' && Number.isFinite(rawOffset) && rawOffset >= 0
        ? Math.floor(rawOffset)
        : 0;
    const cursorView = record.view;
    if (typeof cursorView === 'string' && cursorView !== expectedView) {
      return { offset: 0, viewMismatch: true };
    }
    return { offset, viewMismatch: false };
  } catch {
    return { offset: 0, viewMismatch: false };
  }
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

/** Read one WHMCS page, consuming a rate-limit token first (1 token / read). */
async function readWithRateLimit<T>(
  whmcsClient: WhmcsClient,
  rl: RateLimiter,
  action: string,
  params: Record<string, unknown>
): Promise<T> {
  if (!rl.tryConsume()) throw new RateLimitError();
  return whmcsClient.read<T>(action, params);
}

/**
 * Drain all WHMCS pages for one native query, bounded by the caller's
 * remaining scan budget. Returns the records plus whether the query was
 * exhausted within budget. Every page consumes a rate-limit token (1.1).
 */
async function fetchProductsForQuery(
  whmcsClient: WhmcsClient,
  rl: RateLimiter,
  query: Record<string, unknown>,
  scanBudget: number
): Promise<{ records: WhmcsServiceRecord[]; exhausted: boolean }> {
  const records: WhmcsServiceRecord[] = [];
  const limitnum = config.MCP_MAX_PAGE_SIZE;
  let limitstart = 0;

  while (records.length < scanBudget) {
    // The amount THIS iteration actually asks WHMCS for (trimmed by budget).
    const requestedLimit = Math.min(limitnum, scanBudget - records.length);
    const response = await readWithRateLimit<WhmcsGetClientsProductsResponse>(
      whmcsClient,
      rl,
      'GetClientsProducts',
      { ...query, limitstart, limitnum: requestedLimit }
    );

    const pageRecords = normalizeToArray<WhmcsServiceRecord>(response.products?.product);
    records.push(...pageRecords);

    const numreturned = toNullableNumber(response.numreturned) ?? pageRecords.length;
    const totalresults = toNullableNumber(response.totalresults);
    const startnumber = toNullableNumber(response.startnumber);

    // Authoritative proof of exhaustion: WHMCS says this page reaches the end.
    if (
      startnumber !== null &&
      totalresults !== null &&
      startnumber + numreturned >= totalresults
    ) {
      return { records, exhausted: true };
    }
    // Empty page, or a page shorter than what THIS iteration requested, means
    // the source drained. Comparing against `requestedLimit` (budget-trimmed)
    // rather than the full page size avoids falsely claiming exhaustion when we
    // only stopped because the scan budget ran out (3.2 / P2).
    if (pageRecords.length === 0 || numreturned < requestedLimit) {
      return { records, exhausted: true };
    }

    limitstart += pageRecords.length;
  }

  // Hit the scan budget without proof of exhaustion ⇒ more rows may remain.
  return { records, exhausted: false };
}

function normalizeCustomFields(value: unknown): { id?: number; name?: string; value?: string }[] {
  const container = (value as { customfield?: unknown } | undefined)?.customfield ?? value;
  return normalizeToArray<Record<string, unknown>>(container)
    .map((field) => {
      const normalizedField: { id?: number; name?: string; value?: string } = {};
      const id = toNullableNumber(field.id);
      // WHMCS uses `name` on some endpoints and `fieldname` on others; accept
      // either, mirroring the canonical mapper (2.3 / G3).
      const name = toNullableString(field.name) ?? toNullableString(field.fieldname);
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

/**
 * Re-applies EVERY filter locally even though each fanned-out native query is
 * already fully constrained. This re-check is intentional defense-in-depth
 * (5.4 / C4): it guards against a backend that ignores or loosely honours a
 * scalar filter, and the cost is negligible (records are already in memory,
 * bounded by MAX_SEARCH_SCAN). Do NOT remove it as a "redundant" optimisation.
 */
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
        return compareNullableValues(left.product_id, right.product_id, compareNumbers, sortOrder);
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

/**
 * Optional client-identity enrichment (opt-in via include_client_details).
 * Each read consumes a rate-limit token (1.1). Because this enrichment is
 * OPTIONAL, it degrades gracefully (1.4): a `RateLimitError` mid-enrichment
 * stops the loop and returns whatever was gathered with `partial: true` — it
 * NEVER aborts the search. Client ids are de-duplicated before fetching.
 */
async function fetchClientDetails(
  whmcsClient: WhmcsClient,
  rl: RateLimiter,
  clientIds: number[]
): Promise<{ details: Map<number, BasicClientDetails>; warnings: string[]; partial: boolean }> {
  const details = new Map<number, BasicClientDetails>();
  const warnings: string[] = [];
  let partial = false;

  for (const clientId of uniqueValues(clientIds) ?? []) {
    try {
      const response = await readWithRateLimit<WhmcsClientDetailsResponse>(
        whmcsClient,
        rl,
        'GetClientsDetails',
        { clientid: clientId }
      );

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
      // Rate limit during OPTIONAL enrichment ⇒ degrade, do not abort (1.4).
      if (error instanceof RateLimitError) {
        warnings.push(
          'Client enrichment stopped early: rate limit reached; some services are returned without client details.'
        );
        partial = true;
        break;
      }
      if (error instanceof WhmcsBusinessError) {
        warnings.push(`Client details could not be enriched for clientid ${clientId}.`);
        continue;
      }
      throw error;
    }
  }

  return { details, warnings, partial };
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

/**
 * Reduce a group to an ids/counts-only summary safe for governed output.
 * Strips the nested service rows AND every business DISPLAY label
 * (product_name/group_name and their translations) so nothing beyond
 * identifiers (business.identifier) and counts crosses the boundary — these
 * summaries can therefore be emitted directly as governed `items` without
 * per-row projection.
 */
function groupSummaryIdsOnly(group: ClientGroup | ProductGroup): Record<string, unknown> {
  const { services: _services, ...summary } = group as unknown as Record<string, unknown> & {
    services: unknown;
  };
  delete (summary as { client?: unknown }).client;
  delete (summary as { product_name?: unknown }).product_name;
  delete (summary as { translated_product_name?: unknown }).translated_product_name;
  delete (summary as { group_name?: unknown }).group_name;
  delete (summary as { translated_group_name?: unknown }).translated_group_name;
  return summary;
}

/** Legacy group item without the nested service rows (include_group_services=false). */
function stripGroupServices(group: ClientGroup | ProductGroup): Record<string, unknown> {
  const { services: _services, ...rest } = group as unknown as Record<string, unknown> & {
    services: unknown;
  };
  return rest;
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
      const authToken = typeof rawParams.auth_token === 'string' ? rawParams.auth_token : undefined;

      const authErr = ensureToolAuth(rawParams);
      if (authErr) return authErr;

      log.logToolCall('search_services', rawParams, false);
      if (!rl.tryConsume()) throw new RateLimitError();

      const params = searchServicesSchema.parse(rawParams);
      const requestedContract = params.contract;
      const nativeFilterPresent = hasNativePrimaryFilter(params);

      // Local-only filters (statuses/domain_contains) do NOT narrow the WHMCS
      // query, so they must not satisfy the broad-search guard (1.3 / E3).
      if (!nativeFilterPresent && !params.allow_broad_search) {
        return toolError(
          'At least one native filter (serviceids, product_ids, clientids, domains, or usernames) is required unless allow_broad_search=true. Local-only filters (statuses, domain_contains) do not narrow the WHMCS query.'
        );
      }

      const scopeResolution = resolveScopedClientIds(params);
      if (scopeResolution.error) return scopeResolution.error;

      const scopedClientIds = scopeResolution.clientids;

      // Preflight the fan-out BEFORE materializing the cartesian product so an
      // oversized request can never blow up memory (1.2 / E2). The count is the
      // product of the de-duplicated native cardinalities.
      const combinationCount = nativeCombinationCount(params, scopedClientIds);
      if (combinationCount > MAX_QUERY_COMBINATIONS) {
        // Audit event (5.3): an agent tried to brute-force the API.
        log.warn('search_services: fan-out rejected', {
          combinationCount,
          max: MAX_QUERY_COMBINATIONS,
          view: params.view,
        });
        return toolError(
          `Filter fan-out produces ${combinationCount} WHMCS queries (max ${MAX_QUERY_COMBINATIONS}). Narrow the array filters or split the search.`
        );
      }

      const queries = buildNativeQueries(params, scopedClientIds);

      const warnings: string[] = [];
      if (!nativeFilterPresent && params.allow_broad_search) {
        warnings.push('Broad search executed because allow_broad_search=true.');
        // Audit event (5.3): a global scan was authorised.
        log.info('search_services: broad search executed', { view: params.view });
      }
      if (hasLocalFilter(params)) {
        warnings.push('Local filters were applied after fetching WHMCS records.');
      }

      const governed = governanceEnabled();
      if (governed && params.include_client_details) {
        warnings.push(
          'include_client_details is ignored when governance is enabled; use get_client_details for governed client data.'
        );
      }
      // Data-minimisation gate (5.1): when MCP_ALLOW_CLIENT_ENRICHMENT is false,
      // inline client enrichment is suppressed in the non-governed path. The
      // config resolves unset ⇒ true (preserves current admin behaviour).
      const enrichmentAllowed = config.MCP_ALLOW_CLIENT_ENRICHMENT;
      if (!governed && params.include_client_details && !enrichmentAllowed) {
        warnings.push(
          'include_client_details is ignored because MCP_ALLOW_CLIENT_ENRICHMENT is disabled.'
        );
      }

      const recordsByServiceId = new Map<number, WhmcsServiceRecord>();
      let scanned = 0;
      let completeScan = true;

      // Sequential by design (5.5 / C3): each query drains its own pages and
      // every page consumes a rate-limit token, so the WHMCS API is never hit
      // by a parallel burst. Bounded parallelism is a deliberate non-goal here —
      // it would reintroduce the rate-limit pressure the per-page gate removes.
      for (const query of queries) {
        const budget = MAX_SEARCH_SCAN - scanned;
        if (budget <= 0) {
          completeScan = false;
          break;
        }

        const { records: pageRecords, exhausted } = await fetchProductsForQuery(
          whmcs,
          rl,
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
        // Audit event (5.3): results may be partial — operators can tune limits.
        log.warn('search_services: partial scan', {
          view: params.view,
          scanned,
          scan_limit: MAX_SEARCH_SCAN,
          query_count: queries.length,
        });
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
      // View-tagged cursor: a cursor minted for another view resets to page 0
      // and warns instead of silently mis-paging across views (3.3 / P3).
      const cursorResult =
        typeof params.cursor === 'string'
          ? decodeSearchServicesCursor(params.cursor, params.view)
          : { offset: params.offset, viewMismatch: false };
      const effectiveOffset = cursorResult.offset;
      if (cursorResult.viewMismatch) {
        warnings.push(
          'Pagination cursor was issued for a different view; it was ignored and the first page is returned.'
        );
      }

      const rawByServiceId = (page: NormalizedService[]): WhmcsServiceRecord[] =>
        page
          .map((service) => recordsByServiceId.get(service.serviceid))
          .filter((record): record is WhmcsServiceRecord => record !== undefined);

      // Governed list projection bound to this call's consumer/contract. Used
      // for the bespoke governed group path (2.2): resolve the consumer once
      // (rows=[]) for the deny gate, then project each group's services.
      const projectRows = (rows: readonly WhmcsServiceRecord[]) =>
        governListProjection({
          rows,
          mapItem: mapToCanonicalService,
          authToken,
          env: getProjectionEnv(),
          registry: getConsumerRegistry(),
          allowAnon: config.MCP_ALLOW_ANON_LLM,
          requestedContract,
        });

      const govError = (r: { error?: string; status?: string }): ToolResponse => {
        const payload = { isError: true, error: r.error, status: r.status };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
          structuredContent: payload,
          isError: true,
        };
      };

      const baseEnvelope = (unitTotal: number, count: number) => {
        const hasMore = effectiveOffset + count < unitTotal;
        const nextCursor =
          hasMore && count === params.limit
            ? encodeSearchServicesCursor(effectiveOffset + count, params.view)
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
        let clientDetailsPartial = false;

        if (!governed && params.include_client_details && enrichmentAllowed && page.length > 0) {
          const enrichment = await fetchClientDetails(
            whmcs,
            rl,
            page.map((service) => service.clientid)
          );
          warnings.push(...enrichment.warnings);
          clientDetailsPartial = enrichment.partial;
          if (enrichment.partial) {
            // Audit event (5.3): enrichment degraded under rate-limit pressure.
            log.warn('search_services: client enrichment degraded', { view: params.view });
          }
          items = attachClientDetails(page, enrichment.details);
        }

        const envelope = {
          ...baseEnvelope(totalMatched, page.length),
          ...(clientDetailsPartial ? { client_details_partial: true } : {}),
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

      let groupClientDetailsPartial = false;
      if (
        !governed &&
        params.include_client_details &&
        enrichmentAllowed &&
        pagedGroups.length > 0
      ) {
        const clientIds = pagedGroups.flatMap((group) =>
          'clientid' in group ? [group.clientid] : group.clientids
        );
        const enrichment = await fetchClientDetails(whmcs, rl, clientIds);
        warnings.push(...enrichment.warnings);
        groupClientDetailsPartial = enrichment.partial;
        if (enrichment.partial) {
          // Audit event (5.3): enrichment degraded under rate-limit pressure.
          log.warn('search_services: client enrichment degraded', { view: params.view });
        }

        for (const group of pagedGroups) {
          if ('clientid' in group) {
            const client = enrichment.details.get(group.clientid);
            if (client) group.client = client;
          }
          group.services = attachClientDetails(group.services, enrichment.details);
        }
      }

      const groupCountKey = params.view === 'clients' ? 'total_clients' : 'total_products';
      // `count`/`total` count GROUPS in group views; `items` are groups too, so
      // count === items.length holds on BOTH paths (2.2 / G2).
      const envelope = {
        ...baseEnvelope(groups.length, pagedGroups.length),
        [groupCountKey]: groups.length,
        ...(groupClientDetailsPartial ? { client_details_partial: true } : {}),
        ...(finalizeWarnings(warnings) ? { warnings: finalizeWarnings(warnings) } : {}),
      };

      log.logToolResult('search_services', true, Date.now() - t0);

      // Legacy items = groups. Nested service rows only under
      // include_group_services (default false) to keep the payload small (3.1).
      const legacyItems = params.include_group_services
        ? pagedGroups
        : pagedGroups.map(stripGroupServices);
      const legacy = { items: legacyItems, ...envelope };

      return applyGovernanceOrLegacy({
        enabled: governed,
        legacy,
        govern: () => {
          // Bespoke governed group path (2.2 / V5): governedListResult always
          // projects rows→items and has no "group" entity, so we build it here.
          // Resolve the consumer ONCE (rows=[]) for the deny gate, then emit the
          // ids/counts-only summaries as `items` (no per-row projection needed —
          // they are business.identifier/counts). Nested services, when asked,
          // are projected per group so each still crosses the boundary.
          const gate = projectRows([]);
          if (!gate.ok) return govError(gate);

          const items = pagedGroups.map((group) => {
            const summary = groupSummaryIdsOnly(group);
            if (params.include_group_services) {
              const projected = projectRows(rawByServiceId(group.services));
              summary.services = projected.ok ? projected.items : [];
            }
            return summary;
          });

          const payload = {
            consumer: gate.consumer_id,
            contract: gate.contract,
            items,
            ...envelope,
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
            structuredContent: payload,
          };
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
      description: `Multi-filter discovery/lookup over WHMCS client services/products via GetClientsProducts (read-only). Prefer the cheaper tool when you can: use list_client_services when you already know the clientid, and list_client_invoices for billing. Reach for search_services for cross-client discovery — reverse lookup by domain/username, batch lookups by serviceids/product_ids, or grouping by client/product. Pass arrays such as product_ids, clientids, serviceids, domains, or usernames to search multiple values in one call; statuses and domain_contains filter locally. view='services' pages service rows; view='clients'/'products' page GROUPS (ids + counts), adding nested service rows only when include_group_services=true. Page with limit/offset or the opaque nextCursor (cursor is view-specific). Note: pagination is stateless — each page re-runs the fan-out and local scan, so prefer a larger limit over many small pages. Version: ${TOOL_VERSION}`,
      inputSchema: { ...searchServicesSchema.shape, ...AUTH_SHAPE },
      outputSchema: LIST_TOOL_OUTPUT_SCHEMA,
      annotations: { ...READ_ONLY_ANNOTATIONS },
    },
    handler
  );
}
