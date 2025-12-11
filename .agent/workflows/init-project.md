---
description: Initialize the WHMCS MCP Server TypeScript project from scratch
---

# Initialize Project Workflow

## 1. Create package.json

```bash
npm init -y
```

// turbo

## 2. Install production dependencies

```bash
npm install @modelcontextprotocol/sdk zod axios dotenv uuid
```

## 3. Install development dependencies

```bash
npm install -D typescript @types/node @types/uuid tsup tsx
```

## 4. Create tsconfig.json

Create `tsconfig.json` with strict settings:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

## 5. Update package.json scripts

Add to package.json:

```json
{
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "lint": "tsc --noEmit"
  }
}
```

## 6. Create directory structure

```bash
mkdir -p src/whmcs src/tools src/resources src/playbook
```

// turbo

## 7. Create .env.example

Create `.env.example` with all required environment variables:

```
WHMCS_API_URL=https://your-whmcs-domain.com
WHMCS_IDENTIFIER=your_api_identifier
WHMCS_SECRET=your_api_secret
MCP_MODE=read_only
MCP_RATE_LIMIT=10
MCP_DEBUG=false
MCP_MAX_PAGE_SIZE=100
MCP_TOOL_ALLOWLIST=
```

## 8. Create .gitignore

Create `.gitignore`:

```
node_modules/
dist/
.env
*.log
```

## 9. Verify setup

// turbo

```bash
npm run lint
```
