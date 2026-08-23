/**
 * 动态内容检测的统一模式表。
 *
 * 缓存一致性的两道关卡必须共用这份表，防止语义漂移：
 *  - `@codepapr/core` 的 `ImmutablePrefix.validateStaticContent`（构造期抛错，硬关卡）
 *  - `@codepapr/editor` 的 `validateStaticPrompt`（UI 编辑期警告，软关卡）
 *
 * 注意：所有正则都不带 `g` 标志——调用方以 `.test()`/`.match()` 做一次性匹配，
 * 全局标志的 `lastIndex` 副作用会让重复调用出现真假交替。
 */

export interface StaticContentPattern {
  re: RegExp;
  /** 人类可读名称，用于错误/警告消息 */
  name: string;
}

export const STATIC_CONTENT_FORBIDDEN_PATTERNS: readonly StaticContentPattern[] = [
  { re: /\$\{[^}]+\}/, name: '${var} 模板' },
  { re: /{{[^}]+}}/, name: '{{var}} 模板' },
  { re: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, name: 'ISO 时间戳' },
  { re: /\[TIMESTAMP\]/i, name: '[TIMESTAMP] 占位符' },
  { re: /\[SESSION/i, name: '[SESSION...] 占位符' },
  { re: /\[TIME/i, name: '[TIME...] 占位符' },
  { re: /\[DATE/i, name: '[DATE...] 占位符' },
  { re: /\[RANDOM/i, name: '[RANDOM...] 占位符' },
];
