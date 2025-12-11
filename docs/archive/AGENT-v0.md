Architectural Blueprint for a High-Fidelity WHMCS Model Context Protocol (MCP) Server
Executive Summary and Architectural Vision

The contemporary landscape of systems administration is undergoing a radical transformation driven by the integration of Large Language Models (LLMs) into operational workflows. In the specific domain of web hosting and automated billing, the Web Host Manager Complete Solution (WHMCS) stands as the incumbent monolith, managing millions of domains, hosting accounts, and financial transactions globally. However, the interaction paradigm for WHMCS has historically remained rooted in manual point-and-click interfaces or rigid, procedural scripts. The emergence of the Model Context Protocol (MCP) offers a transformative opportunity to bridge this gap, allowing AI agents—such as Cursor, Claude, or autonomous support bots—to interact deterministically with the WHMCS ecosystem.

This report presents an exhaustive architectural analysis and implementation guide for constructing a high-fidelity WHMCS MCP Server. Unlike rudimentary retrieval-augmented generation (RAG) systems that merely function as read-only search interfaces, this architecture prioritizes agentic capability. The objective is to empower an AI to perform complex, state-changing operations—provisioning orders, reconciling invoices, managing domain lifecycles, and adjudicating support tickets—with a level of safety and precision that rivals a human administrator.

The core engineering challenge addressed in this document is the "impedance mismatch" between the modern, type-safe, schema-driven architecture of the Model Context Protocol (built on TypeScript and Zod) and the legacy, loosely typed, string-heavy design of the WHMCS External API. This report dissects the necessary API endpoints, normalization strategies, and schema definitions required to bridge this gap. It provides a granular analysis of the WHMCS API's idiosyncrasies—such as its lack of a native refund command and its "200 OK" error masking—and proposes robust software patterns to abstract these complexities away from the AI agent. The culmination of this research is a highly enhanced prompt strategy designed to generate a production-grade MCP server using the Cursor IDE.

1. The WHMCS External API: Legacy Constraints and Modern Adaptation

To construct a robust MCP server, the architect must first possess an intimate understanding of the underlying transport layer. The WHMCS External API, while functionally comprehensive, is a product of its era, heavily influenced by PHP's type flexibility and earlier web service paradigms. This section analyzes the specific constraints of the API that the MCP server must mitigate to ensure reliable AI interaction.
1.1 Authentication Mechanisms and Security Context

The security model of the WHMCS API is a critical consideration for any third-party integration, particularly one involving an autonomous agent. The API supports multiple authentication vectors, but for a server-to-server integration like the MCP, the usage of API Authentication Credentials is practically mandatory, superseding the legacy admin login method.

Historically, integrations would authenticate by passing an administrator’s username and the MD5 hash of their password directly in the request body. This method poses significant security risks, as it couples the integration's access rights to a specific human identity and requires the storage of sensitive password hashes. In contrast, the modern approach utilizes an API Identifier and an API Secret. This methodology decouples the AI's access from a specific human user, allowing for independent rotation of credentials and more granular auditing.

The MCP server must be architected to utilize the $api_identifier and $api_secret post fields. The authentication logic within the MCP server's transport layer must inject these credentials into every POST request body, as WHMCS does not utilize standard HTTP Basic Auth or Bearer Token headers for this purpose.

Furthermore, the concept of Role-Based Access Control (RBAC) is pivotal. WHMCS allows API credentials to be restricted to specific API Roles, which function similarly to Admin Role Groups. The MCP server architecture must account for the possibility that the provided credentials do not possess Full Administrator privileges. An AI agent attempting to execute a TerminateAccount command using credentials restricted to Support Only will receive an authorization failure. The MCP server must handle 403 Forbidden or "Access Denied" responses gracefully. Rather than crashing or returning a generic network error, the server must parse the authorization failure and return a structured message to the AI, such as "Tool execution failed: Insufficient API permissions for this credential set." This allows the AI to self-correct or inform the user of the limitation.

Network security also plays a role. Access to the api.php endpoint is IP-restricted by default within the WHMCS General Settings. In a distributed development environment—for instance, a developer using Cursor on a laptop with a dynamic residential IP—this presents a connectivity challenge. The report recommends implementing a proxy layer or requiring the user to run the MCP server within a VPN or container environment that possesses a static IP whitelisted in the WHMCS Admin Area. Failure to address this network constraint is one of the most common causes of integration failure.

1.2 Response Type Standardization and the JSON Anomaly

The WHMCS External API supports three response formats: XML, JSON, and NVP (Name-Value Pair). While NVP is deprecated and XML is verbose, responsetype=json is the standard for modern integrations. However, the MCP server must contend with a specific serialization anomaly inherent to PHP-based JSON encoding.

In PHP, an associative array (key-value pairs) and an indexed array (list of values) are the same data structure. When WHMCS returns a list of items—for example, a list of domains—it may return a JSON array [...] if the list is populated. However, if the list is empty, older versions of the API or specific endpoints might return an empty object {} or, conversely, an object with numeric keys {"0": {...}, "1": {...}} instead of a true array. This inconsistency can cause strict Zod schemas to fail validation, as they expect a specific type (Array vs Object).

The MCP server must implement a "Normalization Layer" in its HTTP client. This middleware intercepts the raw JSON response from WHMCS and normalizes these inconsistent structures before they reach the Zod validation stage. For instance, if a tool schema expects an array of clients, the middleware must check if the response is an object with numeric keys and convert it to an array, or if it is an empty object, convert it to an empty array. This defensive programming is essential to prevent the AI agent from encountering "Validation Error" hallucinations when it simply encountered an empty dataset.
1.3 Error Handling and the HTTP 200 Mask

A unique characteristic of the WHMCS API is its approach to HTTP status codes. In many scenarios, the API will return a 200 OK status code even if the API call failed due to business logic errors (e.g., "Client Not Found" or "Domain validation failed").

The error details are contained within the JSON body, typically in a result field which will contain the string "error", accompanied by a message field. If the MCP transport layer relies solely on checking for HTTP 4xx or 5xx codes (standard practice in REST clients like Axios), it will falsely report success to the AI. The AI might then hallucinate that it successfully created a user when it actually failed.

To mitigate this, the MCP server's wrapper class must inspect the result field of every response. If result!== 'success', the wrapper must throw a custom JavaScript Error object containing the message from the API. The MCP SDK's error handling mechanism will then capture this and present it to the AI as a tool execution failure. This ensures the AI remains synchronized with the actual state of the system.
1.4 Transport Layer Latency and Optimization

Performance is a critical factor in conversational interfaces. The External API interacts with WHMCS via HTTP POST requests to the /includes/api.php endpoint. This incurs network latency, TCP handshake overhead, and the bootstrap time of the WHMCS PHP application for every request.

The Internal API (localAPI) is significantly faster as it bypasses the HTTP stack, but it requires the code to run on the same server as the WHMCS installation. Given that an MCP server is typically a standalone application (running on a developer's machine via Cursor, or in a Docker container), it must rely on the External API.

To mitigate latency, the MCP tool definitions should optimize for batch data retrieval where possible. For example, instead of an AI agent iterating through a list of 10 invoice IDs and calling GetInvoice ten times (resulting in 10 sequential HTTP round-trips), the MCP server should expose tools that leverage WHMCS's search capabilities to retrieve bulk data in a single request, or implement parallel promise execution within the tool handler if the API forces granular retrieval. 2. Model Context Protocol (MCP) TypeScript Implementation Strategy

The Model Context Protocol provides the standardization layer that allows the LLM to understand the capabilities of the WHMCS server. The implementation relies on the @modelcontextprotocol/sdk and uses TypeScript to ensure type safety. The bridge between the loose schemas of WHMCS and the strict requirements of the AI is the Zod validation library.

2.1 Tool Schema Definition as Prompt Engineering

In the context of MCP, the Tool Definition is not merely code; it is a prompt. The name, description, and parameter description fields are consumed directly by the LLM to understand how and when to use the tool. A poorly documented tool will lead to poor AI performance.

The description field for each tool must be exhaustive. For a tool like create_client (wrapping AddClient), it is insufficient to simply state "Adds a client." The description must articulate the business rules: "Creates a new client account. Requires first name, last name, and email. Optional fields include address, security questions, and tax configuration. Returns the new Client ID. If no password is provided, one will be auto-generated."

This level of detail reduces the "cognitive load" on the model and reduces the likelihood of it hallucinating parameters that do not exist or guessing the behavior of optional fields.
2.2 Zod Validation: The Gatekeeper

WHMCS is notoriously permissive with input types, often accepting strings for integers (e.g., "123" vs 123) due to PHP's type juggling. However, to ensure robust operation, the MCP server should enforce strict typing at the ingress point.

    Numeric IDs: Fields like clientid, serviceid, and invoiceid should be defined as z.number().int(). This signals to the AI that it must extract the numerical ID from its context, rather than passing a string descriptor.

    Enumerated Statuses: Fields with finite options are prime candidates for Zod enums. For example, the status field in UpdateInvoice should be defined as z.enum(). This prevents the AI from attempting to set an invalid status like "Overdue" (which is a calculated state, not a settable status in the database).

    Boolean Handling: The WHMCS API often expects boolean values to be passed as strings "true" or "false" in the POST body, or as 1 and 0. The MCP tool schema should expose these as z.boolean() to the AI for clarity. The internal implementation of the tool must then map the boolean true to the string "1" or "true" required by the specific API endpoint. This abstraction allows the AI to "think" in logical booleans while the server handles the legacy translation.

2.3 Resource Exposure for Contextual Awareness

While "Tools" allow the AI to take action, "Resources" allow the AI to read context passively. The MCP architecture supports defining Resources via URI templates. For a WHMCS server, exposing specific logs as resources creates a powerful workflow.

    whmcs://clients/{id}/log: Exposing the activity log for a specific client allows the AI to answer questions like "What happened to this client's account yesterday?" without executing a search tool.

    whmcs://system/activity: The global system activity log provides high-level situational awareness.

    whmcs://tickets/{id}/thread: Exposing the conversation history of a ticket as a resource allows the AI to ingest the full context of a support request before drafting a reply.

This "subscription" model is superior to constant polling via Tool calls, as it allows the host application (like Cursor) to fetch and embed this context automatically when the user references a specific URI. 3. Core Module: Client Management Architecture

The Client Management module acts as the foundational layer of the MCP server. In WHMCS, almost all other operations—billing, domain registration, support ticketing—require a valid clientid as a foreign key. Therefore, the robust implementation of client search and creation is a prerequisite for a functional server.
3.1 Client Creation (AddClient)

The AddClient API is one of the most complex commands due to the sheer volume of optional parameters and the underlying complexity of the WHMCS user model.

The User vs. Client Distinction: In modern versions of WHMCS (8.0+), a distinction was introduced between "Users" (entities that can log in) and "Clients" (entities that own products and pay bills). A single User can manage multiple Clients. The AddClient API handles this by checking for an owner_user_id parameter.

    If owner_user_id is provided, the new Client account is linked to that existing User.

    If owner_user_id is not provided, WHMCS implicitly creates a new User with the same email and password provided in the request.

The MCP tool create_client must be aware of this. The Zod schema should include owner_user_id as an optional number. The tool description must inform the AI: "If owner_user_id is omitted, a new User account will be created automatically. Use this field to add a new Client profile to an existing user."

Schema Definition Strategy: The following table outlines the mapping between the Zod schema exposed to the AI and the underlying WHMCS requirements.
Parameter Zod Schema Definition WHMCS Constraint Contextual Insight
firstname z.string().min(1) Required Foundational identity field.
lastname z.string().min(1) Required Foundational identity field.
email z.string().email() Required Acts as the primary username for the implicit User creation.
country z.string().length(2) Required (ISO) Critical: WHMCS validates this against ISO 3166-1 alpha-2. The AI often hallucinates full names ("United Kingdom"). The schema must enforce .length(2) to guide the AI to use "GB".
password z.string().optional() Optional If omitted, the MCP tool logic should generate a secure random password to ensure the account is created securely.
address1 z.string().optional() Optional While optional in API, often required for payment gateways (AVS checks).
phonenumber z.string().optional() Optional WHMCS has strict formatting rules for phone numbers depending on settings; passing international format (E.164) is best practice.

Operational Logic and Return Values: Upon successful execution, the AddClient API returns a JSON object containing clientid. The MCP tool must capture this ID and explicitly return it in the content text of the result. For example: "Client created successfully. Client ID: 1234." This explicit confirmation allows the AI to capture the ID into its context window for use in subsequent steps (e.g., immediately creating an order for Client 1234).
3.2 Client Retrieval and Search (GetClients)

Before an AI can act on a client, it must find them. The GetClients API serves this purpose, supporting a search string that matches against name, company name, and email.

Pagination Management: The GetClients API is paginated using limitstart and limitnum. Returning thousands of clients to the AI's context window is inefficient and expensive. The MCP tool search_clients should default limitnum to a reasonable batch size (e.g., 25). If the AI needs more, it can issue a subsequent call with an incremented offset. The tool description should clarify this: "Search for clients by name or email. Returns a maximum of 25 results per call."

Detail Expansion Strategy: GetClients returns a summary list (ID, Name, Email). It does not return the client's credit balance, active service count, or custom field data. To access this, the GetClientsDetails API command is required.

    Architectural Decision: It is cleaner to separate these concerns into two tools: search_clients (lightweight, for finding IDs) and get_client_details (heavyweight, for getting the full profile of a known ID). This prevents fetching massive payloads when the AI is simply trying to resolve a name to an ID.

4. Deep Dive: Financial Orchestration & The Refund Paradox

The Billing module is the most sensitive component of the MCP server. Orchestrating financial transactions requires high precision, as errors here result in real-world monetary loss or accounting discrepancies.
4.1 Invoice Generation and Modification

The lifecycle of an invoice is managed via CreateInvoice and UpdateInvoice. The CreateInvoice command is straightforward, but UpdateInvoice is a powerful, multi-purpose command that carries significant risk.

The update_invoice Tool Strategy: The UpdateInvoice API allows modifying line items, tax rates, statuses, dates, and credits in a single call. Exposing this as a single monolithic tool to the AI is dangerous; the complexity of the parameters (nested arrays for line items) increases the chance of hallucination.

    Refining Tool Granularity: A superior pattern is to create specific helper tools that wrap UpdateInvoice with preset configurations.

        invoice_mark_paid: A specific tool that takes invoiceid and calls UpdateInvoice with status='Paid'. This reduces the parameter surface area to just the ID.

        invoice_add_item: A specific tool that accepts description and amount and maps them to the newitemdescription and newitemamount arrays of the API. This abstracts the array handling away from the AI.

4.2 The Refund Paradox: Implementation of Missing Functionality

A critical finding from the deep research is the absence of a direct RefundInvoice or RefundOrder API command in the standard WHMCS External API. While payment gateways often support refunds, and the admin area has a "Refund" button, this functionality is not exposed as a single atomic API command.

The Composite Tool Solution: To enable the AI to perform refunds, the MCP server must implement a "Composite Tool"—a tool that executes a sequence of API calls or a specific logic flow that mimics the actions of a human administrator manually processing a refund.

Scenario A: Credit Balance Refund (The "AddTransaction" Approach) If the goal is to refund a payment back to the client's credit balance (not the gateway), the logic involves adding a negative transaction or a specific expenditure transaction. The AddTransaction API command is the mechanism for this.

    Tool: refund_to_credit

    Mechanism:

        Accepts invoiceid and amount.

        Calls AddTransaction with:

            invoiceid: The target invoice.

            amountout: The refund amount (using amountout signifies money leaving the system/merchant).

            transid: A generated reference (e.g., REFUND-).

            description: "Credit Refund for Invoice #X".

            credit: true (This flag tells WHMCS to add the amount to the client's credit balance).

        Optionally calls UpdateInvoice to set the status to Refunded if the entire balance is returned.

Scenario B: Gateway Refund (The Limitation) Triggering a refund at the gateway level (e.g., telling Stripe to reverse the charge) via the API is significantly harder. Some gateways rely on callback hooks or internal PHP functions that are not exposed via api.php.

    Architectural Constraint: Unless the specific WHMCS installation has a custom addon that exposes gateway refund functions, the MCP server cannot reliably trigger remote gateway refunds.

    Mitigation: The MCP tool record_refund should be explicitly documented as an accounting tool. The description must read: "Records a refund in the WHMCS ledger. Note: This does not trigger the reversal at the payment gateway (e.g., PayPal/Stripe). You must process the reversal at the gateway portal separately." This crucial warning prevents the AI from misleading the user into thinking the money has been returned when only the record has been updated.

4.3 Payment Capture (CapturePayment)

For automated payment processing, the CapturePayment API attempts to charge the client's stored payment method (e.g., tokenized credit card).

Risk and Idempotency: The CapturePayment command is not idempotent. Calling it twice might result in two charges if the gateway is slow or if the first response was lost.

    Safety Descriptions: The tool description should advise the AI: "Attempts to capture payment for a due invoice using the stored card on file. Use with caution. Verify invoice status is 'Unpaid' before executing."

    Response Parsing: The API returns success or failure strings. The MCP server must parse these and return a strictly boolean success flag to the AI, along with the raw gateway response text for context.

5. Deep Dive: Service Provisioning & Order Lifecycle

The Order Management module controls the provisioning of products (hosting accounts, VPS, licenses). This is the revenue-generating engine of WHMCS.
5.1 Product Retrieval (GetProducts)

To place an order, the AI needs to know what is for sale. The GetProducts API returns the full product catalog.

Data Volume and Context Window: The GetProducts response is notoriously verbose, containing deep pricing arrays for every currency and every billing cycle (monthly, quarterly, semi-annually, etc.) for every product. Dumping this raw JSON into the AI's context window consumes massive token counts and distracts the model.

    Filtering Strategy: The MCP tool list_products should implement a server-side filter. It should map the raw response to a simplified array of objects containing only: id, name, group_name, and description. The pricing details should be omitted unless specifically requested via a separate get_product_pricing tool. This "Summary View" allows the AI to efficiently browse the catalog to find the correct pid for an order.

5.2 Order Acceptance (AcceptOrder)

When an order is placed (either via the API's AddOrder or the public order form), it sits in a Pending state. The AcceptOrder API is the trigger that executes the provisioning modules (e.g., calling the cPanel API to create the account).

Key Parameters for the Zod Schema: The AcceptOrder command accepts several boolean flags that control the automation logic.

    orderid: z.number().int() (Required).

    autosetup: z.boolean().optional() (Default true). Insight: If set to true, WHMCS attempts to connect to the provisioning server immediately. If that server is offline, the API call may time out or hang. The AI should be aware of this dependency.

    sendemail: z.boolean().optional() (Default true). This controls the "Product Welcome Email." In migration scenarios, an admin might want to accept orders without emailing the client. Exposing this flag to the AI allows for "silent" provisioning workflows.

    registrar: z.string().optional(). For domain orders, this allows overriding the default registrar. This is useful if the AI determines that a specific TLD should be routed to a specific registrar logic (e.g., "Use Enom for this.com instead of the default GoDaddy").

6. Deep Dive: Domain Registry Operations

Domain operations allow the AI to function as a Tier 1 Registrar Support Agent, checking availability and managing registrations.
6.1 Availability and The "Error" Status (DomainWhois)

The DomainWhois API checks if a domain is available for registration.

The Configuration Trap: Research indicates that DomainWhois frequently returns a status of error (instead of available or unavailable) if the TLD in question is not explicitly configured in the WHMCS whois.json file. This is a common configuration gap in many WHMCS installations.

    MCP Mitigation: The MCP server wrapper must handle this case. If the API returns status: "error", the tool should not simply report "Error." It should interpret this for the AI: "Status: Unknown/Configuration Error. The system cannot determine availability for this TLD. Please verify the TLD is configured in the WHMCS Whois settings." This distinguishes a system failure from a domain being taken.

6.2 Registration (DomainRegister)

The DomainRegister command triggers the purchase logic.

Workflow Dependency: While DomainRegister exists, the standard WHMCS workflow is AddOrder (Type=Domain) -> AcceptOrder. The DomainRegister API is often used for administrative registrations that bypass the order process. The MCP tool description should clarify this distinction: "Initiates a domain registration request at the registrar. Typically used for manual registrations. For client purchases, prefer creating an Order."

IDN Support: The API supports idnlanguage for Internationalized Domain Names. The Zod schema should include this as an optional string to support global markets.

7. Deep Dive: Support & Ticketing

The Support module is the most natural fit for an LLM integration, as it involves unstructured text data.
7.1 Opening Tickets (OpenTicket)

The OpenTicket API is the entry point for creating support requests.

Attachment Handling: The API supports an attachments parameter, which accepts a base64 encoded array of file data.

    MCP Capability: The Model Context Protocol supports passing binary resources. If the user provides a file to the AI (e.g., "Here is the screenshot of the error"), the MCP server can theoretically ingest this.

    Schema: attachments: z.array(z.object({ name: z.string(), data: z.string() })).optional(). The data field must be the base64 string. The MCP server implementation would need to handle the conversion of any incoming file resources into this base64 format before sending to WHMCS.

7.2 Replying to Tickets (AddTicketReply)

The AddTicketReply API allows the AI to respond to customers.

Internal vs. External Communication: A critical feature for an AI agent is the ability to "think" or leave notes for human staff without the customer seeing them. The AddTicketReply API supports an admin flag or type parameter (depending on version) to post "Internal Notes."

    Tool Design: The reply_ticket tool should utilize a strict enum for the reply type: z.enum(['Client', 'AdminNote']).

        If Client is selected, the reply is emailed to the customer.

        If AdminNote is selected, it is added privately to the ticket log.

        Prompting Strategy: This distinction empowers the AI to draft a response as a private note for human review ("I have drafted a response, saving as internal note...") rather than sending it immediately, creating a "Human-in-the-Loop" workflow.

8. Constructing the Enhanced Cursor Prompt

The final output of this architectural analysis is the construction of the Prompt itself. This prompt is not merely a request for code; it is a specification document compressed into a prompt format. It must carry the weight of all the insights gathered above—the JSON anomalies, the refund workarounds, the security constraints, and the Zod schema strategies.
8.1 Prompt Architecture

The prompt provided to Cursor should be structured in four distinct components to ensure the generated code is production-grade.

Component 1: Role and Protocol Definition This section establishes the persona and the technical stack. It strictly mandates @modelcontextprotocol/sdk and zod. It sets the expectation for a stateless HTTP transport layer using axios or node-fetch.

Component 2: The Context Injection (The "Knowledge Graph") This section explicitly lists the "Gotchas" discovered in the research. It tells the AI about the 200 OK error masking, the need for API credentials over admin login, and the empty array serialization issues. This prevents the generated code from containing common bugs.

Component 3: The Tool Specifications This is the core functional requirement list. It defines the specific tools to be built, mapping them to their underlying WHMCS API commands. It includes the "Composite Tools" like record_refund which do not have a 1:1 API mapping.

Component 4: Coding Standards and Error Handling This section mandates the use of a WhmcsClient wrapper class to centralize authentication and error parsing. It enforces the use of environment variables for configuration (WHMCS_API_URL, WHMCS_API_IDENTIFIER, WHMCS_API_SECRET). 9. Conclusion

The construction of a WHMCS MCP Server represents a sophisticated integration challenge that goes far beyond simple API wrapping. It requires a deep appreciation for the legacy constraints of the WHMCS platform—its PHP roots, its inconsistent JSON serialization, and its omission of modern transactional primitives like a unified Refund API.

However, by adopting the architectural patterns detailed in this report—specifically the use of strict Zod schemas to enforce type safety, the implementation of "Composite Tools" to handle complex logic gaps, and the rigorous normalization of API responses—developers can build a bridge that allows modern AI agents to safely and effectively administer hosting environments. The resulting system transforms the WHMCS administration experience from a manual, click-heavy burden into a conversational, automated, and intelligent workflow.
Appendix A: Functionality Parameter Mapping Tables

The following tables provide the specific data points required to generate the Zod schemas in the final prompt.
A.1 Client Management Parameters
Field Type Required? Constraints & Research Notes Source
action string Yes Fixed value: AddClient
firstname string Yes Validation: min(1)
lastname string Yes Validation: min(1)
email string Yes Validation: email(). Unique key.
country string Yes ISO 3166-1 alpha-2 (e.g., US, CA).
address1 string No Recommended for billing AVS checks.
phonenumber string No Format varies by localized settings.
password string No Logic: Generate if owner_user_id missing.
owner_user_id int No Links to existing User entity (WHMCS 8+).

Research Insight: The deprecated fields cardtype, cardnum, etc. are excluded to maintain PCI compliance. The AI should not handle raw credit card data via AddClient.

A.2 Order Acceptance Parameters
Field Type Required? Constraints & Research Notes Source
action string Yes Fixed value: AcceptOrder
orderid int Yes Target Order ID.
serverid int No Overrides default server selection algorithm.
registrar string No Overrides TLD default registrar.
autosetup bool No Triggers external module (cPanel/Plesk).
sendemail bool No Controls "Welcome Email" dispatch.

A.3 Invoice Updates and Refunds
Field Type Required? Constraints & Research Notes Source
action string Yes Fixed value: UpdateInvoice
invoiceid int Yes
status string No Enum: 'Unpaid', 'Paid', 'Cancelled', 'Refunded', 'Collections'.
paymentmethod string No System name (e.g., 'paypal', 'stripe').

Refund via AddTransaction (Composite Tool):
Field Type Required? Constraints & Research Notes Source
action string Yes Fixed value: AddTransaction
amountout float No Primary Refund Field. Represents money out.
fees float No Negative value to reverse transaction fees.
transid string No Reference ID (e.g., 'REF-123').
credit bool No If true, adds to client credit balance.

A.4 Support Ticket Parameters
Field Type Required? Constraints & Research Notes Source
action string Yes Fixed value: OpenTicket
deptid int Yes Target Department ID.
subject string Yes
message string Yes
clientid int No Links ticket to client account.
priority string No Enum: 'Low', 'Medium', 'High'.
markdown bool No If true, renders message as Markdown.

Generated Output: The Highly Enhanced Cursor Prompt

Prompt Header: "Generate a robust, production-ready TypeScript Model Context Protocol (MCP) Server for WHMCS. This server will enable an AI agent to perform administrative actions on a WHMCS installation via the External API. The implementation must strictly adhere to the @modelcontextprotocol/sdk and use zod for all schema validation."

Prompt Context Injection (Copy this block into Cursor): I require a high-fidelity MCP Server implementation for WHMCS. Core Context & Constraints:

    Authentication: The server must use the identifier and secret post fields for authentication. Do NOT use the legacy admin/password hash method.

    Transport: Use axios for HTTP requests. The endpoint is /includes/api.php.

    Response Normalization: WHMCS returns 200 OK even for API errors. You must implement a middleware that checks if response.data.result === 'error' and throws a JavaScript Error with response.data.message.

    JSON Anomalies: WHMCS may return empty lists as {} or {"0":...} instead of ``. Your HTTP client must normalize these into proper Arrays before Zod validation.

    Boolean Handling: Map Zod booleans (true/false) to the strings or integers expected by specific WHMCS endpoints (usually 1 or true).

Tool Implementations: Implement the following tools with precise schemas:

    Client Management:

        create_client (wraps AddClient):

            Inputs: firstname, lastname, email (Required). company, address1, city, state, country (ISO-2), postcode, phonenumber, password, owner_user_id.

            Context: Return the new clientid explicitly in the tool result.

        search_clients (wraps GetClients):

            Inputs: search (string), limit (default 25).

            Context: Handle pagination limits.

    Billing & Financial Operations:

        get_invoice (wraps GetInvoice):

            Inputs: invoiceid.

        mark_invoice_paid (wraps UpdateInvoice):

            Inputs: invoiceid. Logic: Sets status to 'Paid'.

        record_refund (wraps AddTransaction - Composite Tool):

            Inputs: invoiceid, amount, refund_type (Enum: 'Credit', 'GatewayRecord').

            Logic: Calls AddTransaction. If 'Credit', sets credit=true. If 'GatewayRecord', sets amountout=amount and transid to a generated reference.

            Crucial Docstring: "Records a refund in WHMCS. For GatewayRecord, this does NOT trigger the gateway reversal; it only updates the ledger."

        capture_payment (wraps CapturePayment):

            Inputs: invoiceid, cvv (optional).

    Order Management:

        list_products (wraps GetProducts):

            Logic: Map the massive response to a lightweight array of {id, name, group, description} to save context window.

        accept_order (wraps AcceptOrder):

            Inputs: orderid, autosetup (bool), sendemail (bool), serverid (optional).

    Support System:

        create_ticket (wraps OpenTicket):

            Inputs: deptid, subject, message, clientid, priority.

        reply_ticket (wraps AddTicketReply):

            Inputs: ticketid, message, type (Enum: 'Client', 'AdminNote').

            Logic: Maps 'AdminNote' to the API's internal note flag.

    Domain Ops:

        check_domain_availability (wraps DomainWhois):

            Logic: If API returns status: 'error', return a user-friendly message about TLD configuration rather than a generic failure.

Architecture:

    Create a WhmcsClient class to encapsulate the axios instance, auth injection, and error normalization.

    Use dotenv for configuration (WHMCS_API_URL, WHMCS_IDENTIFIER, WHMCS_SECRET).

    Implement the server using StdioServerTransport for Cursor integration.
