---
description: Implement MCP tools for orders, services, domains, and support tickets
---

# Additional Tools Implementation Workflow

## 1. Create tools/orders.ts

### Tool: list_products

**WHMCS API:** `GetProducts`

**Schema:**

```typescript
const listProductsInput = z.object({
  group_id: z.number().int().optional(),
  name_contains: z.string().optional(),
  include_hidden: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(50),
});
```

**Output:** Simplified array `{ id, name, group_name, description, type, isHidden }[]`

**isMutating:** `false`

---

### Tool: accept_order

**WHMCS API:** `AcceptOrder`

> ⚠️ **Warning in description:** If `autosetup` is true, WHMCS will attempt to contact the provisioning server and may fail if offline.

**Schema:**

```typescript
const acceptOrderInput = z.object({
  orderid: z.number().int().positive(),
  autosetup: z.boolean().default(true),
  sendemail: z.boolean().default(true),
  serverid: z.number().int().optional(),
});
```

**isMutating:** `true` (HIGH RISK - requires idempotency)

---

## 2. Create tools/services.ts

### Tool: suspend_service

**WHMCS API:** `ModuleSuspend` or `UpdateClientProduct`

**Schema:**

```typescript
const suspendServiceInput = z.object({
  serviceid: z.number().int().positive(),
  reason: z.string().optional(),
});
```

**isMutating:** `true`

---

### Tool: unsuspend_service

**Schema:**

```typescript
const unsuspendServiceInput = z.object({
  serviceid: z.number().int().positive(),
});
```

**isMutating:** `true`

---

### Tool: terminate_service

> ⚠️ Requires explicit `confirm: true` parameter

**Schema:**

```typescript
const terminateServiceInput = z.object({
  serviceid: z.number().int().positive(),
  confirm: z.literal(true),
});
```

**Logic:**

- If `confirm !== true`, return `isError: true`
- Check for unpaid invoices (warn or block)
- Execute termination

**isMutating:** `true` (HIGH RISK - requires idempotency)

---

## 3. Create tools/domains.ts

### Tool: check_domain_availability

**WHMCS API:** `DomainWhois`

**Schema:**

```typescript
const checkDomainInput = z.object({
  domain: z.string().min(4), // e.g., "a.cc"
});
```

**Output:**

```typescript
{
  status: 'available' | 'unavailable' | 'unknown',
  raw_status: string,
  reason?: string
}
```

**isMutating:** `false`

---

## 4. Create tools/support.ts

### Tool: create_ticket

**WHMCS API:** `OpenTicket`

**Schema:**

```typescript
const createTicketInput = z.object({
  deptid: z.number().int().positive(),
  subject: z.string().min(1),
  message: z.string().min(1),
  clientid: z.number().int().optional(),
  priority: z.enum(["Low", "Medium", "High"]).default("Medium"),
  markdown: z.boolean().default(true),
  related_service_id: z.number().int().optional(),
});
```

**isMutating:** `true`

---

### Tool: reply_ticket

**WHMCS API:** `AddTicketReply`

**Schema:**

```typescript
const replyTicketInput = z.object({
  ticketid: z.number().int().positive(),
  message: z.string().min(1),
  type: z.enum(["Client", "AdminNote", "AdminPublic"]),
  status_after_reply: z.enum(["Open", "Answered", "Closed"]).optional(),
});
```

**Behavior by type:**

- `Client`: Post client-visible reply, send email
- `AdminNote`: Internal note only (not visible)
- `AdminPublic`: Admin reply visible to client

**isMutating:** `true`

---

## 5. Verify

// turbo

```bash
npm run lint
```
