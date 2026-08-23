import { describe, expect, it } from 'vitest';
import {
  deepFreeze,
  errorMessage,
  estimateTokens,
  generateUUID,
  getByteLength,
  isValidMessage,
  isValidToolDefinition,
  sha256,
  sortedStringify,
} from '../src/index';

describe('common foundation utilities', () => {
  describe('errorMessage', () => {
    it('extracts message from Error instances', () => {
      expect(errorMessage(new Error('fail'))).toBe('fail');
    });

    it('returns raw string for string errors', () => {
      expect(errorMessage('Tauri IPC rejected')).toBe('Tauri IPC rejected');
    });

    it('stringifies numbers, booleans, and nullish objects', () => {
      expect(errorMessage(404)).toBe('404');
      expect(errorMessage(null)).toBe('null');
      expect(errorMessage(undefined)).toBe('undefined');
    });
  });

  describe('sha256', () => {
    it('computes deterministic SHA256 hex string', () => {
      const hash1 = sha256('hello world');
      const hash2 = sha256('hello world');
      expect(hash1).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
      expect(hash1).toBe(hash2);
    });

    it('hashes empty string correctly', () => {
      expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });
  });

  describe('sortedStringify', () => {
    it('sorts keys recursively for consistent cache keys', () => {
      const obj1 = { z: 1, a: 2, m: { b: 3, a: 4 } };
      const obj2 = { a: 2, m: { a: 4, b: 3 }, z: 1 };
      expect(sortedStringify(obj1)).toBe(sortedStringify(obj2));
      expect(sortedStringify(obj1)).toBe('{"a":2,"m":{"a":4,"b":3},"z":1}');
    });

    it('preserves array order without sorting array items', () => {
      const obj = { list: [3, 1, 2] };
      expect(sortedStringify(obj)).toBe('{"list":[3,1,2]}');
    });
  });

  describe('deepFreeze', () => {
    it('freezes objects at all depth levels', () => {
      const nested = { a: { b: { c: 1 } } };
      deepFreeze(nested);
      expect(Object.isFrozen(nested)).toBe(true);
      expect(Object.isFrozen(nested.a)).toBe(true);
      expect(Object.isFrozen(nested.a.b)).toBe(true);
    });
  });

  describe('generateUUID', () => {
    it('generates valid UUID v4 string', () => {
      const uuid = generateUUID();
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('generates distinct UUIDs', () => {
      const ids = new Set(Array.from({ length: 50 }, () => generateUUID()));
      expect(ids.size).toBe(50);
    });
  });

  describe('isValidMessage', () => {
    it('validates compliant message objects', () => {
      expect(isValidMessage({
        id: 'msg-1',
        role: 'user',
        content: 'hello',
        timestamp: 1234567890,
      })).toBe(true);
    });

    it('rejects invalid roles or missing fields', () => {
      expect(isValidMessage(null)).toBe(false);
      expect(isValidMessage({ id: '1', role: 'unknown', content: '', timestamp: 0 })).toBe(false);
      expect(isValidMessage({ id: '1', role: 'user', content: 123, timestamp: 0 })).toBe(false);
      expect(isValidMessage({ id: '1', role: 'user', content: '' })).toBe(false);
    });
  });

  describe('isValidToolDefinition', () => {
    it('validates compliant tool definitions', () => {
      expect(isValidToolDefinition({
        name: 'read',
        description: 'Read file',
        parameters: { type: 'object', properties: {} },
      })).toBe(true);
    });

    it('rejects incomplete definitions', () => {
      expect(isValidToolDefinition(null)).toBe(false);
      expect(isValidToolDefinition({ name: 'read' })).toBe(false);
      expect(isValidToolDefinition({ name: 'read', description: 123, parameters: {} })).toBe(false);
    });
  });

  describe('getByteLength & estimateTokens', () => {
    it('calculates UTF-8 byte length correctly', () => {
      expect(getByteLength('abc')).toBe(3);
      expect(getByteLength('中文')).toBe(6);
    });

    it('estimates tokens with 4 bytes / token heuristic', () => {
      expect(estimateTokens('1234')).toBe(1);
      expect(estimateTokens('12345')).toBe(2);
      expect(estimateTokens('')).toBe(0);
    });
  });
});
