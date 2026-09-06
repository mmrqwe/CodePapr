/**
 * L1 工具错误契约（tool feedback quality contracts）。
 *
 * 论文结论：错误信息必须「可定位、可理解、可行动」，否则 coding agent
 * 无法有效调试和收敛。本模块把这 3 个属性变成可回归的结构性断言：
 * 每条错误文案按契约检查是否包含定位信息、原因解释、下一步行动建议。
 * 文案改动若丢失任一要素，CI 立即红灯——防止未来重构悄悄劣化模型体验。
 *
 * 与 crates/codepapr-core/src/error_contract_tests.rs 配对：TS/UI 处理器与
 * Rust sidecar 是双执行宿主，同一工具的错误文案必须双侧各自满足契约。
 */

export interface ErrorContract {
  /** 定位：出错对象（文件路径/参数名/行号/补丁序号/命令段）可从文案辨认。 */
  locate?: RegExp[];
  /** 解释：为什么失败（原因/判定条件/实际值）。 */
  explain: RegExp[];
  /** 行动：模型下一步能做什么（可用值枚举/替代工具/修正动词）。 */
  action?: RegExp[];
}

export function assertErrorContract(message: string, contract: ErrorContract): void {
  const failures: string[] = [];
  const check = (label: keyof ErrorContract, patterns?: RegExp[]) => {
    for (const pattern of patterns ?? []) {
      if (!pattern.test(message)) {
        failures.push(`[${label}] 未命中 /${pattern.source}/`);
      }
    }
  };
  check('locate', contract.locate);
  check('explain', contract.explain);
  check('action', contract.action);
  if (failures.length > 0) {
    throw new Error(
      `错误文案契约失败:\n${failures.map((f) => `  ${f}`).join('\n')}\n实际文案: ${message}`
    );
  }
}

export function captureThrow(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('预期抛错但正常返回了');
}

export async function captureReject(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('预期 reject 但正常 resolve 了');
}

/** 合并工具面只暴露 read/write/edit/... 等名字，内部 workspace_* 名对模型隐藏。
 *  错误文案若引用内部名，模型按文案行动会直接 "tool not found"——违反可行动性。 */
export function assertNoHiddenToolNames(message: string): void {
  const leaked = message.match(/workspace_[a-z_]+|mcp__[A-Za-z0-9_]+/g);
  if (leaked) {
    throw new Error(
      `错误文案引用了对 LLM 隐藏的内部工具名: ${[...new Set(leaked)].join(', ')}\n实际文案: ${message}`
    );
  }
}
