/**
 * ToolRegistry: 工具注册中心 (冻结后不可修改，保证缓存一致性)
 */

import { IToolDefinition, CacheConsistencyError, AppSandboxAccess } from '@codepapr/types';
import { sha256, deepFreeze, Logger } from '@codepapr/common';
import { Serializer } from '../cache/Serializer';

const log = new Logger('ToolRegistry');

export interface ToolExecutionContext {
  /** The assistant tool-call id this execution fulfills. Lets the worker bridge
   *  match a tool-request to its pending call by id (robust even for concurrent
   *  identical calls) instead of by name+arguments. */
  toolCallId?: string;
  /** 取消通道：主会话取消或工具超时（Agent 的 withTimeout）都会 abort 此
   *  signal。长耗时工具（bash/task 等）必须监听它并停止正在进行的副作用，
   *  否则超时/取消后工具仍在后台继续执行。 */
  signal?: AbortSignal;
  /** app agent（papr.agent.run）专属：该 app 的两轴访问档，bash 等工具按此构建沙箱。 */
  appAccess?: AppSandboxAccess;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  context?: ToolExecutionContext
) => Promise<unknown> | unknown;

export class ToolRegistry {
  private tools: Map<string, IToolDefinition> = new Map();
  private handlers: Map<string, ToolHandler> = new Map();
  private llmHiddenTools: Set<string> = new Set();
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

  /**
   * 仅返回对主代理 LLM 可见的工具：排除被 hideFromLlm（已删除）与 softHideFromLlm（软隐藏）的工具。
   * 用于构建主代理的工具集；子代理白名单过滤仍用 getAll()，可选取软隐藏的工具（如 graph）。
   */
  getLlmTools(): IToolDefinition[] {
    if (this.llmHiddenTools.size === 0) return [...this.tools.values()];
    return [...this.tools.values()].filter((tool) => !this.llmHiddenTools.has(tool.name));
  }

  get(name: string): IToolDefinition | undefined {
    return this.tools.get(name);
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContext
  ): Promise<unknown> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`No handler for tool: ${name}`);
    return await handler(args, context);
  }

  hideFromLlm(name: string): void {
    if (this.frozen) throw new CacheConsistencyError(`Cannot hide tool "${name}" after registry is frozen`);
    this.tools.delete(name);
  }

  /**
   * 彻底移除：定义与 handler 都删除（LLM 既看不到也调不动）。用于极简工具面
   * 对顶层可见工具的物理裁剪——与 hideFromLlm（保留 handler 供内部 dispatch）
   * 不同，被移除工具的幻觉调用会在 execute 处报 unknown tool。
   */
  unregister(name: string): void {
    if (this.frozen) throw new CacheConsistencyError(`Cannot unregister tool "${name}" after registry is frozen`);
    this.tools.delete(name);
    this.handlers.delete(name);
    this.llmHiddenTools.delete(name);
  }

  /**
   * 软隐藏：工具定义与 handler 均保留（getAll()/execute() 仍可用，供子代理白名单选取与执行），
   * 但从主代理的 getLlmTools() 中排除。用于 graph——主代理不可见，子代理（如 Explore）可选取。
   */
  softHideFromLlm(name: string): void {
    if (this.frozen) throw new CacheConsistencyError(`Cannot hide tool "${name}" after registry is frozen`);
    this.llmHiddenTools.add(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** handler 是否已注册（不受 hideFromLlm 移除 LLM 可见性的影响）。 */
  hasHandler(name: string): boolean {
    return this.handlers.has(name);
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
 * 谓词带可选 args：注册期 args===undefined（按名字决策，决定 LLM 可见性），
 * 执行期带真实 args 二次校验（支持 git 这类"整体变更、部分 action 只读"的细粒度放行）。
 */
export class FilteringToolRegistry extends ToolRegistry {
  constructor(
    private readonly allowPredicate: (tool: IToolDefinition, args?: Record<string, unknown>) => boolean,
    private readonly blockMessage?: (tool: IToolDefinition, args?: Record<string, unknown>) => string
  ) {
    super();
  }

  register(tool: IToolDefinition, handler: ToolHandler): void {
    if (!this.allowPredicate(tool)) return;
    super.register(tool, handler);
  }

  /**
   * 执行期二次校验（带 args）：支持按参数细粒度放行的工具（如 ask 模式下
   * git 仅允许 status/diff/log）。注册期放行、执行期拒绝的工具会在这里抛出
   * blockMessage（默认给出只读模式通用文案）。
   */
  override async execute(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContext
  ): Promise<unknown> {
    const def = this.get(name);
    if (def && !this.allowPredicate(def, args)) {
      throw new Error(this.blockMessage?.(def, args) ?? `只读模式：工具 ${name} 当前模式不可用。`);
    }
    return await super.execute(name, args, context);
  }
}
