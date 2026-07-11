import type { WorkspaceProjectGraphResult } from '@codepapr/core';
import type {
  WorkspaceListEntry,
  WorkspaceMapSymbolSummary,
  WorkspaceProjectMapResult,
} from '../tools/workspaceToolUtils';

export interface ProjectGraphWorkerBuildRequest {
  type: 'build';
  projectMapParams: {
    rootRelativePath?: string;
    entries: WorkspaceListEntry[];
    fileContents: Record<string, { content: string; bytes: number }>;
    symbolOverrides: Record<string, WorkspaceMapSymbolSummary[] | null | undefined>;
    maxTreeEntries: number;
    maxStubsPerFile: number;
    truncated: boolean;
  };
  projectGraphParams: {
    entries: WorkspaceListEntry[];
    fileContents: Record<string, { content: string; bytes: number }>;
    symbolOverrides: Record<string, WorkspaceMapSymbolSummary[] | null | undefined>;
    maxEdges: number;
  };
}

export interface ProjectGraphWorkerProgressMessage {
  type: 'progress';
  phase: 'building-map' | 'building-graph';
}

export interface ProjectGraphWorkerResultMessage {
  type: 'result';
  projectMap: WorkspaceProjectMapResult;
  projectGraph: WorkspaceProjectGraphResult;
}

export interface ProjectGraphWorkerErrorMessage {
  type: 'error';
  error: string;
}

export type ProjectGraphWorkerRequest = ProjectGraphWorkerBuildRequest;

export type ProjectGraphWorkerMessage =
  | ProjectGraphWorkerProgressMessage
  | ProjectGraphWorkerResultMessage
  | ProjectGraphWorkerErrorMessage;
