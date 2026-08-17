/**
 * v2 checkpoint payload fixtures（真实形状）与期望的 v3 迁移结果（PR0）。
 *
 * 形状与 contextCompaction.ts 的 ContextCheckpointPayload 对齐；
 * 这些 fixture 同时是 PR3 接线的输入样例。
 */

import type { ContextCheckpointPayload } from './contextCompaction';
import type { ContextCheckpointPayloadV3 } from './contextCheckpointState';

/** 完整 v2 payload：所有 section 有值，覆盖 importantContext / validationNotes 拆分。 */
export const fullV2Payload: ContextCheckpointPayload = {
  version: 2,
  summary: '修复 OAuth state 比较问题',
  renderedContent: '[摘要] 修复 OAuth state 比较问题',
  sourceMessageCount: 18,
  sourceChars: 12_340,
  generatedAt: 1_750_000_000_000,
  modelName: 'deepseek-chat',
  modelTier: 'fast',
  sections: {
    userGoal: ['修复 OAuth callback state mismatch'],
    constraints: ['必须保持向后兼容', '不要改 public API'],
    completedWork: ['定位到 refresh.ts 与 redirect.ts 未共享 state parser'],
    importantContext: [
      'auth 测试已通过 pnpm test auth',
      'src/auth/state.ts 是唯一 state parser',
      '历史上 OAuth 曾因时钟漂移失败',
      '旧代码里出现过 hardcoded secret 但已被清理',
    ],
    assumptions: ['假设 state 参数总是 URL 编码'],
    validationNotes: [
      'pnpm test auth 全部通过',
      'CI 仍然有 flaky timeout 风险',
      '手动回归验证了 callback 流程',
    ],
    pendingWork: ['补充 redirect 端 normalize 逻辑'],
    openQuestions: ['是否需要在 v2 也打补丁？'],
    todoList: ['- [ ] 补测试', '← current 修复 state normalize'],
  },
  todoDigest: '## TodoList\n- [ ] 补测试\n← current 修复 state normalize',
};

export const expectedFullV3: ContextCheckpointPayloadV3 = {
  version: 3,
  summary: '修复 OAuth state 比较问题',
  renderedContent: '[摘要] 修复 OAuth state 比较问题',
  sourceMessageCount: 18,
  sourceChars: 12_340,
  generatedAt: 1_750_000_000_000,
  modelName: 'deepseek-chat',
  modelTier: 'fast',
  sections: fullV2Payload.sections,
  todoDigest: fullV2Payload.todoDigest,
  state: {
    goal: ['修复 OAuth callback state mismatch'],
    constraints: ['必须保持向后兼容', '不要改 public API'],
    confirmedFacts: [
      'auth 测试已通过 pnpm test auth',
      'src/auth/state.ts 是唯一 state parser',
      '历史上 OAuth 曾因时钟漂移失败',
    ],
    assumptions: ['假设 state 参数总是 URL 编码'],
    decisions: [],
    completedWork: ['定位到 refresh.ts 与 redirect.ts 未共享 state parser'],
    activeWork: ['补充 redirect 端 normalize 逻辑'],
    verification: ['pnpm test auth 全部通过', '手动回归验证了 callback 流程'],
    failuresAndRisks: ['CI 仍然有 flaky timeout 风险'],
    todos: ['- [ ] 补测试', '← current 修复 state normalize'],
    openQuestions: ['是否需要在 v2 也打补丁？'],
    references: ['旧代码里出现过 hardcoded secret 但已被清理'],
    provenance: [],
  },
  summaryInfo: { kind: 'llm', model: 'deepseek-chat' },
};

/** 本地 fallback 生成的 v2 payload（modelTier='local'）。 */
export const localV2Payload: ContextCheckpointPayload = {
  version: 2,
  summary: '本地规则压缩',
  renderedContent: '[摘要] 本地规则压缩',
  sourceMessageCount: 6,
  sourceChars: 2_000,
  generatedAt: 1_750_000_100_000,
  modelName: 'local-checkpoint',
  modelTier: 'local',
  sections: {
    userGoal: [],
    constraints: [],
    completedWork: [],
    importantContext: [],
    assumptions: [],
    validationNotes: [],
    pendingWork: [],
    openQuestions: [],
    todoList: [],
  },
};

/** 缺失 sections 的退化 payload（旧数据）。 */
export const legacyNoSectionsV2Payload: ContextCheckpointPayload = {
  version: 2,
  summary: '旧版无 sections 摘要',
  renderedContent: '[摘要] 旧版无 sections 摘要',
  sourceMessageCount: 3,
  sourceChars: 500,
  generatedAt: 1_749_999_000_000,
  modelName: 'legacy',
  modelTier: 'local',
};

export const expectedEmptyState = {
  goal: [],
  constraints: [],
  confirmedFacts: [],
  assumptions: [],
  decisions: [],
  completedWork: [],
  activeWork: [],
  verification: [],
  failuresAndRisks: [],
  todos: [],
  openQuestions: [],
  references: [],
  provenance: [],
};
