import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * paper-light 主题靠 index.css 的 `:root[data-theme="paper-light"]` 覆盖层
 * 把硬编码深色类重映射成浅色（Phase 3 组件迁移前的过渡补丁）。
 * 授权相关面板曾因类名漏在覆盖清单外，出现"浅色主题下发黑、看不清字"。
 * 这些测试保证：授权面板用到的每个深色类都有对应的浅色覆盖规则。
 */

const SRC_DIR = __dirname;
const indexCss = readFileSync(join(SRC_DIR, '..', 'index.css'), 'utf-8');

const THEME_SCOPE = ':root[data-theme="paper-light"]';

/** 解析 index.css 中所有 :root[data-theme="paper-light"] 选择器，产出 (类名匹配器) 列表。 */
function parseLightThemeMatchers(css: string): Array<(className: string) => boolean> {
  const matchers: Array<(className: string) => boolean> = [];
  const escapedScope = THEME_SCOPE.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&');
  const ruleRegex = new RegExp(`${escapedScope}\\s+([^{]+)\\{`, 'g');
  let rule: RegExpExecArray | null;
  while ((rule = ruleRegex.exec(css)) !== null) {
    for (const rawSelector of rule[1].split(',')) {
      // 多选择器规则里每个片段都可能自带主题作用域前缀
      const selector = rawSelector
        .trim()
        .replace(new RegExp(`^${escapedScope}\\s*`), '')
        .trim();
      const exact = selector.match(/^\.((?:[^.\\\s]|\\.)+)$/);
      if (exact) {
        const unescaped = exact[1].replace(/\\(.)/g, '$1');
        matchers.push((className) => className === unescaped);
        continue;
      }
      const substring = selector.match(/\[class\*="([^"]+)"\]/);
      if (substring) {
        const needle = substring[1];
        matchers.push((className) => className.includes(needle));
      }
    }
  }
  return matchers;
}

function isCovered(matchers: Array<(className: string) => boolean>, className: string): boolean {
  return matchers.some((matches) => matches(className));
}

const matchers = parseLightThemeMatchers(indexCss);

describe('light theme coverage for authorization panels', () => {
  it('index.css has parseable :root[data-theme="paper-light"] override rules', () => {
    expect(matchers.length).toBeGreaterThan(50);
  });

  it('covers every dark hex background/border used by PermissionDialog and AppPermissionsTab', () => {
    for (const file of ['PermissionDialog.tsx', 'AppPermissionsTab.tsx']) {
      const source = readFileSync(join(SRC_DIR, file), 'utf-8');
      const hexClasses = new Set(
        [...source.matchAll(/(?:bg|border)-\[#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\]/g)].map(
          (m) => m[0],
        ),
      );
      expect(hexClasses.size).toBeGreaterThan(0);
      for (const className of hexClasses) {
        expect(isCovered(matchers, className), `${file} 的 ${className} 缺少浅色覆盖`).toBe(true);
      }
    }
  });

  it.each([
    // PermissionDialog（外部文件访问授权弹窗）
    'bg-black/70',
    'bg-[#161922]',
    'bg-[#0d0f15]',
    'border-[#2a2d3a]',
    'text-slate-200',
    'text-slate-300',
    'text-slate-400',
    'text-cyan-400',
    'text-cyan-300',
    'bg-cyan-600/20',
    'border-cyan-500/30',
    // AppPermissionsTab（设置 → App 权限管理）
    'bg-[#11141c]',
    'bg-[#0f1117]',
    'bg-[#2a2d3a]',
    'text-slate-500',
    'text-slate-600',
    'text-indigo-200',
    'bg-indigo-500/15',
    'border-indigo-500/50',
    'border-amber-500/20',
    'bg-amber-500/5',
    'text-amber-200',
    'text-amber-400',
    'text-sky-400',
    'text-red-400',
    // SettingsModal 文件夹访问授权（YOLO）区
    'bg-amber-950/10',
    'text-amber-100/70',
    'text-amber-400/80',
  ])('overrides %s in light theme', (className) => {
    expect(isCovered(matchers, className)).toBe(true);
  });
});
