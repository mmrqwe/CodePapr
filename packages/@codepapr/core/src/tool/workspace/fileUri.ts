function isWindowsLongPathPrefix(value: string): boolean {
  return value.startsWith('//?/') || value.startsWith('//./');
}

function isUncPath(value: string): boolean {
  return /^\/\/[^/?]/.test(value) && !isWindowsLongPathPrefix(value);
}

function stripWindowsLongPathPrefix(value: string): string {
  if (!value.startsWith('//?/')) {
    return value;
  }
  const rest = value.slice(4);
  if (/^[A-Za-z]:\//.test(rest)) {
    return rest;
  }
  if (rest.startsWith('UNC/')) {
    return `//${rest.slice(4)}`;
  }
  return value;
}

function normalizePath(value: string): string {
  let normalized = value.replace(/\\/g, '/');
  normalized = stripWindowsLongPathPrefix(normalized);
  const unc = isUncPath(normalized);
  normalized = normalized.replace(/\/+/g, '/');
  if (unc && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }
  return normalized;
}

export function normalizeAbsolutePath(value: string): string {
  const normalized = normalizePath(value).replace(/\/+$/, '');
  return normalized.replace(/^\/([A-Za-z]:\/)/, '$1');
}

function encodeFileUriPath(fullPath: string): string {
  const prefix = isUncPath(fullPath)
    ? 'file:'
    : /^[A-Za-z]:\//.test(fullPath)
      ? 'file:///'
      : 'file://';
  return encodeURI(`${prefix}${fullPath}`).replace(/[?#]/g, (ch) => (ch === '?' ? '%3F' : '%23'));
}

export function workspaceFileUri(workspacePath: string, relativePath: string): string {
  const workspace = normalizeAbsolutePath(workspacePath);
  const relative = normalizePath(relativePath).replace(/^\.\//, '');
  const fullPath = relative ? `${workspace}/${relative}` : workspace;
  return encodeFileUriPath(fullPath);
}

function pathFromFileUrl(url: URL): string {
  const pathname = decodeURIComponent(url.pathname);
  const host = url.host || url.hostname;
  if (host && /^[A-Za-z]:?$/.test(host)) {
    const drive = host.endsWith(':') ? host : `${host}:`;
    return normalizeAbsolutePath(`${drive}${pathname}`);
  }
  if (host) {
    return normalizeAbsolutePath(`//${host}${pathname}`);
  }
  return normalizeAbsolutePath(pathname);
}

export function filePathFromFileUri(uri: string): string | null {
  const trimmed = uri.trim();
  if (!trimmed) {
    return null;
  }
  if (!trimmed.toLowerCase().startsWith('file:')) {
    return normalizeAbsolutePath(trimmed);
  }
  try {
    return pathFromFileUrl(new URL(trimmed));
  } catch {
    return null;
  }
}

export function findFileUriForRelativePath(
  workspacePath: string,
  relativePath: string,
  uris: Iterable<string>,
): string | undefined {
  const wanted = relativePath.replace(/\\/g, '/');
  const wantedLower = wanted.toLowerCase();
  for (const uri of uris) {
    const mapped = relativePathFromFileUri(workspacePath, uri);
    if (mapped === null) continue;
    const normalized = mapped.replace(/\\/g, '/');
    if (normalized === wanted || normalized.toLowerCase() === wantedLower) {
      return uri;
    }
  }
  return undefined;
}

export function relativePathFromFileUri(workspacePath: string, uri: string | undefined): string | null {
  if (!uri) {
    return null;
  }

  try {
    const rawPath = filePathFromFileUri(uri);
    if (rawPath === null) {
      return null;
    }
    const workspace = normalizeAbsolutePath(workspacePath);
    const lowerRawPath = rawPath.toLowerCase();
    const lowerWorkspace = workspace.toLowerCase();
    if (lowerRawPath === lowerWorkspace) {
      return '';
    }
    if (!lowerRawPath.startsWith(`${lowerWorkspace}/`)) {
      return null;
    }
    return rawPath.slice(workspace.length + 1);
  } catch {
    return null;
  }
}
