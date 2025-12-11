---
description: Build and verify the complete MCP server
---

# Build and Verify Workflow

## 1. Create src/index.ts

Create the MCP server entry point:

```typescript
// Main structure:
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logging.js";
import { WhmcsClient } from "./whmcs/WhmcsClient.js";
import { registerClientTools } from "./tools/clients.js";
import { registerBillingTools } from "./tools/billing.js";
import { registerOrderTools } from "./tools/orders.js";
import { registerServiceTools } from "./tools/services.js";
import { registerDomainTools } from "./tools/domains.js";
import { registerSupportTools } from "./tools/support.js";
import { registerResources, registerPlaybook } from "./resources/index.js";
```

**Initialization sequence:**

1. Load and validate config (fails fast)
2. Create logger (stderr only)
3. Create WhmcsClient instance
4. Create MCP Server with metadata
5. Apply MCP_TOOL_ALLOWLIST filter
6. Register tools from all modules
7. Register resources
8. Connect with StdioServerTransport

---

## 2. Build the project

```bash
npm run build
```

---

## 3. Test TypeScript compilation

// turbo

```bash
npm run lint
```

Verify no TypeScript errors.

---

## 4. Create test .env file

Create `.env` for local testing (copy from `.env.example`):

```bash
cp .env.example .env
```

Edit with test credentials.

---

## 5. Test MCP server startup

```bash
npm run start
```

Server should:

- Initialize without errors
- Wait for MCP protocol connection on stdin/stdout
- Log startup to stderr

---

## 6. Integration test with Cursor

1. Add server to Cursor MCP settings:

```json
{
  "mcpServers": {
    "whmcs": {
      "command": "node",
      "args": ["/path/to/whmcs-mcp-server/dist/index.js"],
      "env": {
        "WHMCS_API_URL": "...",
        "WHMCS_IDENTIFIER": "...",
        "WHMCS_SECRET": "...",
        "MCP_MODE": "read_only"
      }
    }
  }
}
```

2. Restart Cursor
3. Verify tools appear in MCP panel
4. Test a read-only tool (e.g., `search_clients`)

---

## 7. Verify modes

Test each mode:

- `read_only`: Mutating tools should return `isError: true`
- `simulate`: Mutating tools log but don't call WHMCS
- `full`: All tools execute against WHMCS

---

## 8. Verify rate limiting

Send rapid requests to test rate limiter returns `isError: true` when exceeded.

---

## 9. Document in README.md

Create comprehensive README with:

- Installation instructions
- Configuration options
- Available tools and resources
- Usage examples
- Security considerations
