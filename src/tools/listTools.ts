/**
 * Shared read-only list-tool factory for WHMCS MCP Server.
 *
 * Builds paginated, read-only "list_*" tools that share a common
 * input contract (clientid + limit/offset), WHMCS pagination mapping
 * (limit -> limitnum, offset -> limitstart), normalization, and a
 * consistent response envelope: { items, total, count, offset, limit }.
 *
 * Only `registerListTool` is exported here. The per-tool aggregator
 * (`registerListTools`) is intentionally a later task.
 */

import { z } from 'zod';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient, WhmcsBusinessError } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { config, isToolAllowed } from '../config.js';
import { ensureToolAuth, isClientMode, ensureClientAllowed, AUTH_SHAPE } from '../security.js';
import { normalizeToArray } from '../whmcs/normalizers.js';

/**
 * Standard MCP annotations for read-only list tools.
 */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * Configuration for a single read-only list tool.
 */
export interface ListToolConfig<T> {
  /** MCP tool name, e.g. `list_invoices`. */
  name: string;
  /** Human-readable tool description. */
  description: string;
  /** WHMCS API action, e.g. `GetInvoices`. */
  action: string;
  /** Which WHMCS param carries the client id. */
  clientParam: 'clientid' | 'userid';
  /** Top-level container key in the WHMCS response, e.g. `invoices`. */
  normalizerPath: string;
  /** Override for the singular wrapper key (defaults to a naive de-pluralize). */
  singular?: string;
  /** Extra zod shape merged into the base input schema. */
  extraSchema: z.ZodRawShape;
  /** Constant params always sent to the WHMCS API. */
  fixedParams?: Record<string, unknown>;
  /** Maps a raw WHMCS row to the public item shape. */
  mapItem: (raw: any) => T;
  /** Optional post-mapping sort applied to all items. */
  postSort?: (items: T[]) => T[];
  /** Extra fields merged into the response envelope. */
  extraPayload?: Record<string, unknown>;
}

/**
 * Register a single read-only, paginated list tool on the MCP server.
 *
 * No-op if the tool is disabled via `isToolAllowed`.
 */
export function registerListTool<T>(
  server: McpServer,
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter,
  c: ListToolConfig<T>
): void {
  if (!isToolAllowed(c.name)) return;

  const schema = z.object({
    clientid: z.number().int().positive(),
    limit: z.number().int().min(1).max(config.MCP_MAX_PAGE_SIZE).default(10),
    offset: z.number().int().min(0).default(0),
    ...c.extraSchema,
  });

  // The shared `ensure*` helpers return a local `McpToolResponse` type that
  // lacks the SDK's `[x: string]: unknown` index signature, so the inferred
  // callback return type is not structurally assignable to `ToolCallback`.
  // This is a type-only boundary cast; runtime behavior is unchanged and the
  // returned envelope is a valid MCP tool result.
  const handler: ToolCallback<z.ZodRawShape> = (async (params: any) => {
      const log = logger.child();
      const t0 = Date.now();
      try {
        const authErr = ensureToolAuth(params as Record<string, unknown>);
        if (authErr) return authErr;

        if (isClientMode()) {
          const scopeErr = ensureClientAllowed(params.clientid);
          if (scopeErr) return scopeErr;
        }

        log.logToolCall(c.name, params, false);

        if (!rl.tryConsume()) throw new RateLimitError();

        const { limit = 10, offset = 0, clientid } = params;
        const apiParams: Record<string, unknown> = {
          [c.clientParam]: clientid,
          limitnum: limit,
          limitstart: offset,
          ...(c.fixedParams ?? {}),
        };
        for (const k of Object.keys(c.extraSchema)) {
          if (params[k] !== undefined) apiParams[k] = params[k];
        }

        const resp = await whmcs.read<Record<string, any>>(c.action, apiParams);

        const container = resp[c.normalizerPath];
        const singular =
          c.singular ??
          c.normalizerPath.replace(/ies$/, 'y').replace(/s$/, '');
        const rows = normalizeToArray<any>(
          container && typeof container === 'object'
            ? container[singular] ?? container
            : container
        );

        let items = rows.map(c.mapItem);
        if (c.postSort) items = c.postSort(items);

        log.logToolResult(c.name, true, Date.now() - t0);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                items,
                total: resp.totalresults ?? items.length,
                count: resp.numreturned ?? items.length,
                offset: resp.startnumber ?? offset,
                limit,
                ...(c.extraPayload ?? {}),
              }),
            },
          ],
        };
      } catch (e) {
        log.logToolResult(
          c.name,
          false,
          Date.now() - t0,
          e instanceof Error ? e.message : String(e)
        );
        if (e instanceof RateLimitError || e instanceof WhmcsBusinessError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ isError: true, error: (e as Error).message }),
              },
            ],
            isError: true,
          };
        }
        throw e;
      }
    }) as unknown as ToolCallback<z.ZodRawShape>;

  server.registerTool(
    c.name,
    {
      description: c.description,
      inputSchema: { ...schema.shape, ...AUTH_SHAPE },
      annotations: { ...READ_ONLY_ANNOTATIONS },
    },
    handler
  );
}
