import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { WorkspaceProjectGraphResult } from '@codepapr/core';

export interface FileFingerprintEntry {
  contentHash: string;
  mtime: number;
}

export interface ProjectGraphCacheEntry {
  workspacePath: string;
  projectGraph: WorkspaceProjectGraphResult;
  /** @deprecated retained for migration — use fingerprints instead */
  fileMtimes?: Record<string, number>;
  fingerprints?: Record<string, FileFingerprintEntry>;
  createdAt: number;
  version: number;
}

export interface FingerprintChanges {
  /** 全新文件（缓存中不存在） */
  newFiles: string[];
  /** 内容变更的文件（SHA-256 不同） */
  structuralFiles: string[];
  /** 仅 mtime 变更但内容相同的文件（注释/格式修改，无需重新分析符号） */
  cosmeticFiles: string[];
  /** 已删除的文件（缓存中有但实际不存在） */
  deletedFiles: string[];
}

const CACHE_VERSION = 2;
const CACHE_FILE = 'codepapr-projectgraph-cache.json';

function normalizeCachePath(path: string): string {
  return path.trim().replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/+/g, '/');
}

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

      if (data.version !== CACHE_VERSION) {
        return null;
      }

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
        fs.unlink(this.cacheFile).catch(() => { /* ignore */ });
      }
    } catch (e) {
      console.warn('ProjectGraph cache delete failed:', e);
    }
  }

  async getChangedFiles(
    cached: ProjectGraphCacheEntry,
    allFiles: Array<{ path: string }>,
  ): Promise<FingerprintChanges> {
    const existingFingerprints = cached.fingerprints ?? {};
    const newFiles: string[] = [];
    const structuralFiles: string[] = [];
    const cosmeticFiles: string[] = [];
    const knownPaths = new Set(Object.keys(existingFingerprints));

    for (const file of allFiles) {
      const normalizedPath = normalizeCachePath(file.path);
      knownPaths.delete(normalizedPath);

      const cachedEntry = existingFingerprints[normalizedPath];
      const currentFingerprint = await this.getFileFingerprint(normalizedPath);
      if (!currentFingerprint) continue;

      if (!cachedEntry) {
        newFiles.push(normalizedPath);
        continue;
      }

      if (currentFingerprint.contentHash !== cachedEntry.contentHash) {
        structuralFiles.push(normalizedPath);
      } else if (currentFingerprint.mtime !== cachedEntry.mtime) {
        cosmeticFiles.push(normalizedPath);
      }
    }

    const deletedFiles = Array.from(knownPaths);

    return { newFiles, structuralFiles, cosmeticFiles, deletedFiles };
  }

  async computeFileFingerprints(
    files: Array<{ path: string }>,
  ): Promise<Record<string, FileFingerprintEntry>> {
    const fingerprints: Record<string, FileFingerprintEntry> = {};
    for (const file of files) {
      const normalizedPath = normalizeCachePath(file.path);
      const fp = await this.getFileFingerprint(normalizedPath);
      if (fp) {
        fingerprints[normalizedPath] = fp;
      }
    }
    return fingerprints;
  }

  private async getFileFingerprint(relativePath: string): Promise<FileFingerprintEntry | null> {
    try {
      const fullPath = join(this.workspacePath, relativePath);
      const content = await fs.readFile(fullPath, 'utf8');
      return {
        contentHash: createHash('sha256').update(content).digest('hex'),
        mtime: (await fs.stat(fullPath)).mtimeMs,
      };
    } catch {
      return null;
    }
  }
}
