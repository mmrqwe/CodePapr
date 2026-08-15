// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { BUILTIN_THEMES } from './themes';

/**
 * 配色和谐度门槛：
 *  - UI 语义色（accent/green/amber/red/cyan）两两色相必须拉开，防止
 *    Nord 曾经出现的 accent==cyan 重叠回归；
 *  - 语法色（syntax-keyword/string/number/type/function）两两色相必须
 *    拉开（number/function 同属黄色系曾难以区分）；
 *  - 语法色与代码底色满足最低对比度（注释允许放宽）。
 */

interface Rgb { r: number; g: number; b: number }

function hexToRgb(hex: string): Rgb | null {
  const normalized = hex.replace(/^#/, '');
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map((c) => c + c)
          .join('')
      : normalized;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** HSL 色相（0-360）；无彩色返回 null。 */
function hueOf(hex: string): number | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const { r, g, b } = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return null;
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function hueDistance(a: number | null, b: number | null): number {
  if (a === null || b === null) return 0;
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

const UI_SEMANTIC_KEYS = ['accent', 'green', 'amber', 'red', 'cyan'] as const;
const SYNTAX_KEYS = ['syntax-keyword', 'syntax-string', 'syntax-number', 'syntax-type', 'syntax-function'] as const;
/** 色相最小间隔（度）：低于此值视为语义重叠。 */
const MIN_HUE_DISTANCE = 18;

describe('theme palette harmony gate', () => {
  for (const theme of BUILTIN_THEMES) {
    describe(theme.id, () => {
      it('UI 语义色两两色相间隔足够（accent/green/amber/red/cyan）', () => {
        const hues = UI_SEMANTIC_KEYS.map((key) => ({
          key,
          hue: hueOf(theme.tokens[key]),
          value: theme.tokens[key],
        }));
        for (let i = 0; i < hues.length; i++) {
          for (let j = i + 1; j < hues.length; j++) {
            const d = hueDistance(hues[i].hue, hues[j].hue);
            expect(
              d,
              `${hues[i].key}(${hues[i].value}) 与 ${hues[j].key}(${hues[j].value}) 色相仅差 ${d.toFixed(0)}°（阈值 ${MIN_HUE_DISTANCE}°）`,
            ).toBeGreaterThanOrEqual(MIN_HUE_DISTANCE);
          }
        }
      });

      it('语法色两两色相间隔足够（keyword/string/number/type/function）', () => {
        const hues = SYNTAX_KEYS.map((key) => ({
          key,
          hue: hueOf(theme.tokens[key]),
          value: theme.tokens[key],
        }));
        for (let i = 0; i < hues.length; i++) {
          for (let j = i + 1; j < hues.length; j++) {
            const d = hueDistance(hues[i].hue, hues[j].hue);
            expect(
              d,
              `${hues[i].key}(${hues[i].value}) 与 ${hues[j].key}(${hues[j].value}) 色相仅差 ${d.toFixed(0)}°（阈值 ${MIN_HUE_DISTANCE}°）`,
            ).toBeGreaterThanOrEqual(MIN_HUE_DISTANCE);
          }
        }
      });

      it('语法色在代码底色上对比度足够（注释放宽到 3.0）', () => {
        const bg = theme.tokens['code-bg'] ?? theme.tokens['bg-base'];
        for (const key of [...SYNTAX_KEYS, 'syntax-variable', 'syntax-attribute', 'syntax-tag']) {
          const fg = theme.tokens[key];
          const ratio = contrastRatio(fg, bg);
          const min = key === 'syntax-comment' ? 3.0 : 4.0;
          expect(
            ratio,
            `${key}(${fg}) 与 code-bg(${bg}) 对比度 ${ratio.toFixed(2)}:1，低于 ${min}:1`,
          ).toBeGreaterThanOrEqual(min);
        }
      });
    });
  }
});
