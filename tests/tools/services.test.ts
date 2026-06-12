/**
 * Unit tests for service tools
 *
 * Tests: search_services, suspend_service, unsuspend_service, terminate_service
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockConfig, mockIsToolAllowed } = vi.hoisted(() => ({
  mockConfig: {
    WHMCS_API_URL: 'https://test.whmcs.com',
    WHMCS_IDENTIFIER: 'test-id',
    WHMCS_SECRET: 'test-secret',
    MCP_AUTH_TOKEN: undefined,
    MCP_ACCESS_MODE: 'admin',
    MCP_ALLOWED_CLIENT_IDS: [] as number[],
    MCP_MODE: 'full',
    MCP_RATE_LIMIT: 10,
    MCP_DEBUG: false,
    MCP_MAX_PAGE_SIZE: 100,
    MCP_TOOL_ALLOWLIST: [] as string[],
  },
  mockIsToolAllowed: vi.fn(() => true),
}));

vi.mock('../../src/config.js', () => ({
  config: mockConfig,
  isToolAllowed: mockIsToolAllowed,
}));

import { registerServiceTools, searchServicesSchema } from '../../src/tools/services.js';
import { WhmcsBusinessError } from '../../src/whmcs/WhmcsClient.js';

interface ToolResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

type SearchServicesHandler = (params: Record<string, unknown>) => Promise<ToolResponse>;

type FixtureRecord = {
  id: string;
  qty: string;
  clientid: string;
  orderid: string;
  ordernumber: string;
  pid: string;
  regdate: string;
  name: string;
  translated_name?: string;
  groupname?: string;
  translated_groupname?: string;
  domain?: string;
  serverid?: string;
  servername?: string;
  serverip?: string;
  serverhostname?: string;
  suspensionreason?: string;
  firstpaymentamount?: string;
  recurringamount?: string;
  paymentmethod?: string;
  paymentmethodname?: string;
  billingcycle?: string;
  nextduedate?: string;
  status?: string;
  username?: string;
  password?: string;
  ns1?: string;
  ns2?: string;
  diskusage?: string;
  disklimit?: string;
  bwusage?: string;
  bwlimit?: string;
  lastupdate?: string;
  customfields?: { customfield?: Array<{ id: string; name: string; value: string }> };
  configoptions?: { configoption?: Array<{ id: string; option: string; type: string; value: string }> };
};

type ClientFixture = {
  id: string;
  firstname: string;
  lastname: string;
  fullname: string;
  email: string;
  companyname: string;
  status: string;
};

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
    customfields: {
      customfield: [{ id: '1', name: 'Seats', value: '25' }],
    },
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
    translated_name: 'Antivirus Pro',
    groupname: 'Security',
    translated_groupname: 'Security',
    domain: 'shop.example.com',
    serverid: '10',
    servername: 'srv-beta',
    serverip: '10.0.0.10',
    serverhostname: 'beta.example.net',
    suspensionreason: 'Manual hold',
    firstpaymentamount: '20.00',
    recurringamount: '12.00',
    paymentmethod: 'banktransfer',
    paymentmethodname: 'Bank Transfer',
    billingcycle: 'Annually',
    nextduedate: '0000-00-00',
    status: 'Suspended',
    username: 'alice-pro',
    password: 'hidden',
  },
  {
    id: '103',
    qty: '1',
    clientid: '2',
    orderid: '5003',
    ordernumber: 'ORD-5003',
    pid: '42',
    regdate: '2025-03-20',
    name: 'Antivirus Basic',
    translated_name: 'Antivirus Basic',
    groupname: 'Security',
    translated_groupname: 'Security',
    domain: 'other.net',
    serverid: '9',
    servername: 'srv-alpha',
    serverip: '10.0.0.9',
    serverhostname: 'alpha.example.net',
    firstpaymentamount: '10.00',
    recurringamount: '5.00',
    paymentmethod: 'creditcard',
    paymentmethodname: 'Credit Card',
    billingcycle: 'Monthly',
    nextduedate: '2026-07-01',
    status: 'Active',
    username: 'bob',
    password: 'redacted',
  },
];

const CLIENT_FIXTURES: Record<number, ClientFixture> = {
  1: {
    id: '1',
    firstname: 'Alice',
    lastname: 'Admin',
    fullname: 'Alice Admin',
    email: 'alice@example.com',
    companyname: 'Acme Hosting',
    status: 'Active',
  },
  2: {
    id: '2',
    firstname: 'Bob',
    lastname: 'Builder',
    fullname: 'Bob Builder',
    email: 'bob@example.net',
    companyname: 'Builder Ltd',
    status: 'Active',
  },
};

function createLogger() {
  const logger = {
    child: vi.fn(),
    logToolCall: vi.fn(),
    logToolResult: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  };

  logger.child.mockReturnValue(logger);
  return logger;
}

function createRateLimiter() {
  return {
    tryConsume: vi.fn(() => true),
    generateIdempotencyKey: vi.fn(() => 'idempotency-key'),
    getCachedResult: vi.fn(() => undefined),
    cacheResult: vi.fn(),
  };
}

function buildProductsResponse(records: FixtureRecord[], params: Record<string, unknown>) {
  let filtered = records;

  if (params.serviceid !== undefined) {
    filtered = filtered.filter((record) => Number(record.id) === Number(params.serviceid));
  }

  if (params.pid !== undefined) {
    filtered = filtered.filter((record) => Number(record.pid) === Number(params.pid));
  }

  if (params.clientid !== undefined) {
    filtered = filtered.filter((record) => Number(record.clientid) === Number(params.clientid));
  }

  if (params.domain !== undefined) {
    filtered = filtered.filter((record) => (record.domain ?? '').toLowerCase() === String(params.domain).toLowerCase());
  }

  if (params.username2 !== undefined) {
    filtered = filtered.filter((record) => (record.username ?? '') === String(params.username2));
  }

  const limitstart = Number(params.limitstart ?? 0);
  const limitnum = Number(params.limitnum ?? filtered.length);
  const page = filtered.slice(limitstart, limitstart + limitnum);

  return {
    products: { product: page },
    totalresults: filtered.length,
    numreturned: page.length,
    startnumber: limitstart,
  };
}

function createWhmcsReadMock(
  records: FixtureRecord[] = SERVICE_FIXTURES,
  clientFixtures: Record<number, ClientFixture> = CLIENT_FIXTURES
) {
  return vi.fn(async (action: string, params: Record<string, unknown>) => {
    if (action === 'GetClientsProducts') {
      return buildProductsResponse(records, params);
    }

    if (action === 'GetClientsDetails') {
      const clientId = Number(params.clientid);
      const client = clientFixtures[clientId];
      if (!client) {
        throw new WhmcsBusinessError('Client not found');
      }
      return client;
    }

    throw new Error(`Unexpected action: ${action}`);
  });
}

function setupSearchServicesTool(options?: {
  readMock?: ReturnType<typeof vi.fn>;
  records?: FixtureRecord[];
  clientFixtures?: Record<number, ClientFixture>;
}) {
  const handlers = new Map<string, SearchServicesHandler>();
  const server = {
    tool: vi.fn((name: string, _description: string, _schema: unknown, handler: SearchServicesHandler) => {
      handlers.set(name, handler);
    }),
  };

  const logger = createLogger();
  const rateLimiter = createRateLimiter();
  const readMock = options?.readMock ?? createWhmcsReadMock(options?.records, options?.clientFixtures);
  const whmcsClient = {
    read: readMock,
    mutate: vi.fn(),
    isReadOnly: vi.fn(() => false),
  };

  registerServiceTools(server as never, whmcsClient as never, logger as never, rateLimiter as never);

  const handler = handlers.get('search_services');
  if (!handler) {
    throw new Error('search_services was not registered');
  }

  return {
    handler,
    readMock,
  };
}

async function invokeSearchServices(handler: SearchServicesHandler, params: Record<string, unknown>) {
  const response = await handler(params);
  return JSON.parse(response.content[0].text) as Record<string, unknown>;
}

describe('Service Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsToolAllowed.mockReturnValue(true);
    Object.assign(mockConfig, {
      MCP_AUTH_TOKEN: undefined,
      MCP_ACCESS_MODE: 'admin',
      MCP_ALLOWED_CLIENT_IDS: [],
      MCP_MODE: 'full',
      MCP_RATE_LIMIT: 10,
      MCP_DEBUG: false,
      MCP_MAX_PAGE_SIZE: 100,
      MCP_TOOL_ALLOWLIST: [],
    });
  });

  describe('search_services', () => {
    it('should accept valid array filters in the schema', () => {
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
        page_size: 50,
        offset: 0,
      });

      expect(result.success).toBe(true);
    });

    it('should reject page_size values above MCP_MAX_PAGE_SIZE', () => {
      const result = searchServicesSchema.safeParse({
        product_ids: [42],
        page_size: 101,
      });

      expect(result.success).toBe(false);
    });

    it('should return an MCP error when no filters are provided', async () => {
      const { handler } = setupSearchServicesTool();

      const result = await invokeSearchServices(handler, {
        view: 'services',
      });

      expect(result).toEqual({
        isError: true,
        error: 'At least one filter is required unless allow_broad_search=true.',
      });
    });

    it('should return normalized services and hide sensitive fields', async () => {
      const { handler } = setupSearchServicesTool();

      const result = await invokeSearchServices(handler, {
        serviceids: [101, 102],
        view: 'services',
        page_size: 10,
        offset: 0,
      });

      expect(result.view).toBe('services');
      expect(result.total_matched).toBe(2);
      expect(result.returned).toBe(2);

      const services = result.services as Array<Record<string, unknown>>;
      expect(services[0]).toMatchObject({
        serviceid: 101,
        clientid: 1,
        product_id: 42,
        registration_date: '2025-01-15',
        product_name: 'Antivirus Basic',
        domain: 'example.com',
        status: 'Active',
        next_due_date: '2026-06-01',
        server: {
          id: 9,
          name: 'srv-alpha',
          ip: '10.0.0.9',
          hostname: 'alpha.example.net',
        },
        nameservers: {
          ns1: 'ns1.example.com',
          ns2: 'ns2.example.com',
        },
      });
      expect(services[0]).not.toHaveProperty('password');
      expect(services[0]).not.toHaveProperty('username');
      expect(services[0]).not.toHaveProperty('custom_fields');
      expect(services[0]).not.toHaveProperty('config_options');
      expect(services[0]).not.toHaveProperty('usage');
      expect(services[1]).toMatchObject({
        serviceid: 102,
        registration_date: null,
        next_due_date: null,
      });
    });

    it('should group results by clientid in client view', async () => {
      const { handler } = setupSearchServicesTool();

      const result = await invokeSearchServices(handler, {
        product_ids: [42, 43],
        view: 'clients',
        page_size: 10,
        offset: 0,
      });

      const clients = result.clients as Array<Record<string, unknown>>;
      expect(result.view).toBe('clients');
      expect(result.total_matched).toBe(3);
      expect(result.total_clients).toBe(2);
      expect(result.returned).toBe(2);
      expect(clients[0]).toMatchObject({
        clientid: 1,
        service_count: 2,
        product_count: 2,
        product_ids: [42, 43],
        serviceids: [101, 102],
      });
      expect(clients[1]).toMatchObject({
        clientid: 2,
        service_count: 1,
        product_count: 1,
        product_ids: [42],
        serviceids: [103],
      });
    });

    it('should group results by product id in products view', async () => {
      const { handler } = setupSearchServicesTool();

      const result = await invokeSearchServices(handler, {
        clientids: [1, 2],
        view: 'products',
        page_size: 10,
        offset: 0,
      });

      const products = result.products as Array<Record<string, unknown>>;
      expect(result.view).toBe('products');
      expect(result.total_matched).toBe(3);
      expect(result.total_products).toBe(2);
      expect(result.returned).toBe(2);
      expect(products[0]).toMatchObject({
        product_id: 42,
        service_count: 2,
        client_count: 2,
        clientids: [1, 2],
        serviceids: [101, 103],
      });
      expect(products[1]).toMatchObject({
        product_id: 43,
        service_count: 1,
        client_count: 1,
        clientids: [1],
        serviceids: [102],
      });
    });

    it('should deduplicate overlapping services by serviceid', async () => {
      const overlappingReadMock = vi.fn(async (action: string, params: Record<string, unknown>) => {
        if (action === 'GetClientsProducts') {
          if (params.pid !== undefined) {
            return {
              products: { product: [SERVICE_FIXTURES[0]] },
              totalresults: 1,
              numreturned: 1,
              startnumber: Number(params.limitstart ?? 0),
            };
          }

          return buildProductsResponse([SERVICE_FIXTURES[0]], params);
        }

        if (action === 'GetClientsDetails') {
          return CLIENT_FIXTURES[1];
        }

        throw new Error(`Unexpected action: ${action}`);
      });

      const { handler } = setupSearchServicesTool({ readMock: overlappingReadMock });

      const result = await invokeSearchServices(handler, {
        product_ids: [42, 43],
        view: 'services',
        page_size: 10,
      });

      expect(result.total_matched).toBe(1);
      expect(result.returned).toBe(1);
      expect(result.services).toMatchObject([{ serviceid: 101 }]);
    });

    it('should apply local status and domain_contains filters after fetching', async () => {
      const { handler } = setupSearchServicesTool();

      const result = await invokeSearchServices(handler, {
        statuses: ['Active'],
        domain_contains: 'example',
        view: 'services',
        page_size: 10,
      });

      expect(result.total_matched).toBe(1);
      expect(result.services).toMatchObject([{ serviceid: 101 }]);
      expect(result.warnings).toContain('Local filters were applied after fetching WHMCS records.');
    });

    it('should enforce client-mode scope when returning services', async () => {
      mockConfig.MCP_ACCESS_MODE = 'client';
      mockConfig.MCP_ALLOWED_CLIENT_IDS = [1];

      const { handler } = setupSearchServicesTool();

      const result = await invokeSearchServices(handler, {
        product_ids: [42, 43],
        view: 'services',
        page_size: 10,
      });

      const services = result.services as Array<Record<string, unknown>>;
      expect(result.total_matched).toBe(2);
      expect(services).toHaveLength(2);
      expect(services.every((service) => service.clientid === 1)).toBe(true);
    });
  });

  describe('suspend_service', () => {
    it('should validate suspend parameters', () => {
      const { z } = require('zod');

      const suspendServiceSchema = z.object({
        serviceid: z.number().int().positive(),
        reason: z.string().optional(),
      });

      expect(suspendServiceSchema.safeParse({ serviceid: 100 }).success).toBe(true);
      expect(suspendServiceSchema.safeParse({ serviceid: 100, reason: 'Non-payment' }).success).toBe(true);
      expect(suspendServiceSchema.safeParse({ serviceid: 0 }).success).toBe(false);
    });
  });

  describe('unsuspend_service', () => {
    it('should validate serviceid', () => {
      const { z } = require('zod');

      const unsuspendServiceSchema = z.object({
        serviceid: z.number().int().positive(),
      });

      expect(unsuspendServiceSchema.safeParse({ serviceid: 200 }).success).toBe(true);
      expect(unsuspendServiceSchema.safeParse({ serviceid: -1 }).success).toBe(false);
      expect(unsuspendServiceSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('terminate_service', () => {
    it('should require explicit confirmation', () => {
      const { z } = require('zod');

      const terminateServiceSchema = z.object({
        serviceid: z.number().int().positive(),
        confirm: z.literal(true, {
          message: 'Explicit confirm=true is required to terminate a service',
        }),
        confirm_with_unpaid: z.boolean().optional(),
      });

      expect(terminateServiceSchema.safeParse({ serviceid: 100, confirm: true }).success).toBe(true);
      expect(terminateServiceSchema.safeParse({ serviceid: 100, confirm: false }).success).toBe(false);
      expect(terminateServiceSchema.safeParse({ serviceid: 100 }).success).toBe(false);
      expect(terminateServiceSchema.safeParse({ serviceid: 100, confirm: true, confirm_with_unpaid: true }).success).toBe(true);
    });

    it('should check for unpaid invoices', () => {
      interface UnpaidInvoice {
        id: number;
        total: string;
      }

      function shouldWarnAboutUnpaid(
        unpaidInvoices: UnpaidInvoice[],
        confirmWithUnpaid?: boolean
      ): boolean {
        return unpaidInvoices.length > 0 && !confirmWithUnpaid;
      }

      const noUnpaid: UnpaidInvoice[] = [];
      const hasUnpaid: UnpaidInvoice[] = [
        { id: 1, total: '50.00' },
        { id: 2, total: '100.00' },
      ];

      expect(shouldWarnAboutUnpaid(noUnpaid)).toBe(false);
      expect(shouldWarnAboutUnpaid(hasUnpaid)).toBe(true);
      expect(shouldWarnAboutUnpaid(hasUnpaid, true)).toBe(false);
      expect(shouldWarnAboutUnpaid(hasUnpaid, false)).toBe(true);
    });

    it('should calculate total unpaid amount', () => {
      interface UnpaidInvoice {
        id: number;
        total: string;
      }

      function calculateUnpaidTotal(invoices: UnpaidInvoice[]): number {
        return invoices.reduce((sum, inv) => sum + Number.parseFloat(inv.total || '0'), 0);
      }

      const invoices: UnpaidInvoice[] = [
        { id: 1, total: '50.00' },
        { id: 2, total: '100.50' },
        { id: 3, total: '25.25' },
      ];

      expect(calculateUnpaidTotal(invoices)).toBeCloseTo(175.75);
      expect(calculateUnpaidTotal([])).toBe(0);
    });
  });
});
