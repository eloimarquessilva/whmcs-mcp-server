/**
 * Domain Tools for WHMCS MCP Server
 * 
 * Tools: check_domain_availability
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient, WhmcsBusinessError } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { isToolAllowed } from '../config.js';

const TOOL_VERSION = 'v1';

/**
 * Check domain availability input schema
 */
const checkDomainSchema = z.object({
  domain: z.string().min(4, 'Domain must be at least 4 characters (e.g., a.cc)'),
});

/**
 * Validate domain format with IDN (Internationalized Domain Name) support
 * 
 * Supports:
 * - Standard ASCII domains: example.com
 * - Punycode (ACE) domains: xn--nxasmq5b.xn--wgbh1c (مثال.مصر)
 * - Unicode/IDN domains: пример.рф, 例え.jp
 * - New gTLDs and ccTLDs of any length
 */
function isValidDomainFormat(domain: string): boolean {
  // Check for empty or too long
  if (!domain || domain.length > 253) {
    return false;
  }
  
  // Split into labels
  const labels = domain.split('.');
  
  // Must have at least 2 labels (name + TLD)
  if (labels.length < 2) {
    return false;
  }
  
  // Validate each label
  for (const label of labels) {
    // Each label must be 1-63 characters
    if (!label || label.length > 63) {
      return false;
    }
    
    // Punycode label (ACE prefix)
    if (label.toLowerCase().startsWith('xn--')) {
      // Punycode: xn-- followed by alphanumeric and hyphens
      const punyRegex = /^xn--[a-zA-Z0-9-]+$/;
      if (!punyRegex.test(label)) {
        return false;
      }
    } else {
      // Standard or IDN label
      // Allow Unicode letters, digits, and hyphens
      // Cannot start or end with hyphen
      if (label.startsWith('-') || label.endsWith('-')) {
        return false;
      }
      
      // Unicode-aware check: letters (any script), digits, hyphens
      // Using Unicode property escapes for broad internationalization
      const idnLabelRegex = /^[\p{L}\p{N}][\p{L}\p{N}-]*[\p{L}\p{N}]$|^[\p{L}\p{N}]$/u;
      if (!idnLabelRegex.test(label)) {
        return false;
      }
    }
  }
  
  // TLD validation: last label must have at least 2 chars
  const tld = labels[labels.length - 1];
  if (tld.length < 2) {
    return false;
  }
  
  return true;
}

/**
 * Sanitize and normalize domain input
 * Note: Does NOT convert IDN to Punycode - WHMCS handles that internally
 */
function normalizeDomain(domain: string): string {
  return domain.toLowerCase().trim();
}

/**
 * Register domain tools
 */
export function registerDomainTools(
  server: McpServer,
  whmcsClient: WhmcsClient,
  logger: Logger,
  rateLimiter: RateLimiter
): void {
  
  // ============================================
  // Tool: check_domain_availability
  // ============================================
  if (isToolAllowed('check_domain_availability')) {
    server.tool(
      'check_domain_availability',
      `Check if a domain is available for registration. Version: ${TOOL_VERSION}`,
      checkDomainSchema.shape,
      async (params) => {
        const toolLogger = logger.child();
        const startTime = Date.now();
        
        try {
          toolLogger.logToolCall('check_domain_availability', params, false);
          
          if (!rateLimiter.tryConsume()) {
            throw new RateLimitError();
          }
          
          // Normalize and validate domain format
          const domain = normalizeDomain(params.domain);
          
          if (!isValidDomainFormat(domain)) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  isError: true,
                  error: `Invalid domain format: '${domain}'. Expected format: 'example.com' or 'sub.example.com'`,
                  suggestion: 'Domain must contain only letters, numbers, hyphens, and a valid TLD (e.g., .com, .net, .org)',
                }),
              }],
              isError: true,
            };
          }
          
          const result = await whmcsClient.read<{
            result: string;
            status?: string;
            whois?: string;
          }>('DomainWhois', {
            domain,
          });
          
          let status: 'available' | 'unavailable' | 'unknown' = 'unknown';
          let reason: string | undefined;
          
          // Parse WHMCS response
          if (result.status === 'available') {
            status = 'available';
          } else if (result.status === 'unavailable' || result.status === 'registered') {
            status = 'unavailable';
          } else if (result.result === 'error') {
            status = 'unknown';
            reason = 'WHOIS lookup failed. The TLD may not be configured or the registrar is unavailable.';
          }
          
          toolLogger.logToolResult('check_domain_availability', true, Date.now() - startTime);
          
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                domain: params.domain,
                status,
                raw_status: result.status || result.result,
                reason,
              }),
            }],
          };
          
        } catch (error) {
          toolLogger.logToolResult('check_domain_availability', false, Date.now() - startTime,
            error instanceof Error ? error.message : String(error));
          
          if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: error.message }) }],
              isError: true,
            };
          }
          
          throw error;
        }
      }
    );
  }
  
  // ============================================
  // Tool: register_domain
  // ============================================
  if (isToolAllowed('register_domain')) {
    const registerDomainSchema = z.object({
      domainid: z.number().int().positive('Domain ID must be positive'),
      nameserver1: z.string().optional(),
      nameserver2: z.string().optional(),
      nameserver3: z.string().optional(),
      nameserver4: z.string().optional(),
    });
    
    server.tool(
      'register_domain',
      `Register a domain with the registrar. Requires domain to be in Pending status. Version: ${TOOL_VERSION}`,
      registerDomainSchema.shape,
      async (params) => {
        const toolLogger = logger.child();
        const startTime = Date.now();
        
        try {
          toolLogger.logToolCall('register_domain', params, true);
          
          if (!rateLimiter.tryConsume()) {
            throw new RateLimitError();
          }
          
          if (whmcsClient.isReadOnly()) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: 'Tool not available in read_only mode' }) }],
              isError: true,
            };
          }
          
          const result = await whmcsClient.mutate<{
            result: string;
            message?: string;
            domainid?: number;
          }>('ModuleCreate', {
            domainid: params.domainid,
            ns1: params.nameserver1,
            ns2: params.nameserver2,
            ns3: params.nameserver3,
            ns4: params.nameserver4,
          });
          
          toolLogger.logToolResult('register_domain', result.result === 'success', Date.now() - startTime);
          
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                domainid: params.domainid,
                success: result.result === 'success',
                message: result.message || (result.result === 'success' ? 'Domain registered successfully' : 'Registration failed'),
              }),
            }],
          };
          
        } catch (error) {
          toolLogger.logToolResult('register_domain', false, Date.now() - startTime,
            error instanceof Error ? error.message : String(error));
          
          if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: error.message }) }],
              isError: true,
            };
          }
          
          throw error;
        }
      }
    );
  }
  
  // ============================================
  // Tool: renew_domain
  // ============================================
  if (isToolAllowed('renew_domain')) {
    const renewDomainSchema = z.object({
      domainid: z.number().int().positive('Domain ID must be positive'),
    });
    
    server.tool(
      'renew_domain',
      `Renew a domain with the registrar. The domain must be active and eligible for renewal. Version: ${TOOL_VERSION}`,
      renewDomainSchema.shape,
      async (params) => {
        const toolLogger = logger.child();
        const startTime = Date.now();
        
        try {
          toolLogger.logToolCall('renew_domain', params, true);
          
          if (!rateLimiter.tryConsume()) {
            throw new RateLimitError();
          }
          
          if (whmcsClient.isReadOnly()) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: 'Tool not available in read_only mode' }) }],
              isError: true,
            };
          }
          
          const result = await whmcsClient.mutate<{
            result: string;
            message?: string;
          }>('ModuleRenew', {
            domainid: params.domainid,
          });
          
          toolLogger.logToolResult('renew_domain', result.result === 'success', Date.now() - startTime);
          
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                domainid: params.domainid,
                success: result.result === 'success',
                message: result.message || (result.result === 'success' ? 'Domain renewed successfully' : 'Renewal failed'),
              }),
            }],
          };
          
        } catch (error) {
          toolLogger.logToolResult('renew_domain', false, Date.now() - startTime,
            error instanceof Error ? error.message : String(error));
          
          if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: error.message }) }],
              isError: true,
            };
          }
          
          throw error;
        }
      }
    );
  }
  
  // ============================================
  // Tool: transfer_domain
  // ============================================
  if (isToolAllowed('transfer_domain')) {
    const transferDomainSchema = z.object({
      domainid: z.number().int().positive('Domain ID must be positive'),
      eppcode: z.string().optional().describe('EPP/Authorization code for transfer'),
    });
    
    server.tool(
      'transfer_domain',
      `Initiate a domain transfer from another registrar. Requires valid EPP code for most TLDs. Version: ${TOOL_VERSION}`,
      transferDomainSchema.shape,
      async (params) => {
        const toolLogger = logger.child();
        const startTime = Date.now();
        
        try {
          toolLogger.logToolCall('transfer_domain', params, true);
          
          if (!rateLimiter.tryConsume()) {
            throw new RateLimitError();
          }
          
          if (whmcsClient.isReadOnly()) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: 'Tool not available in read_only mode' }) }],
              isError: true,
            };
          }
          
          const result = await whmcsClient.mutate<{
            result: string;
            message?: string;
          }>('ModuleTransfer', {
            domainid: params.domainid,
            eppcode: params.eppcode,
          });
          
          toolLogger.logToolResult('transfer_domain', result.result === 'success', Date.now() - startTime);
          
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                domainid: params.domainid,
                success: result.result === 'success',
                message: result.message || (result.result === 'success' ? 'Transfer initiated' : 'Transfer failed'),
                warning: 'Domain transfers may take several days to complete depending on registrar policies.',
              }),
            }],
          };
          
        } catch (error) {
          toolLogger.logToolResult('transfer_domain', false, Date.now() - startTime,
            error instanceof Error ? error.message : String(error));
          
          if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: error.message }) }],
              isError: true,
            };
          }
          
          throw error;
        }
      }
    );
  }
  
  // ============================================
  // Tool: sync_domain
  // ============================================
  if (isToolAllowed('sync_domain')) {
    const syncDomainSchema = z.object({
      domainid: z.number().int().positive('Domain ID must be positive'),
    });
    
    server.tool(
      'sync_domain',
      `Sync domain status and expiry date with the registrar. Useful for ensuring WHMCS data matches registrar data. Version: ${TOOL_VERSION}`,
      syncDomainSchema.shape,
      async (params) => {
        const toolLogger = logger.child();
        const startTime = Date.now();
        
        try {
          toolLogger.logToolCall('sync_domain', params, false);
          
          if (!rateLimiter.tryConsume()) {
            throw new RateLimitError();
          }
          
          const result = await whmcsClient.read<{
            result: string;
            expirydate?: string;
            active?: string;
            message?: string;
          }>('ModuleSync', {
            domainid: params.domainid,
          });
          
          toolLogger.logToolResult('sync_domain', result.result === 'success', Date.now() - startTime);
          
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                domainid: params.domainid,
                success: result.result === 'success',
                expiry_date: result.expirydate,
                active: result.active === '1' || result.active === 'true',
                message: result.message || 'Domain synced',
              }),
            }],
          };
          
        } catch (error) {
          toolLogger.logToolResult('sync_domain', false, Date.now() - startTime,
            error instanceof Error ? error.message : String(error));
          
          if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: error.message }) }],
              isError: true,
            };
          }
          
          throw error;
        }
      }
    );
  }
}
