import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceProjectGraphResult } from '@codepapr/core';

export interface ProjectGraphCacheEntry {
  workspacePath: string;
  projectGraph: WorkspaceProjectGraphResult;
  fileMtimes: Record<string, number>; // 文件名 -> 修改时间
  createdAt: number;
  version: number;
}

const CACHE_VERSION = 1;
const CACHE_FILE = 'codepapr-projectgraph-cache.json';

export class WorkspaceProjectGraphCache {
  private workspacePath: string;
  private cacheDir: string;
  private cacheFile: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.cacheDir = join(workspacePath, '.CodePapr');
    this.cacheFile = join(this.cacheDir, CACHE_FILE);
  }

  async load(): Promise<ProjectGraphCacheEntry | null> {
    try {
      if (!existsSync(this.cacheFile)) {
        return null;
      }

      const content = await fs.readFile(this.cacheFile, 'utf8');
      const data = JSON.parse(content);

      // 验证缓存版本
      if (data.version !== CACHE_VERSION) {
        return null;
      }

      // 验证工作区路径匹配
      if (data.workspacePath !== this.workspacePath) {
        return null;
      }

      return data as ProjectGraphCacheEntry;
    } catch {
      return null;
    }
  }

  async save(entry: ProjectGraphCacheEntry): Promise<void> {
    try {
      // 确保缓存目录存在
      if (!existsSync(this.cacheDir)) {
        await fs.mkdir(this.cacheDir, { recursive: true });
      }

      await fs.writeFile(this.cacheFile, JSON.stringify(entry, null, 2), 'utf8');
    } catch (e) {
      console.warn('ProjectGraph cache write failed:', e);
    }
  }

  invalidate(): void {
    try {
      if (existsSync(this.cacheFile)) {
        fs.unlink(this.cacheFile).catch(() => { /* 忽略 */ });
      }
    } catch (e) {
      console.warn('ProjectGraph cache delete failed:', e);
    }
  }

  async getChangedFiles(knownMtimes: Record<string, number>, allFiles: Array<{ path: string }>): Promise<{
    newFiles: string[];
    changedFiles: string[];
    deletedFiles: string[];
  }> {
    const newFiles: string[] = [];
    const changedFiles: string[] = [];
    const knownPaths = new Set(Object.keys(knownMtimes));

    // 检查现有文件
    for (const file of allFiles) {
      const normalizedPath = file.path;
      knownPaths.delete(normalizedPath);

      const cachedMtime = knownMtimes[normalizedPath];
      const currentMtime = await this.getFileMtime(normalizedPath);

      if (cachedMtime === undefined) {
        newFiles.push(normalizedPath);
      } else if (currentMtime !== null && currentMtime !== cachedMtime) {
        changedFiles.push(normalizedPath);
      }
    }

    // 剩下的就是已删除的文件
    const deletedFiles = Array.from(knownPaths);

    return { newFiles, changedFiles, deletedFiles };
  }

  private async getFileMtime(relativePath: string): Promise<number | null> {
    try {
      const fullPath = join(this.workspacePath, relativePath);
      const stat = await fs.stat(fullPath);
      return stat.mtimeMs;
    } catch {
      return null;
    }
  }

  async computeFileMtimes(files: Array<{ path: string }>): Promise<Record<string, number>> {
    const mtimes: Record<string, number> = {};
    for (const file of files) {
      const normalizedPath = file.path;
      const mtime = await this.getFileMtime(normalizedPath);
      if (mtime !== null) {
        mtimes[normalizedPath] = mtime;
      }
    }
    return mtimes;
  }
}
