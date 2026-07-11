export interface EditorDiagnosticItem {
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  startLineNumber: number;
  startColumn: number;
}

export interface EditorDiagnosticsSummary {
  total: number;
  errors: number;
  warnings: number;
  infos: number;
  hints: number;
  items: EditorDiagnosticItem[];
}

interface MarkerLike {
  severity?: number;
  message?: string;
  startLineNumber?: number;
  startColumn?: number;
}

function toSeverity(severity: number | undefined): EditorDiagnosticItem['severity'] {
  switch (severity) {
    case 8:
      return 'error';
    case 4:
      return 'warning';
    case 2:
      return 'info';
    default:
      return 'hint';
  }
}

export function summarizeEditorDiagnostics(
  markers: readonly MarkerLike[]
): EditorDiagnosticsSummary {
  const items = markers
    .filter((marker) => typeof marker.message === 'string' && marker.message.trim())
    .map((marker) => ({
      severity: toSeverity(marker.severity),
      message: marker.message!.trim(),
      startLineNumber:
        typeof marker.startLineNumber === 'number' ? marker.startLineNumber : 1,
      startColumn: typeof marker.startColumn === 'number' ? marker.startColumn : 1,
    }));

  return items.reduce<EditorDiagnosticsSummary>(
    (summary, item) => {
      summary.items.push(item);
      summary.total += 1;
      if (item.severity === 'error') summary.errors += 1;
      if (item.severity === 'warning') summary.warnings += 1;
      if (item.severity === 'info') summary.infos += 1;
      if (item.severity === 'hint') summary.hints += 1;
      return summary;
    },
    {
      total: 0,
      errors: 0,
      warnings: 0,
      infos: 0,
      hints: 0,
      items: [],
    }
  );
}
