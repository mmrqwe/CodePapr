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

/** 行起始偏移索引：一次性构建，供任意偏移 O(log n) 定位行号。
 *  旧实现每处匹配都从文件头重扫（O(k·n)），短高频 search 命中 1MB 文件时
 *  字符迭代量达 10^9~10^10，冻结调用线程（工具 handler 跑在 UI 线程）。 */
function buildLineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

function offsetToLineColumn(
  lineStarts: readonly number[],
  offset: number
): SearchOccurrenceLocation {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const lineStart = lineStarts[lo]!;
  return { line: lo + 1, column: offset - lineStart + 1 };
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

  const lineStarts = buildLineStarts(contentLf);
  const locations: SearchOccurrenceLocation[] = [];
  let start = 0;

  while (start <= contentLf.length) {
    const index = contentLf.indexOf(searchLf, start);
    if (index === -1) {
      break;
    }

    locations.push(offsetToLineColumn(lineStarts, index));
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
    // expectedOccurrences 只是数量校验器（前面已核对数量），不能消歧——
    // 明确告知，避免 LLM 按提示设置后仍失败、陷入死循环。
    const expectedClarification =
      typeof plan.expectedOccurrences === 'number'
        ? '（expectedOccurrences 只能校验数量，不能消歧；请加长 search 或设置 replaceAll=true）'
        : '';
    throw new Error(
      `匹配到 ${occurrences} 处文本块，请改用更精确的 search 或设置 replaceAll=true${expectedClarification}`
    );
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

  // #24：混合换行文件必须在原文上按字节拼接——未匹配区域严格保留原始字节
  // （含各自行尾），只有替换区间内的行采用被替换首行的行尾风格。旧实现只要
  // 存在一处 CRLF 就全文规范化；第一版逐行重建在替换改变行数时行尾映射错位
  // （区间后的行拿到错误行的行尾），均造成 git diff 整文件爆炸。
  return {
    content: spliceMixedEol(content, contentLf, searchLf, replaceLf, replacedSpans),
    replacements,
  };
}

/** 混合换行文件的原文拼接：#24。
 *  在 LF 规范化空间定位替换区间，映射回原文偏移后做字节级拼接：
 *  - 区间外：原文切片原样保留（行尾逐字节不变）；
 *  - 区间内：replace 文本的换行统一采用「被替换首行」的原始行尾；
 *  - search 不以换行结尾且紧随其后是换行时，把该换行并入区间（被触碰的
 *    最后一行的行尾也跟随区域风格，与替换前行数无关，行数变化不错位）。 */
function spliceMixedEol(
  original: string,
  contentLf: string,
  searchLf: string,
  replaceLf: string,
  replacedSpans: ReadonlyArray<readonly [number, number]>
): string {
  // LF 规范化偏移 → 原文偏移（\r\n 中的 \r 与其 \n 同归属，映射跳过 \r）
  const lfToOrig: number[] = [];
  for (let i = 0; i < original.length; i += 1) {
    if (original[i] === '\r' && original[i + 1] === '\n') {
      continue;
    }
    lfToOrig.push(i);
  }
  lfToOrig.push(original.length);

  // 区域行尾：首个替换区间所在行的原始行尾；该行无换行（文件末尾）时用主导行尾
  const eolOfOriginalLineAt = (origOffset: number): string | null => {
    const nl = original.indexOf('\n', origOffset);
    if (nl === -1) {
      return null;
    }
    return nl > 0 && original[nl - 1] === '\r' ? '\r\n' : '\n';
  };
  const firstSpan = replacedSpans[0];
  const regionEol =
    (firstSpan ? eolOfOriginalLineAt(lfToOrig[firstSpan[0]]!) : null) ??
    dominantLineEnding(original);
  const replaceWithEol = regionEol === '\n' ? replaceLf : replaceLf.replace(/\n/g, regionEol);

  let out = '';
  let prevOrigEnd = 0;
  for (const [spanStart, spanEnd] of replacedSpans) {
    // search 不以换行结尾且匹配后紧跟换行：区间扩展至包含该换行
    const extendsTrailingEol = !searchLf.endsWith('\n') && contentLf[spanEnd] === '\n';
    const origStart = lfToOrig[spanStart]!;
    const origEnd = lfToOrig[extendsTrailingEol ? spanEnd + 1 : spanEnd]!;
    const piece = extendsTrailingEol ? replaceWithEol + regionEol : replaceWithEol;
    out += original.slice(prevOrigEnd, origStart) + piece;
    prevOrigEnd = origEnd;
  }
  out += original.slice(prevOrigEnd);
  return out;
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
