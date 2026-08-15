// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 主题硬门槛：组件必须使用语义 token 类（bg-base/text-fg/border-line/accent 等），
 * 禁止硬编码深色主题专用色类。历史上这些硬编码类靠 index.css 的
 * `:root[data-theme="paper-light"]` 补丁层打补丁，新组件一旦漏加补丁就静默发黑。
 * 补丁层已删除，此测试从源头堵住回潮。
 *
 * 允许保留的例外：
 *  - 中性灰 chip（bg-slate-xxx、text-slate-700+、border-slate-600 等）：自洽深浅通用
 *  - 白/浅色 chip（任意家族的 50/100/200 底色与对应的 600/700 深色文字）：自洽
 *  - 装饰性家族色（purple/rose/blue/green/yellow/teal/orange/violet 等）：市场卡片徽章
 *  - text-white：仅允许出现在实色 accent/ok/warn/danger/info 按钮上（由例外规则校验）
 */

const SRC_DIR = join(__dirname, '..');

function collectFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__test-utils__') continue;
      files.push(...collectFiles(full));
    } else if (/\.(tsx|ts)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const files = collectFiles(SRC_DIR);

/** 每个文件的所有 className 值（含模板串片段）。 */
function extractClassStrings(source: string): string[] {
  const spans: string[] = [];
  const patterns = [
    /className="([^"]*)"/g,
    /className='([^']*)'/g,
    /className=\{`([^`]*)`\}/g,
    /className=\{([^{}]*)\}/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      spans.push(match[1]);
    }
  }
  return spans;
}

/** 禁止的主题专用类模式（带变体前缀与 /xx 透明度的任意组合）。 */
const FORBIDDEN = [
  /(?:^|[\s'"])(?:[a-z-]+:)*(?:bg|text|border|divide|ring|accent)-\[#[0-9a-fA-F]{3,8}\](?:\/[0-9]+)?(?:[\s'"]|$)/,
  // slate 仅禁浅色阶梯文本（白→中灰在浅色主题下不可读）；bg/border-slate-* 属自洽灰 chip，允许
  /(?:^|[\s'"])(?:[a-z-]+:)*text-slate-(?:50|[1-6]00)(?:\/[0-9]+)?(?:[\s'"]|$)/,
  /(?:^|[\s'"])(?:[a-z-]+:)*(?:text|bg|border)-(?:indigo|emerald|amber|cyan|sky|red)-[0-9]+(?:\/[0-9]+)?(?:[\s'"]|$)/,
  /(?:^|[\s'"])(?:[a-z-]+:)*bg-black(?:\/[0-9]+)?(?:[\s'"]|$)/,
  /(?:^|[\s'"])(?:[a-z-]+:)*text-white(?:[\s'"]|$)/,
];

/** 实色语义底（accent/ok/warn/danger/info）上的 text-white 属于设计意图，允许。 */
const SOLID_BG = /(?:^|[\s'"`])(?:hover:)?bg-(?:accent|ok|warn|danger|info)(?:[\s'"`]|$)/;

describe('theme hard gate: no hard-coded theme colors in components', () => {
  it('scans a representative set of source files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('component className strings use semantic tokens only', () => {
    const violations = new Set<string>();
    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      for (const span of extractClassStrings(source)) {
        // 整段按空白拆成独立 token 后逐个判定，避免模板片段误报
        for (const token of span.split(/\s+/)) {
          if (!token) continue;
          const hit = FORBIDDEN.find((re) => re.test(` ${token} `));
          if (!hit) continue;
          if (/^text-white$|^hover:text-white$/.test(token)) {
            if (SOLID_BG.test(span)) continue;
          }
          violations.add(`${file.replace(SRC_DIR + '/', '')}: ${token}`);
        }
      }
    }
    if (violations.size > 0) {
      throw new Error(
        `发现 ${violations.size} 处硬编码主题色类，请改用语义 token 类（bg-base/raised/deep/control、text-fg*、border-line*、accent、ok/warn/danger/info）：\n` +
          [...violations].sort().slice(0, 60).join('\n'),
      );
    }
  });
});
