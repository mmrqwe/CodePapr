/**
 * Serializer: Deterministic JSON serialization for cache consistency
 *
 * This is the FOUNDATION of cache consistency.
 * All objects must be serialized with sorted keys to ensure:
 * - Same input → Same bytes → Same hash
 * - No environment-dependent key ordering variations
 */

import { sortedStringify } from '@codepapr/common';

export class Serializer {
  /**
   * Deterministic stringify with sorted keys
   * Critical: This ensures byte-level consistency across runs
   */
  static stringify(obj: unknown, space?: number): string {
    return sortedStringify(obj, space);
  }

  /**
   * Parse JSON (standard)
   */
  static parse<T = unknown>(json: string): T {
    return JSON.parse(json) as T;
  }

  /**
   * Create canonical form - deterministically ordered
   * Use this before hashing to ensure consistency
   */
  static canonical(obj: unknown): unknown {
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.canonical(item));
    }

    const result: Record<string, unknown> = {};
    Object.keys(obj as Record<string, unknown>)
      .sort()
      .forEach((key) => {
        result[key] = this.canonical((obj as Record<string, unknown>)[key]);
      });

    return result;
  }

  /**
   * Get byte length of serialized string (for token estimation)
   */
  static getByteLength(obj: unknown): number {
    const str = this.stringify(obj);
    return new TextEncoder().encode(str).length;
  }
}
