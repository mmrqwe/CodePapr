/**
 * VolatileScratch: Temporary volatile memory
 *
 * Core invariant: This data NEVER participates in API serialization.
 * - Stores model thinking, intermediate plans, notes
 * - Reset at the start of each round
 * - toJSON() returns null (prevents accidental serialization)
 * - Never affects cache consistency
 */

import { IVolatileScratch } from '@codepapr/types';

export class VolatileScratch implements IVolatileScratch {
  private thinking: string = '';
  private intermediatePlans: string[] = [];
  private notes: Map<string, unknown> = new Map();
  private lastRoundData: Record<string, unknown> = {};
  private roundStartTime: number = 0;

  /**
   * Set thinking process
   */
  setThinking(content: string): void {
    this.thinking = content;
  }

  /**
   * Add intermediate planning step
   */
  addIntermediatePlan(step: string): void {
    const timestamp = new Date().toISOString();
    this.intermediatePlans.push(`[${timestamp}] ${step}`);
  }

  /**
   * Add note
   */
  addNote(key: string, value: unknown): void {
    this.notes.set(key, value);
  }

  /**
   * Get thinking
   */
  getThinking(): string {
    return this.thinking;
  }

  /**
   * Get all plans
   */
  getIntermediatePlans(): string[] {
    return [...this.intermediatePlans];
  }

  /**
   * Get note
   */
  getNote(key: string): unknown | undefined {
    return this.notes.get(key);
  }

  /**
   * Get all scratch data
   */
  getAll(): Record<string, unknown> {
    return {
      thinking: this.thinking,
      plans: [...this.intermediatePlans],
      notes: Object.fromEntries(this.notes),
    };
  }

  /**
   * Reset all scratch data
   */
  reset(): void {
    this.thinking = '';
    this.intermediatePlans = [];
    this.notes.clear();
    this.lastRoundData = {};
    this.roundStartTime = 0;
  }

  /**
   * Mark start of round
   */
  markRoundStart(): void {
    this.roundStartTime = Date.now();
  }

  /**
   * Mark end of round and save data
   */
  markRoundEnd(): void {
    this.lastRoundData = {
      thinking: this.thinking,
      plans: [...this.intermediatePlans],
      notes: Object.fromEntries(this.notes),
      duration: Date.now() - this.roundStartTime,
    };
  }

  /**
   * Get data from last round
   */
  getLastRoundData(): Record<string, unknown> {
    return this.lastRoundData;
  }

  /**
   * CRITICAL: Return null to prevent serialization
   * This ensures volatile scratch NEVER affects API requests or cache
   */
  toJSON(): null {
    return null;
  }
}
