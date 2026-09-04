/**
 * search_services — multi-filter GetClientsProducts discovery tool.
 *
 * Covers: schema validation, broad-search guard, normalization (credential
 * hiding, opt-in sections), the three views (services/clients/products),
 * serviceid dedup across fanned-out queries, local status/domain filters,
 * client-mode scoping, fan-out cap, and cursor pagination.
 *
 * Synthetic fixtures only; `whmcs.read` is mocked. Governance OFF (the real
 * pipeline reads the mocked config).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfig = vi.hoisted(() => ({
  MCP_MAX_PAGE_SIZE: 100,
  MCP_ACCESS_MODE: 'admin',
  MCP_ALLOWED_CLIENT_IDS: [] as number[],
  MCP_AUTH_TOKEN: undefined as string | undefined,
  MCP_GOVERNANCE_ENABLED: false,
  MCP_ALLOW_ANON_LLM: true,
  MCP_ENV: 'production' as string,
  MCP_ALLOW_CLIENT_ENRICHMENT: true,
}));

vi.mock('../../src/config.js', () => ({
  config: mockConfig,
  isToolAllowed: () => true,
}));

import { WhmcsBusinessError } from '../../src/whmcs/WhmcsClient.js';
import {
  registerSearchServicesTool,
  searchServicesSchema,
} from '../../src/tools/searchServicesTool.js';
import { encodeCursor } from '../../src/tools/listTools.js';
import { hashToken } from '../../src/governance/consumers.js';
import { __resetRegistryCacheForTests } from '../../src/governance/pipeline.js';

type FixtureRecord = Record<string, unknown>;

const SERVICE_FIXTURES: FixtureRecord[] = [
  {
    id: '101',
    qty: '1',
    clientid: '1',
    orderid: '5001',
    ordernumber: 'ORD-5001',
    pid: '42',
    regdate: '2025-01-15',
    name: 'Antivirus Basic',
    translated_name: 'Antivirus Basic',
    groupname: 'Security',
    translated_groupname: 'Security',
    domain: 'example.com',
    serverid: '9',
    servername: 'srv-alpha',
    serverip: '10.0.0.9',
    serverhostname: 'alpha.example.net',
    firstpaymentamount: '10.00',
    recurringamount: '5.00',
    paymentmethod: 'banktransfer',
    paymentmethodname: 'Bank Transfer',
    billingcycle: 'Monthly',
    nextduedate: '2026-06-01',
    status: 'Active',
    username: 'alice',
    password: 'masked-value',
    ns1: 'ns1.example.com',
    ns2: 'ns2.example.com',
    diskusage: '5 GB',
    disklimit: '10 GB',
    bwusage: '100 GB',
    bwlimit: '500 GB',
    lastupdate: '2026-05-01 10:00:00',
    customfields: { customfield: [{ id: '1', name: 'Seats', value: '25' }] },
    configoptions: {
      configoption: [{ id: '7', option: 'License Tier', type: 'dropdown', value: 'Business' }],
    },
  },
  {
    id: '102',
    qty: '2',
    clientid: '1',
    orderid: '5002',
    ordernumber: 'ORD-5002',
    pid: '43',
    regdate: '0000-00-00',
    name: 'Antivirus Pro',
    domain: 'shop.example.com',
    suspensionreason: 'Manual hold',
    recurringamount: '12.00',
    billingcycle: 'Monthly',
    nextduedate: '0000-00-00',
    status: 'Suspended',
    username: 'bob',
    password: 'masked-value',
  },
  {
    id: '103',
    clientid: '2',
    pid: '42',
    name: 'Antivirus Basic',
    domain: 'other.test',
    recurringamount: '5.00',
    billingcycle: 'Monthly',
    nextduedate: '2026-07-01',
    status: 'Active',
    username: 'carol',
    password: 'masked-value',
  },
];

const CLIENT_FIXTURES: Record<number, FixtureRecord> = {
  1: {
    id: '1',
    firstname: 'Alice',
    lastname: 'Doe',
    fullname: 'Alice Doe',
    email: 'alice@example.com',
    companyname: 'ACME',
    status: 'Active',
  },
  2: {
    id: '2',
    firstname: 'Carol',
    lastname: 'Roe',
    fullname: 'Carol Roe',
    email: 'carol@example.com',
    status: 'Active',
  },
};

function recordMatches(record: FixtureRecord, params: Record<string, unknown>): boolean {
  if (params.serviceid !== undefined && Number(record.id) !== Number(params.serviceid)) {
    return false;
  }
  if (params.pid !== undefined && Number(record.pid) !== Number(params.pid)) return false;
  if (params.clientid !== undefined && Number(record.clientid) !== Number(params.clientid)) {
    return false;
  }
  if (params.domain !== undefined && record.domain !== params.domain) return false;
  if (params.username2 !== undefined && record.username !== params.username2) return false;
  return true;
}

function buildProductsResponse(records: FixtureRecord[], params: Record<string, unknown>) {
  const matched = records.filter((record) => recordMatches(record, params));
  const start = Number(params.limitstart ?? 0);
  const num = Number(params.limitnum ?? 100);
  const page = matched.slice(start, start + num);
  return {
    result: 'success',
    totalresults: matched.length,
    numreturned: page.length,
    startnumber: start,
    products: { product: page },
  };
}

function createWhmcsReadMock(
  records: FixtureRecord[] = SERVICE_FIXTURES,
  clientFixtures: Record<number, FixtureRecord> = CLIENT_FIXTURES
) {
  return vi.fn(async (action: string, params: Record<string, unknown>) => {
    if (action === 'GetClientsProducts') {
      return buildProductsResponse(records, params);
    }
    if (action === 'GetClientsDetails') {
      const client = clientFixtures[Number(params.clientid)];
      if (!client) throw new WhmcsBusinessError('Client not found');
      return client;
    }
    throw new Error(`Unexpected action: ${action}`);
  });
}

function harness(options?: {
  readMock?: ReturnType<typeof vi.fn>;
  rl?: { tryConsume: () => boolean };
}) {
  const handlers: Record<string, any> = {};
  const server = {
    registerTool: (name: string, _cfg: unknown, cb: any) => {
      handlers[name] = cb;
    },
  };
  const childLogger: any = {
    logToolCall: vi.fn(),
    logToolResult: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => childLogger,
  };
  const logger: any = { child: () => childLogger };
  const rateLimiter: any = options?.rl ?? { tryConsume: () => true };
  const read = options?.readMock ?? createWhmcsReadMock();

  registerSearchServicesTool(server as any, { read } as any, logger, rateLimiter);
  return { handler: handlers.search_services, read, log: childLogger };
}

const GOV_TOKEN = 'search-consumer-token';

function enableGovernance(): void {
  mockConfig.MCP_GOVERNANCE_ENABLED = true;
  mockConfig.MCP_ALLOW_ANON_LLM = true;
  mockConfig.MCP_ENV = 'production';
  process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([
    {
      id: 'search_app',
      token_sha256: hashToken(GOV_TOKEN),
      defaultContract: 'billing_reconciliation',
      allowedContracts: ['billing_reconciliation'],
      writeCapability: 'false',
    },
  ]);
  __resetRegistryCacheForTests();
}

function disableGovernance(): void {
  mockConfig.MCP_GOVERNANCE_ENABLED = false;
  delete process.env.MCP_CONSUMER_REGISTRY;
  __resetRegistryCacheForTests();
}

async function invoke(handler: any, params: Record<string, unknown>) {
  const response = await handler(params);
  return JSON.parse(response.content[0].text) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.MCP_ACCESS_MODE = 'admin';
  mockConfig.MCP_ALLOWED_CLIENT_IDS = [];
  mockConfig.MCP_AUTH_TOKEN = undefined;
  mockConfig.MCP_GOVERNANCE_ENABLED = false;
  mockConfig.MCP_ALLOW_ANON_LLM = true;
  mockConfig.MCP_ENV = 'production';
  mockConfig.MCP_ALLOW_CLIENT_ENRICHMENT = true;
  disableGovernance();
});

describe('search_services — schema', () => {
  it('accepts valid array filters', () => {
    const result = searchServicesSchema.safeParse({
      serviceids: [101, 102],
      product_ids: [42, 43],
      clientids: [1, 2],
      domains: ['example.com'],
      usernames: ['alice'],
      statuses: ['Active'],
      domain_contains: 'example',
      view: 'clients',
      include_client_details: true,
      limit: 50,
      offset: 0,
    });
    expect(result.success).toBe(true);
  });

  it('rejects limit values above MCP_MAX_PAGE_SIZE', () => {
    const result = searchServicesSchema.safeParse({ product_ids: [42], limit: 101 });
    expect(result.success).toBe(false);
  });
});

describe('search_services — services view', () => {
  it('returns an error when no filters are provided without allow_broad_search', async () => {
    const { handler } = harness();
    const result = await invoke(handler, { view: 'services' });
    expect(result.isError).toBe(true);
    expect(String(result.error)).toContain('At least one native filter');
    // Error responses carry no structuredContent (Etapa 2.4 / E5).
    const raw = await handler({ view: 'services' });
    expect(raw.structuredContent).toBeUndefined();
    expect(raw.isError).toBe(true);
  });

  it('local-only filters do NOT satisfy the broad-search guard (Etapa 1.3 / E3)', async () => {
    const { handler } = harness();
    const result = await invoke(handler, {
      statuses: ['Active'],
      domain_contains: 'example',
      view: 'services',
    });
    expect(result.isError).toBe(true);
    expect(String(result.error)).toContain('Local-only filters');
  });

  it('returns normalized services and hides credentials', async () => {
    const { handler } = harness();
    const result = await invoke(handler, {
      serviceids: [101, 102],
      view: 'services',
      limit: 10,
      offset: 0,
    });

    expect(result.view).toBe('services');
    expect(result.total).toBe(2);
    expect(result.total_matched).toBe(2);
    expect(result.count).toBe(2);

    const items = result.items as Record<string, unknown>[];
    expect(items[0]).toMatchObject({
      serviceid: 101,
      clientid: 1,
      product_id: 42,
      registration_date: '2025-01-15',
      product_name: 'Antivirus Basic',
      domain: 'example.com',
      status: 'Active',
      next_due_date: '2026-06-01',
      server: { id: 9, name: 'srv-alpha', ip: '10.0.0.9', hostname: 'alpha.example.net' },
      nameservers: { ns1: 'ns1.example.com', ns2: 'ns2.example.com' },
    });
    expect(items[0]).not.toHaveProperty('password');
    expect(items[0]).not.toHaveProperty('username');
    expect(items[0]).not.toHaveProperty('custom_fields');
    expect(items[0]).not.toHaveProperty('config_options');
    expect(items[0]).not.toHaveProperty('usage');
    expect(items[1]).toMatchObject({
      serviceid: 102,
      registration_date: null,
      next_due_date: null,
    });
  });

  it('deduplicates overlapping services by serviceid', async () => {
    const readMock = vi.fn(async (action: string, params: Record<string, unknown>) => {
      if (action === 'GetClientsProducts') {
        // Both pid=42 and pid=43 return the SAME service record.
        return {
          result: 'success',
          totalresults: 1,
          numreturned: 1,
          startnumber: Number(params.limitstart ?? 0),
          products: { product: [{ ...SERVICE_FIXTURES[0], pid: params.pid }] },
        };
      }
      throw new Error(`Unexpected action: ${action}`);
    });
    const { handler } = harness({ readMock });

    const result = await invoke(handler, {
      product_ids: [42, 43],
      view: 'services',
      limit: 10,
    });
    expect(result.total_matched).toBe(1);
    expect(result.count).toBe(1);
    expect(result.items).toMatchObject([{ serviceid: 101 }]);
  });

  it('applies local status and domain_contains filters after fetching', async () => {
    const { handler } = harness();
    const result = await invoke(handler, {
      statuses: ['Active'],
      domain_contains: 'example',
      view: 'services',
      limit: 10,
      // Local-only filters require an explicit broad-search opt-in (Etapa 1.3).
      allow_broad_search: true,
    });
    expect(result.total_matched).toBe(1);
    expect(result.items).toMatchObject([{ serviceid: 101 }]);
    expect(result.warnings).toContain('Local filters were applied after fetching WHMCS records.');
  });

  it('enriches client identity when include_client_details=true', async () => {
    const { handler } = harness();
    const result = await invoke(handler, {
      serviceids: [101],
      view: 'services',
      include_client_details: true,
      limit: 10,
    });
    const items = result.items as Record<string, unknown>[];
    expect(items[0].client).toMatchObject({
      clientid: 1,
      fullname: 'Alice Doe',
      email: 'alice@example.com',
      companyname: 'ACME',
    });
  });

  it('rejects fan-outs above the cap BEFORE materializing or reading (1.2 / E2)', async () => {
    const { handler, read } = harness();
    const result = await invoke(handler, {
      serviceids: Array.from({ length: 20 }, (_, i) => i + 1),
      domains: Array.from({ length: 20 }, (_, i) => `d${String(i)}.test`),
      view: 'services',
    });
    expect(result.isError).toBe(true);
    expect(String(result.error)).toContain('Narrow the array filters');
    // 20 × 20 = 400 > 100: rejected by the preflight, so no WHMCS read fires
    // and the cartesian product is never built.
    expect(read).not.toHaveBeenCalled();
  });
});

describe('search_services — group views', () => {
  it('groups results by clientid in clients view', async () => {
    const { handler } = harness();
    const result = await invoke(handler, {
      product_ids: [42, 43],
      view: 'clients',
      limit: 10,
      offset: 0,
    });

    expect(result.view).toBe('clients');
    expect(result.total_matched).toBe(3);
    expect(result.total).toBe(2);
    expect(result.total_clients).toBe(2);
    expect(result.count).toBe(2);

    const items = result.items as Record<string, unknown>[];
    expect(items[0]).toMatchObject({
      clientid: 1,
      service_count: 2,
      product_count: 2,
      product_ids: [42, 43],
      serviceids: [101, 102],
    });
    expect(items[1]).toMatchObject({
      clientid: 2,
      service_count: 1,
      product_count: 1,
      product_ids: [42],
      serviceids: [103],
    });
  });

  it('groups results by product id in products view', async () => {
    const { handler } = harness();
    const result = await invoke(handler, {
      clientids: [1, 2],
      view: 'products',
      limit: 10,
      offset: 0,
    });

    expect(result.view).toBe('products');
    expect(result.total_matched).toBe(3);
    expect(result.total).toBe(2);
    expect(result.total_products).toBe(2);

    const items = result.items as Record<string, unknown>[];
    expect(items[0]).toMatchObject({
      product_id: 42,
      service_count: 2,
      client_count: 2,
      clientids: [1, 2],
      serviceids: [101, 103],
    });
    expect(items[1]).toMatchObject({
      product_id: 43,
      service_count: 1,
      client_count: 1,
      clientids: [1],
      serviceids: [102],
    });
  });
});

describe('search_services — client-mode scoping', () => {
  it('restricts results to MCP_ALLOWED_CLIENT_IDS when no clientids requested', async () => {
    mockConfig.MCP_ACCESS_MODE = 'client';
    mockConfig.MCP_ALLOWED_CLIENT_IDS = [1];

    const { handler } = harness();
    const result = await invoke(handler, {
      product_ids: [42, 43],
      view: 'services',
      limit: 10,
    });

    const items = result.items as Record<string, unknown>[];
    expect(result.total_matched).toBe(2);
    expect(items.every((service) => service.clientid === 1)).toBe(true);
    expect((result.filters_applied as Record<string, unknown>).client_scope_enforced).toBe(true);
  });

  it('denies requested clientids outside the allowlist', async () => {
    mockConfig.MCP_ACCESS_MODE = 'client';
    mockConfig.MCP_ALLOWED_CLIENT_IDS = [1];

    const { handler } = harness();
    const result = await invoke(handler, {
      clientids: [2],
      view: 'services',
      limit: 10,
    });
    expect(result.isError).toBe(true);
    expect(String(result.error)).toContain('client scope mismatch');
  });

  it('requires MCP_ALLOWED_CLIENT_IDS to be configured in client mode', async () => {
    mockConfig.MCP_ACCESS_MODE = 'client';
    mockConfig.MCP_ALLOWED_CLIENT_IDS = [];

    const { handler } = harness();
    const result = await invoke(handler, { product_ids: [42], view: 'services' });
    expect(result.isError).toBe(true);
    expect(String(result.error)).toContain('MCP_ALLOWED_CLIENT_IDS');
  });
});

describe('search_services — cursor pagination', () => {
  it('full page emits nextCursor; following it advances; last page omits it', async () => {
    const { handler } = harness();

    const r1 = await invoke(handler, { clientids: [1, 2], view: 'services', limit: 2, offset: 0 });
    expect((r1.items as unknown[]).length).toBe(2);
    expect(typeof r1.nextCursor).toBe('string');

    const r2 = await invoke(handler, {
      clientids: [1, 2],
      view: 'services',
      limit: 2,
      cursor: r1.nextCursor,
    });
    expect(r2.offset).toBe(2);
    expect((r2.items as Record<string, unknown>[]).map((s) => s.serviceid)).toEqual([103]);
    expect(r2.nextCursor).toBeUndefined();
  });

  it('garbage cursor → offset 0', async () => {
    const { handler } = harness();
    const result = await invoke(handler, {
      clientids: [1, 2],
      view: 'services',
      limit: 2,
      cursor: encodeCursor(0).slice(0, 3) + '!!',
    });
    expect(result.offset).toBe(0);
  });

  it('a cursor minted for one view is rejected (reset+warn) in another view (3.3 / P3)', async () => {
    const { handler } = harness();
    const r1 = await invoke(handler, { clientids: [1, 2], view: 'services', limit: 2 });
    expect(typeof r1.nextCursor).toBe('string');

    // Reuse the services-view cursor under view='clients'.
    const r2 = await invoke(handler, {
      clientids: [1, 2],
      view: 'clients',
      limit: 2,
      cursor: r1.nextCursor,
    });
    expect(r2.offset).toBe(0);
    expect(r2.warnings as string[]).toEqual(
      expect.arrayContaining([expect.stringContaining('different view')])
    );
  });
});

describe('search_services — rate limiting & resilient enrichment (1.1 / 1.4)', () => {
  it('consumes a token per WHMCS page; exhausting it surfaces a rate-limit error with no structuredContent', async () => {
    // Entry gate consumes the 1st token (true); the first product-page read
    // consumes the 2nd (false) → RateLimitError.
    let calls = 0;
    const rl = {
      tryConsume: () => {
        calls += 1;
        return calls <= 1;
      },
    };
    const { handler } = harness({ rl });
    const res = await handler({ serviceids: [101], view: 'services', limit: 10 });
    const parsed = JSON.parse(res.content[0].text) as Record<string, unknown>;
    expect(parsed.isError).toBe(true);
    // Error path emits no structuredContent (2.4 / E5).
    expect(res.structuredContent).toBeUndefined();
  });

  it('optional enrichment degrades gracefully when the token runs out mid-way', async () => {
    // Allow entry (1) + one product page (2); deny the GetClientsDetails read.
    let calls = 0;
    const rl = {
      tryConsume: () => {
        calls += 1;
        return calls <= 2;
      },
    };
    const { handler } = harness({ rl });
    const result = await invoke(handler, {
      serviceids: [101],
      view: 'services',
      include_client_details: true,
      limit: 10,
    });
    // Search still succeeds with the service, just without client details.
    expect(result.isError).toBeFalsy();
    expect((result.items as Record<string, unknown>[])[0]).toMatchObject({ serviceid: 101 });
    expect((result.items as Record<string, unknown>[])[0]).not.toHaveProperty('client');
    expect(result.client_details_partial).toBe(true);
    expect(result.warnings as string[]).toEqual(
      expect.arrayContaining([expect.stringContaining('rate limit reached')])
    );
  });
});

describe('search_services — multi-page scan, sort, flags', () => {
  it('pages through multiple WHMCS pages and reports a complete scan', async () => {
    const many: FixtureRecord[] = Array.from({ length: 250 }, (_, i) => ({
      id: String(1000 + i),
      clientid: '1',
      pid: '42',
      name: 'Bulk',
      domain: `host${String(i)}.test`,
      recurringamount: '5.00',
      billingcycle: 'Monthly',
      nextduedate: '2026-07-01',
      status: 'Active',
    }));
    const read = createWhmcsReadMock(many);
    const { handler } = harness({ readMock: read });

    const result = await invoke(handler, { clientids: [1], view: 'services', limit: 100 });
    expect(result.total_matched).toBe(250);
    expect(result.complete_scan).toBe(true);
    // 250 records at page size 100 ⇒ 3 product reads (100 + 100 + 50).
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('honours sort_by/sort_order', async () => {
    const { handler } = harness();
    const result = await invoke(handler, {
      clientids: [1, 2],
      view: 'services',
      sort_by: 'serviceid',
      sort_order: 'desc',
      limit: 10,
    });
    expect((result.items as Record<string, unknown>[]).map((s) => s.serviceid)).toEqual([
      103, 102, 101,
    ]);
  });

  it('opt-in sections (usage/custom_fields/config_options) and name/fieldname fallback (2.3)', async () => {
    const { handler } = harness();
    const result = await invoke(handler, {
      serviceids: [101],
      view: 'services',
      include_usage: true,
      include_custom_fields: true,
      include_config_options: true,
      limit: 10,
    });
    const item = (result.items as Record<string, unknown>[])[0];
    expect(item.usage).toMatchObject({ disk_usage: '5 GB', bandwidth_limit: '500 GB' });
    expect(item.custom_fields).toMatchObject([{ id: 1, name: 'Seats', value: '25' }]);
    expect(item.config_options).toMatchObject([{ id: 7, option: 'License Tier' }]);
  });
});

describe('search_services — error contract (2.4 / E5)', () => {
  it('a WHMCS business error returns content+isError with no structuredContent', async () => {
    const readMock = vi.fn(async () => {
      throw new WhmcsBusinessError('boom');
    });
    const { handler } = harness({ readMock });
    const res = await handler({ serviceids: [101], view: 'services' });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
    const parsed = JSON.parse(res.content[0].text) as Record<string, unknown>;
    expect(parsed.error).toBe('boom');
  });
});

describe('search_services — governed path (2.1 / 2.2 / 3.1)', () => {
  it('services view: items are projected, credentials dropped, count===items.length', async () => {
    enableGovernance();
    const { handler } = harness();
    const res = await handler({ serviceids: [101], view: 'services', auth_token: GOV_TOKEN });
    expect(res.structuredContent).toBeDefined();
    const sc = res.structuredContent as Record<string, any>;
    expect(sc.contract).toBe('billing_reconciliation');
    expect(sc.items).toHaveLength(1);
    expect(sc.items[0]).toMatchObject({ serviceId: 101, clientId: 1 });
    expect(sc.count).toBe(sc.items.length);
    // username/password never cross the boundary.
    expect(JSON.stringify(res)).not.toContain('masked-value');
    expect(JSON.stringify(res)).not.toContain('alice');
  });

  it('clients view: governed items are ids/counts-only groups, no labels, count===items.length', async () => {
    enableGovernance();
    const { handler } = harness();
    const res = await handler({ product_ids: [42, 43], view: 'clients', auth_token: GOV_TOKEN });
    const sc = res.structuredContent as Record<string, any>;
    expect(sc.count).toBe(sc.items.length);
    expect(sc.items[0]).toMatchObject({ clientid: 1, serviceids: expect.any(Array) });
    // ids/counts only: no nested services (default) and no display labels.
    expect(sc.items[0]).not.toHaveProperty('services');
    expect(sc.items[0]).not.toHaveProperty('product_name');
    expect(JSON.stringify(res)).not.toContain('masked-value');
  });

  it('products view with include_group_services nests PROJECTED services per group', async () => {
    enableGovernance();
    const { handler } = harness();
    const res = await handler({
      clientids: [1, 2],
      view: 'products',
      include_group_services: true,
      auth_token: GOV_TOKEN,
    });
    const sc = res.structuredContent as Record<string, any>;
    expect(sc.count).toBe(sc.items.length);
    const group = sc.items[0];
    expect(Array.isArray(group.services)).toBe(true);
    expect(group.services[0]).toMatchObject({ serviceId: expect.any(Number) });
    // No display labels leak via the group summary; no credentials anywhere.
    expect(group).not.toHaveProperty('product_name');
    expect(JSON.stringify(res)).not.toContain('masked-value');
  });

  it('a denied token leaks no data', async () => {
    enableGovernance();
    const { handler } = harness();
    const res = await handler({ serviceids: [101], view: 'services', auth_token: 'bad-token' });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as Record<string, any>)?.items).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain('masked-value');
    expect(JSON.stringify(res)).not.toContain('alice');
  });

  it('group view: a denied token leaks no group data', async () => {
    enableGovernance();
    const { handler } = harness();
    const res = await handler({ product_ids: [42, 43], view: 'clients', auth_token: 'bad-token' });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as Record<string, any>)?.items).toBeUndefined();
  });
});

describe('search_services — MCP_ALLOW_CLIENT_ENRICHMENT gate (5.1)', () => {
  it('default (enabled) enriches as before', async () => {
    const { handler } = harness();
    const result = await invoke(handler, {
      serviceids: [101],
      view: 'services',
      include_client_details: true,
      limit: 10,
    });
    expect((result.items as Record<string, unknown>[])[0]).toHaveProperty('client');
  });

  it('when disabled, include_client_details is ignored with a warning (no enrichment read)', async () => {
    mockConfig.MCP_ALLOW_CLIENT_ENRICHMENT = false;
    const { handler, read } = harness();
    const result = await invoke(handler, {
      serviceids: [101],
      view: 'services',
      include_client_details: true,
      limit: 10,
    });
    expect((result.items as Record<string, unknown>[])[0]).not.toHaveProperty('client');
    expect(result.warnings as string[]).toEqual(
      expect.arrayContaining([expect.stringContaining('MCP_ALLOW_CLIENT_ENRICHMENT is disabled')])
    );
    // No GetClientsDetails call was made.
    const detailCalls = read.mock.calls.filter((c) => c[0] === 'GetClientsDetails');
    expect(detailCalls).toHaveLength(0);
  });
});

describe('search_services — audit events (5.3)', () => {
  it('emits a warn event when the fan-out is rejected', async () => {
    const { handler, log } = harness();
    await invoke(handler, {
      serviceids: Array.from({ length: 20 }, (_, i) => i + 1),
      domains: Array.from({ length: 20 }, (_, i) => `d${String(i)}.test`),
      view: 'services',
    });
    expect(log.warn).toHaveBeenCalledWith(
      'search_services: fan-out rejected',
      expect.objectContaining({ combinationCount: 400 })
    );
  });

  it('emits an info event when a broad search runs', async () => {
    const { handler, log } = harness();
    await invoke(handler, { view: 'services', allow_broad_search: true, limit: 10 });
    expect(log.info).toHaveBeenCalledWith(
      'search_services: broad search executed',
      expect.objectContaining({ view: 'services' })
    );
  });

  it('emits a warn event when enrichment degrades under rate limit', async () => {
    let calls = 0;
    const rl = {
      tryConsume: () => {
        calls += 1;
        return calls <= 2;
      },
    };
    const { handler, log } = harness({ rl });
    await invoke(handler, {
      serviceids: [101],
      view: 'services',
      include_client_details: true,
      limit: 10,
    });
    expect(log.warn).toHaveBeenCalledWith(
      'search_services: client enrichment degraded',
      expect.objectContaining({ view: 'services' })
    );
  });
});
