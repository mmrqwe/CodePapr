export function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value ?? fallback));
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function getExtension(path: string): string {
  const base = path.split('/').pop() ?? path;
  const idx = base.lastIndexOf('.');
  return idx > 0 ? base.slice(idx + 1) : 'ts';
}

export function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let angle = 0;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (const ch of value) {
    if (ch === '<') angle++;
    else if (ch === '>' && angle > 0) angle--;
    else if (ch === '(') paren++;
    else if (ch === ')' && paren > 0) paren--;
    else if (ch === '[') bracket++;
    else if (ch === ']' && bracket > 0) bracket--;
    else if (ch === '{') brace++;
    else if (ch === '}' && brace > 0) brace--;
    if (ch === ',' && angle === 0 && paren === 0 && bracket === 0 && brace === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

export function extractParams(signature: string): string[] {
  const match = signature.match(/\(([^)]*)\)/);
  if (!match?.[1]) return [];
  return splitTopLevelCommas(match[1])
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const name = p.split(/[\s:=]+/)[0] ?? '';
      return name.replace(/^\.{3}/, '').replace(/[?+]$/, '');
    })
    .filter((name) => name.length > 0);
}
