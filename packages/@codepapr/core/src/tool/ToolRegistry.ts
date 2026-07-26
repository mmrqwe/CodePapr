/**
 * ToolRegistry: 工具注册中心 (冻结后不可修改，保证缓存一致性)
 */

import { IToolDefinition, CacheConsistencyError } from '@codepapr/types';
import { sha256, deepFreeze, Logger } from '@codepapr/common';
import { Serializer } from '../cache/Serializer';

const log = new Logger('ToolRegistry');

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

export class ToolRegistry {
  private tools: Map<string, IToolDefinition> = new Map();
  private handlers: Map<string, ToolHandler> = new Map();
  private frozen: boolean = false;
  private frozenHash: string | null = null;

  register(tool: IToolDefinition, handler: ToolHandler): void {
    if (this.frozen) {
      throw new CacheConsistencyError(
        `Cannot register tool "${tool.name}" after registry is frozen`
      );
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" already registered`);
    }
    this.tools.set(tool.name, deepFreeze({ ...tool }));
    this.handlers.set(tool.name, handler);
    log.debug(`Tool registered: ${tool.name}`);
  }

  freeze(): string {
    if (this.frozen) return this.frozenHash!;
    this.frozen = true;
    this.frozenHash = this.computeHash();
    Object.freeze(this.tools);
    log.info(`ToolRegistry frozen with ${this.tools.size} tools, hash=${this.frozenHash.slice(0, 12)}`);
    return this.frozenHash;
  }

  isFrozen(): boolean {
    return this.frozen;
  }

  getHash(): string {
    return this.frozenHash ?? this.computeHash();
  }

  private computeHash(): string {
    const sorted = [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
    return sha256(Serializer.stringify(sorted));
  }

  getAll(): IToolDefinition[] {
    return [...this.tools.values()];
  }

  get(name: string): IToolDefinition | undefined {
    return this.tools.get(name);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`No handler for tool: ${name}`);
    return await handler(args);
  }

  hideFromLlm(name: string): void {
    if (this.frozen) throw new CacheConsistencyError(`Cannot hide tool "${name}" after registry is frozen`);
    this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  validateUnchanged(expectedHash: string): void {
    const current = this.computeHash();
    if (current !== expectedHash) {
      throw new CacheConsistencyError(
        `Tool registry modified! Expected hash ${expectedHash.slice(0, 12)}, got ${current.slice(0, 12)}`
      );
    }
  }
}

/**
 * 注册时按谓词过滤的 ToolRegistry：不满足谓词的工具被静默跳过（既不进入工具集，也不注册 handler）。
 * 用于 ask/plan 等只读模式对变更类工具的硬拦截。
 */
export class FilteringToolRegistry extends ToolRegistry {
  constructor(private readonly allowPredicate: (tool: IToolDefinition) => boolean) {
    super();
  }

  register(tool: IToolDefinition, handler: ToolHandler): void {
    if (!this.allowPredicate(tool)) return;
    super.register(tool, handler);
  }
}
