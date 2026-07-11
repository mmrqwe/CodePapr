import path from 'node:path';

const WORKSPACE_SOURCE_PACKAGE_RE = /^(@codepapr\/[^/]+)\/src\/(.+)$/;

export async function resolve(specifier, context, defaultResolve) {
  const workspaceSourceMatch = specifier.match(WORKSPACE_SOURCE_PACKAGE_RE);
  if (workspaceSourceMatch) {
    const [, packageName, sourcePath] = workspaceSourceMatch;
    try {
      return await defaultResolve(
        `${packageName}/dist/${sourcePath}.js`,
        context,
        defaultResolve
      );
    } catch {
      // Fall through to the regular resolver so local dev gets the original error.
    }
  }

  try {
    return await defaultResolve(specifier, context, defaultResolve);
  } catch (error) {
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      !path.extname(specifier)
    ) {
      return await defaultResolve(`${specifier}.js`, context, defaultResolve);
    }
    throw error;
  }
}
