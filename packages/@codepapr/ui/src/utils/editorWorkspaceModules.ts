interface DependencyMapLike {
  [name: string]: unknown;
}

interface PackageJsonLike {
  name?: string;
  dependencies?: DependencyMapLike;
  devDependencies?: DependencyMapLike;
  peerDependencies?: DependencyMapLike;
  optionalDependencies?: DependencyMapLike;
  workspaces?: string[] | { packages?: string[] };
}

interface MarkerLike {
  message?: string;
}

const MODULE_NOT_FOUND_PATTERNS = [
  /Cannot find module ['"“]([^'"”]+)['"”]/i,
  /无法找到模块['"“]([^'"”]+)['"”]/,
  /找不到模块['"“]([^'"”]+)['"”]/,
];
const WORKSPACE_GLOB_PATTERN = /[*?[\]{}!]/;

function collectDependencyKeys(value: DependencyMapLike | undefined, target: Set<string>): void {
  if (!value || typeof value !== 'object') {
    return;
  }

  for (const key of Object.keys(value)) {
    if (key.trim()) {
      target.add(key);
    }
  }
}

function collectPackageName(value: unknown, target: Set<string>): void {
  if (typeof value !== 'string' || !value.trim()) {
    return;
  }

  target.add(value.trim());
}

function parsePackageJson(packageJsonContent: string): PackageJsonLike | null {
  const trimmed = packageJsonContent.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as PackageJsonLike;
  } catch {
    return null;
  }
}

function normalizeWorkspacePackageJsonPath(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || WORKSPACE_GLOB_PATTERN.test(normalized)) {
    return null;
  }

  if (normalized.endsWith('/package.json')) {
    return normalized;
  }

  return `${normalized.replace(/\/+$/, '')}/package.json`;
}

export function parseWorkspacePackageJsonPaths(packageJsonContent: string): string[] {
  const parsed = parsePackageJson(packageJsonContent);
  if (!parsed) {
    return [];
  }

  const workspaceEntries = Array.isArray(parsed.workspaces)
    ? parsed.workspaces
    : Array.isArray(parsed.workspaces?.packages)
    ? parsed.workspaces.packages
    : [];

  const workspacePaths = new Set<string>();
  for (const entry of workspaceEntries) {
    if (typeof entry !== 'string') {
      continue;
    }
    const normalizedPath = normalizeWorkspacePackageJsonPath(entry);
    if (normalizedPath) {
      workspacePaths.add(normalizedPath);
    }
  }

  return [...workspacePaths].sort((left, right) => left.localeCompare(right));
}

function collectDeclaredModuleNames(parsed: PackageJsonLike | null, target: Set<string>): void {
  if (!parsed) {
    return;
  }

  collectPackageName(parsed.name, target);
  collectDependencyKeys(parsed.dependencies, target);
  collectDependencyKeys(parsed.devDependencies, target);
  collectDependencyKeys(parsed.peerDependencies, target);
  collectDependencyKeys(parsed.optionalDependencies, target);
}

export function parseDeclaredModuleNames(
  packageJsonContent: string,
  workspacePackageJsonContents: readonly string[] = []
): string[] {
  const names = new Set<string>();
  collectDeclaredModuleNames(parsePackageJson(packageJsonContent), names);
  for (const workspacePackageJsonContent of workspacePackageJsonContents) {
    collectDeclaredModuleNames(parsePackageJson(workspacePackageJsonContent), names);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

export function normalizeImportSpecifierToPackageName(specifier: string): string | null {
  const normalized = specifier.trim();
  if (!normalized || normalized.startsWith('.') || normalized.startsWith('/') || normalized.startsWith('#')) {
    return null;
  }

  if (/^[a-z]+:/i.test(normalized)) {
    return normalized.startsWith('node:') ? normalized : null;
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  if (normalized.startsWith('@')) {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : normalized;
  }

  return segments[0];
}

function extractMissingModuleSpecifier(message: string): string | null {
  for (const pattern of MODULE_NOT_FOUND_PATTERNS) {
    const match = pattern.exec(message);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

export function filterDeclaredModuleResolutionDiagnostics<T extends MarkerLike>(
  markers: readonly T[],
  declaredModuleNames: readonly string[]
): T[] {
  if (markers.length === 0 || declaredModuleNames.length === 0) {
    return [...markers];
  }

  const declaredSet = new Set(declaredModuleNames);
  return markers.filter((marker) => {
    if (typeof marker.message !== 'string' || !marker.message.trim()) {
      return true;
    }

    const specifier = extractMissingModuleSpecifier(marker.message);
    if (!specifier) {
      return true;
    }

    const packageName = normalizeImportSpecifierToPackageName(specifier);
    if (!packageName) {
      return true;
    }

    return !declaredSet.has(packageName);
  });
}