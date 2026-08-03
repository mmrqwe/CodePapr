export function countFunctionLines(content: string, startLine: number): number {
  const lines = content.split(/\r?\n/);
  let depth = 0;
  let started = false;
  let endLine = startLine;

  for (let i = startLine - 1; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; started = true; }
      if (ch === '}') {
        depth--;
        if (started && depth <= 0) {
          endLine = i + 1;
          return endLine - startLine + 1;
        }
      }
    }
    if (!started && i - (startLine - 1) >= 3) {
      return 0;
    }
  }
  return endLine - startLine + 1;
}

// Python 等语言用缩进而非花括号定界代码块，countFunctionLines/estimateNestingDepth
// 的花括号计数对这些语言永远返回 0/1，长函数建议永远不会触发，这里按缩进单独处理。
export function isIndentationBasedLanguage(path: string, language?: string): boolean {
  if (language && language.toLowerCase().includes('python')) return true;
  return path.toLowerCase().endsWith('.py');
}

export function countFunctionLinesIndentBased(content: string, startLine: number): number {
  const lines = content.split(/\r?\n/);
  if (startLine < 1 || startLine > lines.length) return 0;
  const baseIndent = lines[startLine - 1].search(/\S/);
  if (baseIndent < 0) return 0;

  let endLine = startLine;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.search(/\S/);
    if (indent <= baseIndent) break;
    endLine = i + 1;
  }
  return endLine - startLine + 1;
}

export function estimateNestingDepthIndentBased(content: string, startLine: number): number {
  const lines = content.split(/\r?\n/);
  if (startLine < 1 || startLine > lines.length) return 1;
  const baseIndent = lines[startLine - 1].search(/\S/);
  if (baseIndent < 0) return 1;

  let maxIndent = baseIndent;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.search(/\S/);
    if (indent <= baseIndent) break;
    if (indent > maxIndent) maxIndent = indent;
  }
  // 常见每级缩进 4 个空格，粗略换算成层级数。
  return Math.max(1, Math.round((maxIndent - baseIndent) / 4));
}

export function estimateNestingDepth(content: string, startLine: number): number {
  const lines = content.split(/\r?\n/);
  let depth = 0;
  let started = false;
  let maxDepth = 0;

  for (let i = startLine - 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const indent = lines[i].length - trimmed.length;
    if (indent > maxDepth) maxDepth = indent;

    for (const ch of lines[i]) {
      if (ch === '{') { depth++; started = true; }
      if (ch === '}') {
        depth--;
        if (started && depth <= 0) return Math.max(1, Math.round(maxDepth / 2));
      }
    }
    if (!started && i - (startLine - 1) >= 3) {
      return 1;
    }
  }
  return Math.max(1, Math.round(maxDepth / 2));
}
