export interface LineDiffStats {
  added: number;
  deleted: number;
  beforeLines: number;
  afterLines: number;
}

function splitLines(content: string): string[] {
  if (!content) {
    return [];
  }

  return content.replace(/\r\n/g, '\n').split('\n');
}

export function countLines(content: string): number {
  return splitLines(content).length;
}

export function computeLineDiffStats(before: string, after: string): LineDiffStats {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  if (beforeLines.length === 0) {
    return {
      added: afterLines.length,
      deleted: 0,
      beforeLines: 0,
      afterLines: afterLines.length,
    };
  }

  const beforeLength = beforeLines.length;
  const afterLength = afterLines.length;
  const maxDepth = beforeLength + afterLength;
  let frontier = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const current = new Map<number, number>();

    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      const down = frontier.get(diagonal + 1) ?? 0;
      const right = frontier.get(diagonal - 1) ?? -1;

      let x =
        diagonal === -depth || (diagonal !== depth && right < down)
          ? down
          : right + 1;
      let y = x - diagonal;

      while (
        x < beforeLength &&
        y < afterLength &&
        beforeLines[x] === afterLines[y]
      ) {
        x += 1;
        y += 1;
      }

      current.set(diagonal, x);

      if (x >= beforeLength && y >= afterLength) {
        trace.push(current);
        return backtrackLineDiff(trace, beforeLength, afterLength);
      }
    }

    frontier = new Map(current);
    trace.push(current);
  }

  return {
    added: afterLength,
    deleted: beforeLength,
    beforeLines: beforeLength,
    afterLines: afterLength,
  };
}

function backtrackLineDiff(
  trace: readonly Map<number, number>[],
  beforeLength: number,
  afterLength: number
): LineDiffStats {
  let x = beforeLength;
  let y = afterLength;
  let added = 0;
  let deleted = 0;

  for (let depthIndex = trace.length - 1; depthIndex >= 1; depthIndex -= 1) {
    const previous = trace[depthIndex - 1];
    const depth = depthIndex;
    const diagonal = x - y;
    const down = previous.get(diagonal + 1) ?? 0;
    const right = previous.get(diagonal - 1) ?? -1;
    const previousDiagonal =
      diagonal === -depth || (diagonal !== depth && right < down)
        ? diagonal + 1
        : diagonal - 1;
    const previousX = previous.get(previousDiagonal) ?? 0;
    const previousY = previousX - previousDiagonal;

    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
    }

    if (x === previousX) {
      y -= 1;
      added += 1;
    } else {
      x -= 1;
      deleted += 1;
    }
  }

  return {
    added,
    deleted,
    beforeLines: beforeLength,
    afterLines: afterLength,
  };
}
