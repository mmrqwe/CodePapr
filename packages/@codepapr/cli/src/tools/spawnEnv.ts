export function sanitizeSpawnEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): Record<string, string | undefined> {
  const nextEnv = { ...env };
  delete nextEnv.VSCODE_INSPECTOR_OPTIONS;

  const nodeOptions = typeof nextEnv.NODE_OPTIONS === 'string' ? nextEnv.NODE_OPTIONS : '';
  const sanitizedNodeOptions = nodeOptions
    .replace(/\s*--require\s+"[^"]*ms-vscode\.js-debug[^"]*bootloader\.js"/g, '')
    .replace(/\s*--require\s+'[^']*ms-vscode\.js-debug[^']*bootloader\.js'/g, '')
    .replace(/\s*--inspect-publish-uid(?:=\S+|\s+\S+)/g, '')
    .trim();

  if (sanitizedNodeOptions) {
    nextEnv.NODE_OPTIONS = sanitizedNodeOptions;
  } else {
    delete nextEnv.NODE_OPTIONS;
  }

  return nextEnv;
}
