export interface ApplySearchReplacePatchPlan {
  search: string;
  replace: string;
  replaceAll?: boolean;
  expectedOccurrences?: number;
}

export interface ApplySearchReplaceDiffPatch extends ApplySearchReplacePatchPlan {
  relativePath: string;
}

export interface ApplySearchReplaceDiffFile {
  path: string;
  content: string;
  patches: number;
  replacements: number;
}

export interface ApplySearchReplaceDiffResult {
  files: ApplySearchReplaceDiffFile[];
  totalFiles: number;
  totalPatches: number;
  totalReplacements: number;
}

export interface SearchOccurrenceLocation {
  line: number;
  column: number;
}

function offsetToLineColumn(content: string, offset: number): SearchOccurrenceLocation {
  let line = 1;
  let lineStart = 0;

  for (let i = 0; i < offset; i += 1) {
    if (content[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }

  return { line, column: offset - lineStart + 1 };
}

export function locateSearchOccurrences(
  content: string,
  search: string
): SearchOccurrenceLocation[] {
  if (!search) {
    return [];
  }

  const fileHasCrLf = content.includes('\r\n');
  const searchLf = search.replace(/\r\n/g, '\n');
  const contentLf = fileHasCrLf ? content.replace(/\r\n/g, '\n') : content;

  const locations: SearchOccurrenceLocation[] = [];
  let start = 0;

  while (start <= contentLf.length) {
    const index = contentLf.indexOf(searchLf, start);
    if (index === -1) {
      break;
    }

    locations.push(offsetToLineColumn(contentLf, index));
    start = index + searchLf.length;
  }

  return locations;
}

export function applySearchReplacePatch(
  content: string,
  plan: ApplySearchReplacePatchPlan
): { content: string; replacements: number } {
  if (!plan.search) {
    throw new Error('search 不能为空');
  }

  const fileHasCrLf = content.includes('\r\n');
  const searchLf = plan.search.replace(/\r\n/g, '\n');
  const replaceLf = plan.replace.replace(/\r\n/g, '\n');
  const contentLf = fileHasCrLf ? content.replace(/\r\n/g, '\n') : content;

  const occurrences = locateSearchOccurrences(content, plan.search).length;

  if (occurrences === 0) {
    let hint = '';
    if (plan.search.includes('\r\n') && !fileHasCrLf) {
      hint = '（文件使用 LF 换行，但 search 使用了 CRLF）';
    } else if (!plan.search.includes('\r\n') && fileHasCrLf) {
      hint = '（文件使用 CRLF 换行，但 search 使用了 LF）';
    }
    throw new Error(`未找到要替换的文本块${hint}`);
  }

  if (
    typeof plan.expectedOccurrences === 'number' &&
    Number.isFinite(plan.expectedOccurrences) &&
    plan.expectedOccurrences !== occurrences
  ) {
    throw new Error(`预期匹配 ${plan.expectedOccurrences} 处，实际匹配 ${occurrences} 处`);
  }

  if (occurrences > 1 && !plan.replaceAll) {
    throw new Error(`匹配到 ${occurrences} 处文本块，请改用更精确的 search 或设置 replaceAll=true`);
  }

  const replacements = plan.replaceAll ? occurrences : 1;
  let resultLf: string;
  const replacedSpans: Array<[number, number]> = [];
  if (plan.replaceAll) {
    resultLf = contentLf.split(searchLf).join(replaceLf);
    let from = 0;
    for (let i = 0; i < occurrences; i += 1) {
      const index = contentLf.indexOf(searchLf, from);
      replacedSpans.push([index, index + searchLf.length]);
      from = index + searchLf.length;
    }
  } else {
    // 不能用 String.replace(search, replace)：替换串中的 $& / $' / $` / $$
    // 会被当作特殊模式展开，导致文件内容被静默损坏。按索引拼接保证字面量替换。
    const index = contentLf.indexOf(searchLf);
    replacedSpans.push([index, index + searchLf.length]);
    resultLf =
      contentLf.slice(0, index) + replaceLf + contentLf.slice(index + searchLf.length);
  }

  if (resultLf === contentLf) {
    throw new Error('替换前后内容完全一致，search 和 replace 不能相同');
  }

  if (!fileHasCrLf) {
    // 纯 LF 文件：结果直接使用
    return { content: resultLf, replacements };
  }

  // 纯 CRLF 文件：整体回写 CRLF（旧行为）
  const isPureCrLf = !/(^|[^\r])\n/.test(content);
  if (isPureCrLf) {
    return { content: resultLf.replace(/\n/g, '\r\n'), replacements };
  }

  // #24：混合换行文件必须逐行保留原行尾——旧实现只要存在一处 CRLF 就
  // 全文规范化，未触碰的行也会被改写，git diff 整文件爆炸。
  return { content: rebuildWithOriginalEols(content, resultLf, replacedSpans), replacements };
}

/** 混合换行文件的逐行行尾重建：#24。
 *  原文件每个 LF 行起始偏移 → 该行的原始行尾（CRLF/LF）。替换区间内的行
 *  继承「被替换的第一行」的行尾（新内容采用它取代的文本的风格）；区间外的
 *  行严格取原行尾，diff 只显示真正的改动。偏移以 LF 规范化空间计，与
 *  resultLf 对齐。 */
function rebuildWithOriginalEols(
  original: string,
  resultLf: string,
  replacedSpans: ReadonlyArray<readonly [number, number]>
): string {
  const dominantEol = dominantLineEnding(original);
  // 原文件：LF 行起始偏移 → 行尾
  const eolByLineStart = new Map<number, string>();
  let lineStart = 0;
  let lfPos = 0;
  for (let i = 0; i < original.length; i += 1) {
    if (original[i] === '\n') {
      const eol = i > 0 && original[i - 1] === '\r' ? '\r\n' : '\n';
      eolByLineStart.set(lineStart, eol);
      lineStart = lfPos + 1;
    }
    if (original[i] !== '\r') {
      lfPos += 1;
    }
  }
  // 末行：原文件以换行结尾时其行尾已在循环中记录；否则无行尾
  if (!original.endsWith('\n')) {
    eolByLineStart.set(lineStart, '');
  }

  // 替换区行尾：继承被替换第一行的原始行尾（找不到则用主导行尾）
  const firstSpanStart = replacedSpans.length > 0 ? replacedSpans[0][0] : -1;
  const regionEol =
    firstSpanStart >= 0 ? (eolByLineStart.get(firstSpanStart) ?? dominantEol) : dominantEol;

  const coveredBySpan = (offset: number): boolean =>
    replacedSpans.some(([start, end]) => offset >= start && offset < end);

  const out: string[] = [];
  let resultLineStart = 0;
  for (let i = 0; i < resultLf.length; i += 1) {
    if (resultLf[i] === '\n') {
      const text = resultLf.slice(resultLineStart, i);
      const eol = coveredBySpan(resultLineStart)
        ? regionEol
        : (eolByLineStart.get(resultLineStart) ?? dominantEol);
      out.push(text + eol);
      resultLineStart = i + 1;
    }
  }
  // 末行：结果以换行结尾时最后一段为空，无需处理；否则补上末行
  if (resultLineStart < resultLf.length) {
    const text = resultLf.slice(resultLineStart);
    const eol = coveredBySpan(resultLineStart)
      ? regionEol
      : (eolByLineStart.get(resultLineStart) ?? dominantEol);
    out.push(text + eol);
  }
  return out.join('');
}

/** 文件主导行尾：CRLF 行数多于 LF 行数 → CRLF，否则 LF（混合文件按多数派）。 */
function dominantLineEnding(content: string): string {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '\n') {
      if (i > 0 && content[i - 1] === '\r') {
        crlf += 1;
      } else {
        lf += 1;
      }
    }
  }
  return crlf > lf ? '\r\n' : '\n';
}

export function applySearchReplaceDiff(
  fileContents: Record<string, string>,
  patches: ApplySearchReplaceDiffPatch[]
): ApplySearchReplaceDiffResult {
  if (patches.length === 0) {
    throw new Error('patches 不能为空');
  }

  const pendingFiles = new Map<string, ApplySearchReplaceDiffFile>();

  patches.forEach((patch, index) => {
    if (!patch.relativePath.trim()) {
      throw new Error(`补丁 ${index + 1} relativePath 不能为空`);
    }

    const current = pendingFiles.get(patch.relativePath) ?? {
      path: patch.relativePath,
      content: fileContents[patch.relativePath],
      patches: 0,
      replacements: 0,
    };

    if (typeof current.content !== 'string') {
      throw new Error(`补丁 ${index + 1} (${patch.relativePath}) 应用失败: 缺少文件内容`);
    }

    try {
      const patched = applySearchReplacePatch(current.content, patch);
      pendingFiles.set(patch.relativePath, {
        path: patch.relativePath,
        content: patched.content,
        patches: current.patches + 1,
        replacements: current.replacements + patched.replacements,
      });
    } catch (error) {
      throw new Error(
        `补丁 ${index + 1} (${patch.relativePath}) 应用失败: ${(error as Error).message}`
      );
    }
  });

  const files = [...pendingFiles.values()];
  return {
    files,
    totalFiles: files.length,
    totalPatches: patches.length,
    totalReplacements: files.reduce((sum, file) => sum + file.replacements, 0),
  };
}
