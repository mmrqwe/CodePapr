/** 平台感知的路径等价比较。
 *
 *  macOS/Windows 文件系统默认大小写不敏感：路径比较必须按大小写不敏感处理，
 *  否则同一目录（如 /Users/example/x vs /Users/example/x）会被误判为不同路径——
 *  外部路径放行匹配、recent 去重、URI 归属判断都会误拒/重复。
 *  Linux 保持大小写敏感。
 */
/** 探测运行平台。
 *
 *  生产环境运行在 WKWebView/WebView2 中，没有 Node 的 `process` 全局对象
 *  （构建产物中 `process.platform` 不会被 polyfill），裸用会抛 ReferenceError。
 *  因此优先用 `process.platform`（Node/测试环境可用），否则回退到 userAgent 判断。
 */
function detectPlatform(): 'darwin' | 'win32' | 'linux' {
  if (typeof process !== 'undefined' && typeof process.platform === 'string') {
    return process.platform === 'darwin' || process.platform === 'win32'
      ? process.platform
      : 'linux';
  }
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent;
    if (/Macintosh|Mac OS X/i.test(ua)) return 'darwin';
    if (/Windows/i.test(ua)) return 'win32';
  }
  return 'linux';
}

export function isCaseInsensitiveFilesystem(): boolean {
  const platform = detectPlatform();
  return platform === 'darwin' || platform === 'win32';
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
