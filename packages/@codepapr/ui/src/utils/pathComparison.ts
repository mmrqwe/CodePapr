/** 平台感知的路径等价比较。
 *
 *  macOS/Windows 文件系统默认大小写不敏感：路径比较必须按大小写不敏感处理，
 *  否则同一目录（如 /Users/example/x vs /Users/example/x）会被误判为不同路径——
 *  外部路径放行匹配、recent 去重、URI 归属判断都会误拒/重复。
 *  Linux 保持大小写敏感。
 */
export function isCaseInsensitiveFilesystem(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32';
}

export function pathsEquivalent(left: string, right: string): boolean {
  if (left === right) return true;
  if (!isCaseInsensitiveFilesystem()) return false;
  return left.toLocaleLowerCase() === right.toLocaleLowerCase();
}

/** 路径是否位于 dir 之下（含 dir 自身），按平台决定大小写敏感性。 */
export function pathUnderDir(path: string, dir: string): boolean {
  if (pathsEquivalent(path, dir)) return true;
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  if (isCaseInsensitiveFilesystem()) {
    return path.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase());
  }
  return path.startsWith(prefix);
}
