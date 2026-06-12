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

function harness(options?: { readMock?: ReturnType<typeof vi.fn> }) {
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
    error: vi.fn(),
    child: () => childLogger,
  };
  const logger: any = { child: () => childLogger };
  const rateLimiter: any = { tryConsume: () => true };
  const read = options?.readMock ?? createWhmcsReadMock();

  registerSearchServicesTool(server as any, { read } as any, logger, rateLimiter);
  return { handler: handlers.search_services, read };
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
    expect(result).toMatchObject({
      isError: true,
      error: 'At least one filter is required unless allow_broad_search=true.',
    });
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

  it('rejects fan-outs above the query combination cap', async () => {
    const { handler } = harness();
    const result = await invoke(handler, {
      serviceids: Array.from({ length: 20 }, (_, i) => i + 1),
      domains: Array.from({ length: 20 }, (_, i) => `d${String(i)}.test`),
      view: 'services',
    });
    expect(result.isError).toBe(true);
    expect(String(result.error)).toContain('Narrow the array filters');
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
});
