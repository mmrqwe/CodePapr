export interface WorkspaceHostListEntry {
  path: string;
  name: string;
  isDir: boolean;
  bytes: number;
}

export interface WorkspaceHostListFilesResult {
  root?: string;
  entries: WorkspaceHostListEntry[];
  truncated?: boolean;
}

export interface WorkspaceHostReadTextFileResult {
  path?: string;
  content: string;
  bytes: number;
  truncatedByBytes?: boolean;
  truncatedByRange?: boolean;
}

export interface WorkspaceHostReadImageFileResult {
  path?: string;
  mediaType: string;
  data: string;
  bytes: number;
}

export interface WorkspaceHostWriteTextFileResult {
  path: string;
  bytes: number;
}

export interface WorkspaceHostCommandResult {
  command: string;
  args: string[];
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface WorkspaceHostListFilesOptions {
  relativePath?: string;
  maxDepth?: number;
}

export interface WorkspaceHostReadTextFileOptions {
  relativePath: string;
  maxBytes?: number;
  startLine?: number;
  endLine?: number;
  aroundLine?: number;
  contextLines?: number;
}

export interface WorkspaceHostWriteTextFileOptions {
  relativePath: string;
  content: string;
}

export interface WorkspaceHostRunCommandOptions {
  command: string;
  args?: string[];
  timeoutSeconds?: number;
}

export interface WorkspaceLanguageServiceRequestOptions<TParams> {
  relativePath: string;
  languageId: string;
  method: string;
  params: TParams;
  content?: string;
}

export interface WorkspaceLanguageServiceHost {
  request<TResult = unknown, TParams = unknown>(
    options: WorkspaceLanguageServiceRequestOptions<TParams>
  ): Promise<TResult>;
}

export interface WorkspaceHost {
  workspacePath: string;
  listFiles(options: WorkspaceHostListFilesOptions): Promise<WorkspaceHostListFilesResult>;
  readTextFile(options: WorkspaceHostReadTextFileOptions): Promise<WorkspaceHostReadTextFileResult>;
  runCommand(options: WorkspaceHostRunCommandOptions): Promise<WorkspaceHostCommandResult>;
  writeTextFile?(options: WorkspaceHostWriteTextFileOptions): Promise<WorkspaceHostWriteTextFileResult>;
  languageService?: WorkspaceLanguageServiceHost;
}
