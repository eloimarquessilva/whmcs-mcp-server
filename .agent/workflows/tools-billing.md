---
description: Implement MCP tools for billing operations (invoices, payments, refunds)
---

# Billing Tools Implementation Workflow

## 1. Create tools/billing.ts

Create `src/tools/billing.ts` with the following tools:

---

### Tool: get_invoice

**WHMCS API:** `GetInvoice`

**Schema:**

```typescript
const getInvoiceInput = z.object({
  invoiceid: z.number().int().positive(),
});
```

**Output:**

- `status`, `total`, `balance`, `date`, `duedate`
- Line items (description, amount, tax flags)
- Transactions (payments with amounts and IDs)

**Normalization:** Use normalizers for `items` and `transactions`

**isMutating:** `false`
**Version:** `v1`

---

### Tool: mark_invoice_paid

**WHMCS API:** `GetInvoice` + `UpdateInvoice`

**Schema:**

```typescript
const markInvoicePaidInput = z.object({
  invoiceid: z.number().int().positive(),
});
```

**Logic:**

1. Fetch invoice first
2. Validate status is `Unpaid`
3. If not, return `isError: true` with clear message
4. Call `UpdateInvoice` with `status='Paid'`

**isMutating:** `true`
**Version:** `v1`

---

### Tool: record_refund

**WHMCS API:** `GetInvoice` + `AddTransaction` + optional `UpdateInvoice`

> ⚠️ **CRITICAL DOCSTRING:**
> "This tool ONLY records the refund inside WHMCS. It does NOT trigger any actual refund at the payment gateway (Stripe/PayPal/etc). The gateway reversal must be done manually."

**Schema:**

```typescript
const recordRefundInput = z.object({
  invoiceid: z.number().int().positive(),
  amount: z.number().positive(),
  refund_type: z.enum(["Credit", "GatewayRecord"]),
  reason: z.string().optional(),
});
```

**Logic:**

1. Fetch invoice and transactions
2. Calculate `max_refundable_amount` from prior payments
3. If `amount > max_refundable_amount`, return `isError: true`
4. For `Credit`: Add credit transaction
5. For `GatewayRecord`: Add outbound transaction with ID `REFUND-{invoiceid}-{timestamp}`
6. If fully refunded, optionally set status to `Refunded`

**Output:** `{ invoiceid, amount, refund_type, new_invoice_status, note }`

**isMutating:** `true` (HIGH RISK - requires idempotency)
**Version:** `v1`

---

### Tool: capture_payment

**WHMCS API:** `GetInvoice` + `CapturePayment`

**Schema:**

```typescript
const capturePaymentInput = z.object({
  invoiceid: z.number().int().positive(),
  cvv: z.string().optional(),
  force: z.boolean().default(false),
});
```

**Logic:**

1. Fetch invoice
2. Validate `status === 'Unpaid'` and `balance > 0`
3. Check for recent failed captures (unless `force=true`)
4. Call `CapturePayment`
5. Parse gateway response

**Output:** `{ success, gateway_response, new_status }`

**isMutating:** `true` (HIGH RISK - requires idempotency)
**Version:** `v1`

---

## 2. Export tool registrations

```typescript
export function registerBillingTools(
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
