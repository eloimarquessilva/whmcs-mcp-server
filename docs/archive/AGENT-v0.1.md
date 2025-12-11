## 1. High-level audit of your blueprint

You already have:

- A very good grasp of **WHMCS quirks** (200-mask, JSON weirdness, missing refund endpoint, boolean/string juggling, whois error cases).
- Thoughtful **tool design** (composite tools, narrow tools for dangerous operations like invoice updates).
- A clear understanding of **MCP semantics** (tools vs resources, Zod as a contract, tool descriptions as “prompt engineering”).

So the critique is about **coverage, sharpness, and operational reality** rather than correctness.

### 1.1 Gaps & blind spots (architecture-level)

**a) No explicit safety / policy layer for the AI**

You’re relying on Zod + tool granularity, but for real production:

- No “**risk policy**” or “guardrails” layer:

  - E.g. “No refunds above ₹X without human approval”, “No terminations if service is active < 24h”, etc.

- No “**human-in-the-loop** mode vs “fully autonomous” mode” toggle.
- No **per-tool safety configs** (e.g., mark_invoice_paid should require double-confirmation or a special flag in non-dev environments).

👉 You need a **Policy & Safety Module** between MCP tools and WHMCS.

---

**b) No rate limiting / concurrency / idempotency strategy**

- WHMCS is not built for **burst traffic** from an over-eager agent.
- You mention latency and batching, but not:

  - **Global rate limits** (e.g., X requests/sec).
  - **Per-tool throttles** (capture_payment and accept_order especially).
  - **Idempotency keys** for sensitive actions (CapturePayment, AcceptOrder, record_refund, etc.)

---

**c) No logging, audit, or observability story**

For an AI-admin:

- You absolutely need:

  - **Structured logging** (tool, params, user, correlation-id, timing, WHMCS result).
  - **Audit trail** (who did what, when, via which tool).
  - **Tracing per conversation** (trace-id from MCP host into your WHMCS calls).

- Otherwise debugging “AI did something weird” will be a nightmare.

---

**d) No environment separation or “mode” distinction**

Your blueprint doesn’t differentiate:

- **Local dev** vs **staging** vs **production** WHMCS.
- Nor does it describe:

  - “Read-only” mode for prod.
  - “Simulated” mode where tools _log_ actions instead of executing.

You really want:

- `MODE=read_only | simulate | full`
- And ideally a per-environment `.env` pattern (or structured config).

---

**e) No versioning & extensibility story**

You don’t mention:

- How tools will evolve when WHMCS adds/removes API params.
- Versioning of:

  - Tool names (e.g., `create_client_v1`, `create_client_v2`).
  - Internal schemas.

- How to plug in **custom WHMCS addons** (internal APIs, hooks) as additional tools.

---

**f) Limited coverage of WHMCS features**

Obviously you can’t do everything in one doc, but missing pieces to at least _mention_:

- **Custom Fields** (clients, products, services).
- **Configurable Options / Addons** for products & orders.
- **Credit handling** beyond refund (top-ups, credit application rules).
- **Cron / automation dependencies** (e.g., late fees, renewal invoices, suspensions).
- **Security-sensitive things**:

  - Password resets.
  - Email template management.
  - Admin accounts / roles.

You don’t need tools for all of these immediately, but the blueprint should at least _mark_ them as future modules.

---

**g) No testing strategy**

Given how risky WHMCS actions are, you should:

- Define a strategy for:

  - **Unit tests** for each tool (happy path + error path + anomaly path).
  - **Integration test harness** that can run against a WHMCS sandbox with an “agent playbook”.
  - **Golden transcripts**: recorded MCP sessions to assert non-regressions.

---

### 1.2 Gaps in the tool design itself

**a) Refunds: missing partial & multi-payment nuance**

You talk about `record_refund` via AddTransaction, but don’t cover:

- **Partial refunds vs full refunds** with multiple payments against one invoice.
- How to:

  - Map the refund to a **specific transaction** (transid) if you want accurate ledger mapping.
  - Handle **currency mismatches** (client currency vs gateway currency).

- Whether the AI is allowed to refund **more than was paid** (must be blocked).

You should specify:

- Tool param: `max_refundable_amount` (fetched by server).
- Server-side check: `amount <= max_refundable_amount`.

---

**b) capture_payment: missing safety for double charges**

You note non-idempotency but don’t enforce:

- Tool should:

  - Check invoice status is `Unpaid` and `balance > 0`.
  - Optionally verify last payment attempt timestamp to avoid immediate retries.

- Maybe require an explicit `force` flag in prod.

---

**c) Client creation: no uniqueness / duplicate-handling strategy**

AddClient will happily create multiple clients with same email if misconfigured / older version / non-unique constraints.

You should:

- Add optional behavior to `create_client`:

  - First run `search_clients` for that email.
  - If found, either:

    - Return existing client, or
    - Fail with “Client already exists” depending on a `mode` param: `'create_only' | 'reuse_if_exists'`.

---

**d) Service lifecycle: missing suspend/unsuspend/terminate tools**

Order lifecycle is only partially covered.

For a real AI admin, you typically need:

- `suspend_service` (ModuleSuspend / UpdateClientProduct).
- `unsuspend_service`.
- `terminate_service`.

With strong guardrails:

- No termination if:

  - Recent signup (within X days) AND there are open tickets about issues.
  - Invoice disputes unresolved.

You don’t have to implement all logic now, but architecture should mention it.

---

**e) Domain lifecycle: missing renew / transfer / sync tools**

You only cover whois and register. Important operations:

- `renew_domain` (DomainRenew).
- `sync_domain` (DomainSync commands via Module or custom addon).
- `transfer_domain` (if exposed via API or custom wrapper).

Even if you don’t fully specify them, note them as **future tools**.

---

### 1.3 MCP / LLM interaction gaps

**a) No explicit “tool usage patterns” for the LLM**

You implicitly rely on descriptions, but you could strengthen:

- Patterns like:

  - “Always search_clients by email before creating a new client.”
  - “When handling billing disputes, prefer `record_refund` with Credit first, then notify human for gateway refund.”
  - “Never change invoice line items on a paid invoice—create a new invoice or record a credit note instead.”

These can sit in:

- A **high-level system prompt** chunk inside the MCP server (a “WhmcsOps Playbook”) that the host loads as context.
- Or be embedded as a separate “resource” the LLM can read.

---

**b) Resources: you underuse them**

You mention a few (`clients/{id}/log`, `system/activity`, `tickets/{id}/thread`) but you don’t:

- Tie them into **actual URI patterns** in your prompt.
- Explain how host clients (Cursor) should fetch and inject those resources.
- Propose resources for things like:

  - `whmcs://invoice/{id}/history`
  - `whmcs://client/{id}/summary`
  - `whmcs://system/config`

Even if implementation is deferred, design them now.

---

## 2. Enhanced spec: what I’d add / tighten

Now I’ll give you a _sharpened_ version of your “Generated Output” section: same spirit, but more complete and battle-ready. Use this as a **drop-in upgraded spec** for Cursor / MCP.

### 2.1 Additional cross-cutting requirements

Add this near “Core Context & Constraints”:

```text
Global Safety & Modes:
- The MCP server must support three operation modes, controlled by an env var MCP_MODE:
  - read_only: Only non-mutating tools are enabled. Mutating tools must immediately fail with a clear error.
  - simulate: Mutating tools log intentions and return mocked success results without calling WHMCS.
  - full: All tools execute real WHMCS calls.
- For every mutating tool, include an is_mutating flag in the implementation and respect MCP_MODE.

Rate Limiting & Idempotency:
- Implement a simple in-memory rate limiter (e.g. token bucket or leaky bucket) to prevent more than N WHMCS requests per second.
- For high-risk tools (capture_payment, record_refund, accept_order, terminate_service), enforce idempotency:
  - Derive an idempotency key from (tool_name + primary_id + timestamp_bucket).
  - Do not re-execute identical requests within a configured short window; instead return the prior result.

Logging & Audit:
- All tool invocations must:
  - Log: tool_name, input params (with secrets redacted), WHMCS action, result, error messages, and a correlation_id.
  - Expose a debug flag in env (MCP_DEBUG) to enable verbose logs.
- The implementation should make it easy to plug in external logging (e.g. pino or Winston).

Configuration:
- Use dotenv for WHMCS_API_URL, WHMCS_IDENTIFIER, WHMCS_SECRET, MCP_MODE, MCP_RATE_LIMIT.
- Validate env vars at startup using zod or a similar schema and fail fast if invalid.
```

---

### 2.2 Strengthened `WhmcsClient` responsibilities

Expand the client’s contract:

```text
WhmcsClient Responsibilities:
- Inject authentication and action fields into every POST.
- Normalize response:
  - If HTTP status is not 200, throw an HttpError with status, body.
  - If response.data.result === 'error', throw a WhmcsBusinessError with code/message/raw.
  - Normalize fields that can be {} or {"0":...} into Arrays based on a per-endpoint map.
- Provide helper methods:
  - get<T>(action, params, normalizerKey?): Promise<T>
  - post<T>(action, params, normalizerKey?): Promise<T>
- Support per-endpoint normalizerKey to know which parts to coerce into arrays (e.g. clients, invoices, products, tickets).
- Optionally support a dryRun flag to bypass calls in simulate mode.
```

---

### 2.3 Tool set: additions & refinements

Below is your tool list, upgraded.

#### Client Management

**1. `create_client` (AddClient)**

Enhancements:

- Param `mode: 'create_only' | 'reuse_if_exists'` (default: `reuse_if_exists`).
- Behavior:

  - If `reuse_if_exists`, search by email first; if found, return existing clientid with `created: false`.
  - Else, create new client and return `{ clientid, created: true }`.

Add to spec:

```text
create_client:
- Inputs:
  - firstname (string, required)
  - lastname (string, required)
  - email (string, email, required)
  - country (string, ISO-2, required)
  - company, address1, city, state, postcode, phonenumber (optional)
  - password (optional)
  - owner_user_id (optional, number)
  - mode: 'create_only' | 'reuse_if_exists' (optional; default 'reuse_if_exists')
- Behavior:
  - In 'reuse_if_exists' mode, search for an existing client by email.
  - If found, do NOT call AddClient, return existing client ID and created=false.
  - Otherwise, call AddClient and return created=true.
- Output:
  - { clientid: number, created: boolean }
```

---

**2. `search_clients` (GetClients)**

You’re good here; just add:

- Optional filter by `email` and `name` separately (if you want to be more structured).
- Guarantee a stable sort (e.g., by clientid asc).

---

**3. `get_client_details` (GetClientsDetails)**

You’ve only implied it; explicitly add as a tool:

```text
get_client_details:
- Inputs: clientid (number, required)
- Returns full client profile including:
  - core fields (name, email, status)
  - credit balance
  - product counts
  - domain counts
  - custom fields (as key/value)
```

---

#### Billing & Financial Operations

**4. `get_invoice` (GetInvoice)**

Add:

- Return computed:

  - `total`, `balance`, `status`
  - line items
  - transactions (payments)

- Use a normalizer for arrays.

---

**5. `mark_invoice_paid` (UpdateInvoice)**

Add safety rules:

- Implementation must:

  - Fetch invoice first.
  - If status is not `Unpaid`, fail with a clear error: “Cannot mark invoice as Paid because status is X.”

- This prevents nonsense like double-paid.

---

**6. `record_refund` (AddTransaction Composite)**

Refine:

```text
record_refund:
- Inputs:
  - invoiceid (int, required)
  - amount (number, required)
  - refund_type: 'Credit' | 'GatewayRecord' (required)
  - reason (string, optional)
- Behavior:
  - Fetch invoice and validate:
    - Ensure amount > 0.
    - Ensure amount <= max_refundable_amount derived from transactions.
  - For 'Credit':
    - AddTransaction with credit=true; amountout=0; amountin=0; credit=amount.
  - For 'GatewayRecord':
    - AddTransaction with amountout=amount, credit=false.
  - Optionally set invoice status to 'Refunded' if fully refunded.
- Crucial Docstring:
  - Explicitly state: "This tool ONLY records the refund in WHMCS. It does not trigger actual gateway reversal (Stripe/PayPal)."
```

---

**7. `capture_payment` (CapturePayment)**

Refine:

```text
capture_payment:
- Inputs:
  - invoiceid (int, required)
  - cvv (string, optional)
  - force (boolean, optional; default false)
- Behavior:
  - Fetch invoice, ensure status is 'Unpaid' and balance > 0.
  - If last failed capture was within a short window (e.g., 5 minutes) and force=false, abort with explanation.
  - Call CapturePayment and return:
    - success (boolean)
    - gateway_response (string)
    - new_status (string)
```

---

#### Orders & Services

**8. `list_products` (GetProducts)**

Add:

- Input filters: `group_id`, `name_contains`, `is_hidden`, etc.
- Return simplified payload:

  - `{ id, name, group_name, description, type, isHidden }`.

---

**9. `accept_order` (AcceptOrder)**

Keep as you have, plus:

- If autosetup is true, attach to description: “May fail if server is offline”.

---

**10. New: `suspend_service`, `unsuspend_service`, `terminate_service`**

They will usually call ModuleSuspend/ModuleUnsuspend/ModuleTerminate or UpdateClientProduct depending on your WHMCS setup. Even if you only implement minimal logic now, define the tools and their safety docs:

```text
suspend_service:
- Inputs: serviceid (int), reason (string, optional).
- Behavior: Suspends hosting service, logs reason in notes.

unsuspend_service:
- Inputs: serviceid (int).
- Behavior: Unsuspends if previously suspended.

terminate_service:
- Inputs: serviceid (int), confirm (boolean).
- Behavior:
  - Requires confirm=true.
  - Refuse if there are unpaid invoices tied to the service, unless an override flag is explicitly added later.
```

---

#### Domain Operations

**11. `check_domain_availability` (DomainWhois)**

You already captured the important “error means config problem” nuance. Add:

- Return **three-state result**:

  - `status: 'available' | 'unavailable' | 'unknown'`.
  - `reason` field if `unknown`.

---

**12. Future (optional to mention)**

Just mark as planned:

- `register_domain` (DomainRegister or AddOrder+Accept).
- `renew_domain`.
- `transfer_domain`.

---

#### Support & Ticketing

**13. `create_ticket` (OpenTicket)**

Add:

- `related_service_id` or `serviceid` if you want to link automatically.
- `markdown: boolean` as you noted.
- Auto-categorize priority default: `'Medium'`.

---

**14. `reply_ticket` (AddTicketReply)**

Refine type enum:

```text
type: 'Client' | 'AdminNote' | 'AdminPublic'
```

Some WHMCS builds distinguish internal vs public replies; your mapping logic will know how to set flags.

Also add:

- `status_after_reply` (optional: 'Open' | 'Answered' | 'Closed') to let the AI update ticket status.

---

### 2.4 MCP Resources: make them explicit

Add a section to your prompt:

```text
Resources:
Expose the following read-only resources to provide passive context to the LLM:

- whmcs://clients/{clientid}/summary
  - Includes basic info, last login, credit balance, active product/domain counts.

- whmcs://clients/{clientid}/log
  - High-level activity log for the client (orders, invoices, suspensions).

- whmcs://invoices/{invoiceid}/history
  - Invoice details, line items, payment & refund transactions.

- whmcs://tickets/{ticketid}/thread
  - Full ticket conversation, including internal notes.

- whmcs://system/activity
  - Recent WHMCS system activity suitable for situational awareness.

Each resource should be implemented via WhmcsClient and exposed with stable URI patterns so the host (Cursor) can fetch them by reference.
```

---

### 2.5 “WhmcsOps Playbook” – add behavioral guidance for the LLM

Add a “meta” document baked into the MCP server, something like:

```text
WhmcsOps Playbook (LLM Usage Guidelines):

- Prefer searching before creating:
  - Always use search_clients before create_client for the same email.
  - For billing disputes, always fetch get_invoice before any financial action.

- Refunds:
  - Use record_refund with refund_type='Credit' for most disputes.
  - Clearly inform the human that gateway refund must be done separately.
  - Never refund more than total paid; the tools will enforce this.

- Payments:
  - Only use capture_payment if:
    - Invoice status is 'Unpaid'.
    - The user or admin has explicitly requested a charge.

- Dangerous operations:
  - Terminate services as a last resort; prefer suspend_service and escalate via AdminNote.
  - For large invoices or refunds, prefer creating AdminNote and asking for human review before executing.

This playbook can be embedded as an MCP Resource (whmcs://docs/ops-playbook) and loaded as context during conversations.
```

---

## 3. How you can use this now

- You don’t have to rewrite everything.
- Take your existing “Generated Output: The Highly Enhanced Cursor Prompt”.
- Inject:

  - The **global safety/mode/rate-limit/audit** section.
  - The **refined tool definitions** (especially create_client, record_refund, capture_payment).
  - The **new tools** (get_client_details, suspend/unsuspend/terminate_service).
  - The **resources** section + **WhmcsOps Playbook** description.
