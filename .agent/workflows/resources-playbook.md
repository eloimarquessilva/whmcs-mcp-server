---
description: Implement MCP resources and ops playbook for WHMCS context
---

# Resources & Playbook Implementation Workflow

## 1. Create resources/index.ts

Create `src/resources/index.ts` with read-only MCP resources:

---

### Resource: whmcs://clients/{clientid}/summary

**WHMCS API:** `GetClientsDetails`

**Returns:**

- Basic identity (name, email, status)
- Credit balance
- Counts of active products, domains

---

### Resource: whmcs://clients/{clientid}/log

**WHMCS API:** `GetClientsProducts`, `GetClientsDetails`, activity log APIs

**Returns:** Recent client activity:

- Orders
- Invoice creation
- Payments
- Suspensions/terminations

---

### Resource: whmcs://invoices/{invoiceid}/history

**WHMCS API:** `GetInvoice`

**Returns:**

- Invoice data and line items
- All transactions (payments/refunds)
- Status changes history

---

### Resource: whmcs://tickets/{ticketid}/thread

**WHMCS API:** `GetTicket`

**Returns:** Full ticket thread:

- Client messages
- Admin replies
- Internal notes (marked as such)

---

### Resource: whmcs://system/activity

**WHMCS API:** `GetActivityLog`

**Returns:** Recent global system activity entries

---

## 2. Create playbook/whmcsOpsPlaybook.ts

Create `src/playbook/whmcsOpsPlaybook.ts`:

**Exposed as:** `whmcs://docs/ops-playbook`

**Content (plain text guidelines):**

```text
# WHMCS Operations Playbook

## Search Before Create
- Always use search_clients before create_client for the same email
- Prevents duplicate client records

## Billing Disputes
- Always call get_invoice before any financial action
- Prefer record_refund with refund_type='Credit' for simple disputes
- IMPORTANT: Gateway refunds (Stripe/PayPal) must be done manually

## Payment Capture
- Only use capture_payment if:
  - User/admin explicitly requested a charge
  - Invoice status is 'Unpaid'
- Never auto-capture without confirmation

## Dangerous Operations
- Prefer suspend_service over terminate_service when in doubt
- For large invoices or refunds (>$100):
  - Add AdminNote via reply_ticket
  - Wait for human review before proceeding
- Always require explicit confirm=true for terminations

## Error Handling
- If tool returns isError: true, stop and report to user
- Never retry failed payments without explicit force=true

## Rate Limits
- Respect rate limits to avoid WHMCS API blocking
- Use pagination for large data sets
- Max page size is 100 records
```

---

## 3. Export resource registrations

```typescript
export function registerResources(
  server: McpServer,
  client: WhmcsClient,
  logger: Logger
): void;

export function registerPlaybook(server: McpServer): void;
```

---

## 4. Verify

// turbo

```bash
npm run lint
```
