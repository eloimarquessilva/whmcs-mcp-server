---
description: Build the core infrastructure modules (config, logging, rate limiting, WHMCS client)
---

# Build Core Infrastructure Workflow

## 1. Create config.ts

Create `src/config.ts` with zod validation for all environment variables:

**Key requirements:**

- Load env vars via dotenv at startup
- Validate all required fields with zod
- Fail fast on invalid/missing config
- Export typed `AppConfig` object

**Type definitions:**

```typescript
interface AppConfig {
  WHMCS_API_URL: string;
  WHMCS_IDENTIFIER: string;
  WHMCS_SECRET: string;
  MCP_MODE: "read_only" | "simulate" | "full";
  MCP_RATE_LIMIT: number;
  MCP_DEBUG: boolean;
  MCP_MAX_PAGE_SIZE: number;
  MCP_TOOL_ALLOWLIST: string[];
}
```

---

## 2. Create logging.ts

Create `src/logging.ts`:

**Critical requirements:**

- ALL logs go to stderr (NEVER stdout)
- Use `process.stderr.write()` or `console.error()`
- Include correlation IDs (UUID)
- Redact sensitive fields (secrets, passwords)
- Support verbose mode via `MCP_DEBUG`

**Interface:**

```typescript
interface Logger {
  debug(message: string, data?: Record<string, any>): void;
  info(message: string, data?: Record<string, any>): void;
  warn(message: string, data?: Record<string, any>): void;
  error(message: string, data?: Record<string, any>): void;
}
```

---

## 3. Create rateLimiter.ts

Create `src/rateLimiter.ts`:

**Features:**

- Token bucket rate limiting (calls per second)
- Idempotency cache for high-risk operations
- Time-bucketed keys for idempotency
- Configurable window (30-60 seconds)

**High-risk tools requiring idempotency:**

- `capture_payment`
- `record_refund`
- `accept_order`
- `terminate_service`

---

## 4. Create normalizers.ts

Create `src/whmcs/normalizers.ts`:

**Purpose:** Transform WHMCS quirky responses to proper arrays

**Handle these patterns:**

- `[]` → keep as is
- `{}` → transform to `[]`
- `{"0": {...}, "1": {...}}` → transform to `[{...}, {...}]`

**Fields to normalize:**

- clients, invoices, items, transactions, tickets
- products, services, domains, orders

---

## 5. Create WhmcsClient.ts

Create `src/whmcs/WhmcsClient.ts`:

**Methods:**

```typescript
class WhmcsClient {
  constructor(config: AppConfig, logger: Logger);
  call<T>(
    action: string,
    params: Record<string, any>,
    options?: {
      normalizerKey?: string;
      simulate?: boolean;
      isMutating?: boolean;
    }
  ): Promise<T>;
}
```

**Critical error handling:**

- HTTP != 200 → throw protocol error
- `result === 'error'` → throw `WhmcsBusinessError`
- Convert booleans: `true/false` → `1/0` or `"true"/"false"`

**Create WhmcsBusinessError class:**

```typescript
class WhmcsBusinessError extends Error {
  code?: string | number;
  details?: any;
}
```

---

## 6. Verify compilation

// turbo

```bash
npm run lint
```
