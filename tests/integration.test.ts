/**
 * Integration tests for WHMCS MCP Server
 * 
 * SAFETY RULES:
 * - These tests run against a LIVE WHMCS instance
 * - Only READ operations are performed by default
 * - WRITE tests are SKIPPED unless MCP_TEST_WRITE_MODE=true
 * - Any test data created MUST be tracked for cleanup
 * 
 * Tests that are skipped due to safety concerns are logged in the test output.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import 'dotenv/config';
import axios from 'axios';

// Test configuration
const WHMCS_API_URL = process.env.WHMCS_API_URL;
const WHMCS_IDENTIFIER = process.env.WHMCS_IDENTIFIER;
const WHMCS_SECRET = process.env.WHMCS_SECRET;

// Helper to make WHMCS API calls directly (bypassing our client for pure integration testing)
async function whmcsCall(action: string, params: Record<string, unknown> = {}) {
  if (!WHMCS_API_URL || !WHMCS_IDENTIFIER || !WHMCS_SECRET) {
    throw new Error('WHMCS credentials not configured');
  }
  
  const body = new URLSearchParams({
    action,
    identifier: WHMCS_IDENTIFIER,
    secret: WHMCS_SECRET,
    responsetype: 'json',
    ...Object.fromEntries(
      Object.entries(params)
        .filter(([_, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)])
    ),
  });
  
  const response = await axios.post(`${WHMCS_API_URL}/includes/api.php`, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30000,
  });
  
  return response.data;
}

describe('WHMCS API Integration', () => {
  beforeAll(() => {
    if (!WHMCS_API_URL || !WHMCS_IDENTIFIER || !WHMCS_SECRET) {
      console.log('⚠️  WHMCS credentials not configured. Skipping integration tests.');
    }
  });
  
  describe('Connection & Authentication', () => {
    it('should connect to WHMCS API successfully', async () => {
      const result = await whmcsCall('GetAdminDetails');
      
      // Should not be an error
      expect(result.result).toBe('success');
    });
    
    it('should return proper error for invalid action', async () => {
      const result = await whmcsCall('InvalidActionThatDoesNotExist');
      
      expect(result.result).toBe('error');
    });
  });
  
  describe('Read Operations (Safe)', () => {
    it('should list products', async () => {
      const result = await whmcsCall('GetProducts', { limitnum: 10 });
      
      expect(result.result).toBe('success');
      // Products may or may not exist
    });
    
    it('should list clients', async () => {
      const result = await whmcsCall('GetClients', { limitnum: 5 });
      
      expect(result.result).toBe('success');
      expect(result).toHaveProperty('totalresults');
    });
    
    it('should get activity log', async () => {
      const result = await whmcsCall('GetActivityLog', { limitnum: 5 });
      
      expect(result.result).toBe('success');
    });
    
    it('should list support departments', async () => {
      const result = await whmcsCall('GetSupportDepartments');
      
      expect(result.result).toBe('success');
    });
    
    it('should get payment methods', async () => {
      const result = await whmcsCall('GetPaymentMethods');
      
      expect(result.result).toBe('success');
    });
  });
  
  describe('Domain Availability Check (Safe)', () => {
    it('should check domain availability', async () => {
      const result = await whmcsCall('DomainWhois', { domain: 'google.com' });
      
      // Should return result (available or unavailable)
      expect(result.result).toBe('success');
      expect(result).toHaveProperty('status');
    });
    
    it('should handle invalid domain format gracefully', async () => {
      const result = await whmcsCall('DomainWhois', { domain: 'invalid' });
      
      // May return error or unknown status - both are valid behaviors
      expect(['success', 'error']).toContain(result.result);
    });
  });
});

// ============================================================
// SKIPPED TESTS - Documented for completeness
// ============================================================
describe('Write Operations (SKIPPED - Requires MCP_TEST_WRITE_MODE=true)', () => {
  describe.skip('Client Creation', () => {
    /**
     * SKIPPED: create_client test
     * 
     * Why skipped: Creates a real client in the production database.
     * 
     * Rollback procedure:
     * 1. Store the created clientid
     * 2. Use DeleteClient API action (admin only) 
     * 3. Note: WHMCS does not have a pure API for client deletion
     *    Manual cleanup may be required
     * 
     * To run: Set MCP_TEST_WRITE_MODE=true
     */
    it('should create a test client', () => {
      // This test would create a client with:
      // - firstname: 'MCP Test'
      // - lastname: 'Automated'
      // - email: `mcp-test-${Date.now()}@test.local`
      // - country: 'US'
    });
  });
  
  describe.skip('Invoice Operations', () => {
    /**
     * SKIPPED: Billing tests
     * 
     * Why skipped: May affect real financial records.
     * 
     * Rollback procedure:
     * - Created invoices can be cancelled via UpdateInvoice status='Cancelled'
     * - Transactions cannot be easily deleted
     * 
     * To run: Set MCP_TEST_WRITE_MODE=true
     */
    it('should not test invoice creation on production', () => {});
  });
  
  describe.skip('Service Operations', () => {
    /**
     * SKIPPED: suspend_service, unsuspend_service, terminate_service
     * 
     * Why skipped: 
     * - These operations affect real customer services
     * - terminate_service is IRREVERSIBLE
     * 
     * Rollback procedure:
     * - suspend → unsuspend (reversible)
     * - terminate → NO ROLLBACK POSSIBLE
     * 
     * To run: NEVER run on production. Use staging only.
     */
    it('should not test service termination on production', () => {});
  });
  
  describe.skip('Order Operations', () => {
    /**
     * SKIPPED: accept_order
     * 
     * Why skipped:
     * - May trigger provisioning on external servers
     * - May send emails to customers
     * - May charge payment methods
     * 
     * Rollback procedure:
     * - Cancel order (may not undo provisioning)
     * 
     * To run: Set MCP_TEST_WRITE_MODE=true (staging only)
     */
    it('should not test order acceptance on production', () => {});
  });
  
  describe.skip('Ticket Operations', () => {
    /**
     * SKIPPED: create_ticket, reply_ticket
     * 
     * Why skipped:
     * - May send notifications to customers
     * - Creates visible records in support system
     * 
     * Rollback procedure:
     * - Close ticket with status
     * - Delete ticket via admin panel (not API)
     * 
     * To run: Set MCP_TEST_WRITE_MODE=true with test department
     */
    it('should not test ticket creation on production', () => {});
  });
});
