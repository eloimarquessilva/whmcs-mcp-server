/**
 * Unit tests for core infrastructure modules
 * 
 * These tests don't require a live WHMCS connection.
 */

import { describe, it, expect } from 'vitest';
import { normalizeToArray, boolToWhmcs, whmcsToBool, parseNumber } from '../src/whmcs/normalizers.js';

describe('normalizers', () => {
  describe('normalizeToArray', () => {
    it('should return empty array for undefined', () => {
      expect(normalizeToArray(undefined)).toEqual([]);
    });
    
    it('should return empty array for null', () => {
      expect(normalizeToArray(null)).toEqual([]);
    });
    
    it('should return empty array for empty object', () => {
      expect(normalizeToArray({})).toEqual([]);
    });
    
    it('should pass through existing arrays', () => {
      const arr = [{ id: 1 }, { id: 2 }];
      expect(normalizeToArray(arr)).toEqual(arr);
    });
    
    it('should convert numeric-keyed objects to arrays', () => {
      const numericKeyed = { '0': { id: 1 }, '1': { id: 2 } };
      expect(normalizeToArray(numericKeyed)).toEqual([{ id: 1 }, { id: 2 }]);
    });
  });
  
  describe('boolToWhmcs', () => {
    it('should convert true to 1 (default format)', () => {
      expect(boolToWhmcs(true)).toBe(1);
    });
    
    it('should convert false to 0 (default format)', () => {
      expect(boolToWhmcs(false)).toBe(0);
    });
    
    it('should support truefalse format', () => {
      expect(boolToWhmcs(true, 'truefalse')).toBe('true');
      expect(boolToWhmcs(false, 'truefalse')).toBe('false');
    });
    
    it('should support onoff format', () => {
      expect(boolToWhmcs(true, 'onoff')).toBe('on');
      expect(boolToWhmcs(false, 'onoff')).toBe('off');
    });
  });
  
  describe('whmcsToBool', () => {
    it('should parse "1" as true', () => {
      expect(whmcsToBool('1')).toBe(true);
    });
    
    it('should parse "0" as false', () => {
      expect(whmcsToBool('0')).toBe(false);
    });
    
    it('should parse "true" as true', () => {
      expect(whmcsToBool('true')).toBe(true);
    });
    
    it('should parse "false" as false', () => {
      expect(whmcsToBool('false')).toBe(false);
    });
    
    it('should pass through boolean values', () => {
      expect(whmcsToBool(true)).toBe(true);
      expect(whmcsToBool(false)).toBe(false);
    });
    
    it('should handle number 0 as false', () => {
      expect(whmcsToBool(0)).toBe(false);
    });
    
    it('should handle non-zero numbers as true', () => {
      expect(whmcsToBool(1)).toBe(true);
      expect(whmcsToBool(42)).toBe(true);
    });
  });
  
  describe('parseNumber', () => {
    it('should parse string numbers', () => {
      expect(parseNumber('123')).toBe(123);
      expect(parseNumber('45.67')).toBe(45.67);
    });
    
    it('should pass through numbers', () => {
      expect(parseNumber(42)).toBe(42);
    });
    
    it('should return 0 for invalid strings', () => {
      expect(parseNumber('not a number')).toBe(0);
    });
    
    it('should use default for undefined', () => {
      expect(parseNumber(undefined, 99)).toBe(99);
    });
  });
});
