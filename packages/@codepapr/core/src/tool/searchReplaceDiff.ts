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

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let start = 0;

  while (start <= content.length) {
    const index = content.indexOf(search, start);
    if (index === -1) {
      break;
    }

    count += 1;
    start = index + search.length;
  }

  return count;
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

  const occurrences = countOccurrences(contentLf, searchLf);

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
  const resultLf = plan.replaceAll
    ? contentLf.split(searchLf).join(replaceLf)
    : contentLf.replace(searchLf, replaceLf);

  if (resultLf === contentLf) {
    throw new Error('替换前后内容完全一致，search 和 replace 不能相同');
  }

  return {
    content: fileHasCrLf ? resultLf.replace(/\n/g, '\r\n') : resultLf,
    replacements,
  };
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
