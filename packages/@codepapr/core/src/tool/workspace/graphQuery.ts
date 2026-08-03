/**
 * ProjectGraph 查询能力的公共出口。
 *
 * 实现按查询域拆分在 ./graph/ 子目录：
 * - symbolLookup       符号查找
 * - dependency         依赖子图 / 变更影响 / 实现查找
 * - overview           入口点 / 智能上下文
 * - rename             重命名规划与内容编辑
 * - circularDeps       循环依赖检测
 * - deadCode           死代码检测
 * - typeHierarchy      类型继承层级
 * - testDiscovery      测试发现与映射
 * - refactorSuggestions 重构建议（方法提取 / 符号独立成文件）
 * - testImpact         基于变更影响的测试选择
 * - architecture       架构分层检查
 * - semanticDiff       语义级图 diff
 * - testGeneration     测试骨架生成（基础 + 智能）
 * - refactorPlans      重构执行计划（提取方法 / 移动符号 / 内联变量）
 * - incrementalUpdate  图的增量更新
 *
 * 共享 helper（graphUtils / graphSymbols / graphTraversal / codeMetrics）
 * 仅供内部使用，不从此 barrel 导出。
 */

export * from './graph/symbolLookup';
export * from './graph/dependency';
export * from './graph/overview';
export * from './graph/rename';
export * from './graph/circularDeps';
export * from './graph/deadCode';
export * from './graph/typeHierarchy';
export * from './graph/testDiscovery';
export * from './graph/refactorSuggestions';
export * from './graph/testImpact';
export * from './graph/architecture';
export * from './graph/semanticDiff';
export * from './graph/testGeneration';
export * from './graph/refactorPlans';
export * from './graph/incrementalUpdate';
