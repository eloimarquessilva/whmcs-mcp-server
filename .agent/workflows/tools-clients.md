---
description: Implement MCP tools for client management (create, search, get details)
---

# Client Tools Implementation Workflow

## 1. Create tools/clients.ts

Create `src/tools/clients.ts` with the following tools:

---

### Tool: create_client

**WHMCS API:** `AddClient` (with optional `GetClients` for reuse)

**Schema (zod):**

```typescript
const createClientInput = z.object({
  firstname: z.string().min(1),
  lastname: z.string().min(1),
  email: z.string().email(),
  country: z.string().length(2),
  company: z.string().optional(),
  address1: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postcode: z.string().optional(),
  phonenumber: z.string().optional(),
  password: z.string().optional(),
  owner_user_id: z.number().int().optional(),
  mode: z.enum(["create_only", "reuse_if_exists"]).default("reuse_if_exists"),
});
```

**Logic:**

1. If `mode === 'reuse_if_exists'`:
   - Call `GetClients` with email search
   - If found, return `{ clientid, created: false }`
2. Otherwise, call `AddClient`
   - Generate secure password if not provided
3. Return `{ clientid: number, created: boolean }`

**isMutating:** `true`
**Version:** `v1`

---

### Tool: search_clients

**WHMCS API:** `GetClients`

**Schema:**

```typescript
const searchClientsInput = z.object({
  search: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0),
});
```

**Output:** Minimal client summaries only

```typescript
{
  clientid, firstname, lastname, email, companyname;
}
[];
```

**isMutating:** `false`
**Version:** `v1`

---

### Tool: get_client_details

**WHMCS API:** `GetClientsDetails`

**Schema:**

```typescript
const getClientDetailsInput = z.object({
  clientid: z.number().int().positive(),
});
```

**Output:** Full client details including:

- Basic info (name, email, status)
- Credit balance
- Product/domain counts
- Custom fields as `{ name, value }[]`

**isMutating:** `false`
**Version:** `v1`

---

## 2. Export tool registrations

Create helper function to register tools:

```typescript
export function registerClientTools(
  server: McpServer,
  client: WhmcsClient,
  logger: Logger,
  allowlist: string[]
): void;
```

---

## 3. Verify

// turbo

```bash
npm run lint
```
