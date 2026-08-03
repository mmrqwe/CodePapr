import type { WorkspaceProjectGraphResult } from '../../projectGraph';
import { capitalize, extractParams } from './graphUtils';
import { isCallableSymbolKind, isTestFile } from './graphSymbols';
import { buildEdgeMaps, buildNodeMap } from './graphTraversal';

export interface GeneratedTest {
  fileName: string;
  testName: string;
  content: string;
  language: string;
}

export interface TestGenerationResult {
  tests: GeneratedTest[];
  summary: string;
}

export interface SmartTestSkeleton {
  fileName: string;
  testName: string;
  content: string;
  language: string;
  testedSymbol: string;
  calleeSymbols: string[];
  assertionHints: string[];
}

export interface SmartTestGenerationResult {
  tests: SmartTestSkeleton[];
  testCoverage: { covered: number; total: number; percentage: number };
  summary: string;
}

export function generateTestSkeletons(
  graph: WorkspaceProjectGraphResult,
): TestGenerationResult {
  const tests: GeneratedTest[] = [];
  const testTargets = graph.nodes.filter(
    (n) => n.kind === 'symbol' && n.symbol && isCallableSymbolKind(n.symbol.kind) && n.symbol.exported,
  );

  for (const node of testTargets) {
    if (!node.symbol) continue;
    const lang = detectTestLanguage(node.language ?? node.path);
    const test = generateSingleTest(node.symbol.name, node.symbol.signature, node.path, lang);
    if (test) tests.push(test);
  }

  return {
    tests,
    summary: `为 ${tests.length} 个导出函数生成了测试骨架。`,
  };
}

function detectTestLanguage(langOrPath: string): string {
  const normalized = langOrPath.trim().toLowerCase();
  const NAME_MAP: Record<string, string> = {
    typescript: 'typescript', javascript: 'javascript', python: 'python', rust: 'rust',
    go: 'go', golang: 'go', java: 'java', ruby: 'ruby', php: 'php', kotlin: 'kotlin', swift: 'swift',
  };
  if (NAME_MAP[normalized]) return NAME_MAP[normalized];
  const ext = normalized.split('.').pop() ?? '';
  const LANG_MAP: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java',
    rb: 'ruby', php: 'php', kt: 'kotlin', swift: 'swift',
  };
  return LANG_MAP[ext] ?? 'typescript';
}

function generateSingleTest(
  name: string,
  signature: string,
  sourcePath: string,
  language: string,
): GeneratedTest | null {
  const params = extractParams(signature);
  switch (language) {
    case 'typescript':
    case 'javascript':
      return {
        fileName: sourcePath.replace(/\.\w+$/, '.test.ts'),
        testName: `test ${name}`,
        content: generateTsTest(name, params, sourcePath),
        language,
      };
    case 'python':
      return {
        fileName: `test_${sourcePath.split('/').pop() ?? ''}`,
        testName: `test_${name}`,
        content: generatePythonTest(name, params, sourcePath),
        language,
      };
    case 'go':
      return {
        fileName: sourcePath.replace(/\.go$/, '_test.go'),
        testName: `Test${capitalize(name)}`,
        content: generateGoTest(name, params),
        language,
      };
    case 'rust':
      return {
        fileName: sourcePath,
        testName: `test_${name}`,
        content: generateRustTest(name, params),
        language,
      };
    default:
      return null;
  }
}

function generateTsTest(name: string, params: string[], sourcePath: string): string {
  const moduleName = sourcePath.replace(/^.*\//, '').replace(/\.\w+$/, '');
  const args = params.map((p) => `/* ${p} */ undefined`).join(', ');

  return [
    `import { describe, expect, it } from 'vitest';`,
    `import { ${name} } from './${moduleName}';`,
    ``,
    `describe('${name}', () => {`,
    `  it('should return expected result', () => {`,
    `    const result = ${name}(${args});`,
    `    expect(result).toBeDefined();`,
    `  });`,
    ``,
    `  it('should handle edge cases', () => {`,
    `    // TODO: add edge case tests`,
    `  });`,
    `});`,
    ``,
  ].join('\n');
}

function generatePythonTest(name: string, params: string[], sourcePath: string): string {
  const moduleName = sourcePath.replace(/^.*\//, '').replace(/\.py$/, '');
  const args = params.join(', ');

  return [
    `import pytest`,
    `from ${moduleName} import ${name}`,
    ``,
    ``,
    `def test_${name}_returns_expected():`,
    `    result = ${name}(${args})`,
    `    assert result is not None`,
    ``,
    ``,
    `def test_${name}_edge_cases():`,
    `    # TODO: add edge case tests`,
    `    pass`,
    ``,
  ].join('\n');
}

function generateGoTest(name: string, params: string[]): string {
  return [
    `package main`,
    ``,
    `import "testing"`,
    ``,
    `func Test${capitalize(name)}(t *testing.T) {`,
    `    // TODO: setup test fixtures`,
    ...params.map((p) => `    ${p} := "" /* TODO: initialize */`),
    `    _ = ${name}(${params.join(', ')})`,
    `    // TODO: add assertions`,
    `}`,
    ``,
  ].join('\n');
}

function generateRustTest(name: string, params: string[]): string {
  return [
    `#[cfg(test)]`,
    `mod tests {`,
    `    use super::*;`,
    ``,
    `    #[test]`,
    `    fn test_${name}() {`,
    ...params.map((p) => `        let ${p} = todo!();`),
    `        let result = ${name}(${params.join(', ')});`,
    `        // TODO: add assertions`,
    `    }`,
    `}`,
    ``,
  ].join('\n');
}

export function generateSmartTestSkeletons(
  graph: WorkspaceProjectGraphResult,
): SmartTestGenerationResult {
  const tests: SmartTestSkeleton[] = [];
  const nodeMap = buildNodeMap(graph);
  const callableNodes = graph.nodes.filter(
    (n) => n.kind === 'symbol' && n.symbol && isCallableSymbolKind(n.symbol.kind) && n.symbol.exported,
  );
  const testFileSet = new Set<string>();
  for (const n of graph.nodes) {
    if (n.kind === 'file' && isTestFile(n.path)) testFileSet.add(n.path);
  }

  const edgeMap = buildEdgeMaps(graph);
  const coveredSymbols = new Set<string>();

  for (const node of callableNodes) {
    if (!node.symbol) continue;
    if (testFileSet.has(node.path)) continue;
    if (node.path.includes('__test__') || node.path.includes('.test.') || node.path.includes('.spec.')) continue;

    const callTargets = (edgeMap.outgoing.get(node.id) ?? [])
      .filter((e) => e.kind === 'calls')
      .map((e) => {
        const target = nodeMap.get(e.to);
        return target?.symbol?.name ?? '';
      })
      .filter(Boolean);

    const depTargets = (edgeMap.outgoing.get(node.id) ?? [])
      .filter((e) => e.kind === 'imports' || e.kind === 'calls')
      .map((e) => {
        const target = nodeMap.get(e.to);
        return target?.symbol?.name ?? '';
      })
      .filter(Boolean);

    const lang = detectTestLanguage(node.language ?? node.path);
    const assertionHints = generateAssertionHints(node.symbol, callTargets, depTargets, lang);
    const params = extractParams(node.symbol.signature);

    const content = generateSmartTestContent(
      node.symbol.name, params, callTargets, assertionHints, node.path, lang,
    );

    tests.push({
      fileName: generateTestFileName(node.path, lang),
      testName: generateTestName(node.symbol.name, lang),
      content,
      language: lang,
      testedSymbol: node.symbol.name,
      calleeSymbols: callTargets,
      assertionHints,
    });

    coveredSymbols.add(node.id);
  }

  const totalSymbols = callableNodes.length;
  const covered = coveredSymbols.size;

  return {
    tests,
    testCoverage: {
      covered,
      total: totalSymbols,
      percentage: totalSymbols > 0 ? Math.round((covered / totalSymbols) * 100) : 0,
    },
    summary: `为 ${covered}/${totalSymbols} 个导出函数生成了智能测试骨架（覆盖率 ${totalSymbols > 0 ? Math.round((covered / totalSymbols) * 100) : 0}%）。`,
  };
}

function generateAssertionHints(
  symbol: { name: string; kind: string; signature: string },
  callTargets: string[],
  _depTargets: string[],
  lang: string,
): string[] {
  const hints: string[] = [];

  if (/=>|return|:\s*\w/.test(symbol.signature)) {
    if (lang === 'python') {
      hints.push(`assert result is not None  # ${symbol.name} 应返回有效值`);
    } else if (lang === 'go') {
      hints.push(`// assert: result should not be nil`);
    } else if (lang === 'rust') {
      hints.push(`assert!(result.is_ok() || result.is_some());`);
    } else {
      hints.push(`expect(result).toBeDefined();`);
    }
  }

  for (const target of callTargets.slice(0, 3)) {
    if (lang === 'python') {
      hints.push(`# Verify ${target} was called`);
    } else if (lang === 'go') {
      hints.push(`// Verify ${target} was called`);
    } else {
      hints.push(`// Verify ${target} interaction`);
    }
  }

  return hints;
}

function generateSmartTestContent(
  name: string,
  params: string[],
  callTargets: string[],
  assertionHints: string[],
  sourcePath: string,
  lang: string,
): string {
  switch (lang) {
    case 'python': return generateSmartPythonTest(name, params, callTargets, assertionHints, sourcePath);
    case 'go': return generateSmartGoTest(name, params, callTargets, assertionHints);
    case 'rust': return generateSmartRustTest(name, params, callTargets, assertionHints);
    default: return generateSmartTsTest(name, params, callTargets, assertionHints, sourcePath);
  }
}

function generateSmartTsTest(name: string, params: string[], callTargets: string[], hints: string[], sourcePath: string): string {
  const moduleName = sourcePath.replace(/^.*\//, '').replace(/\.\w+$/, '');
  const args = params.map((p) => `/* ${p} */ undefined`).join(', ');
  const hintLines = hints.map((h) => `    // ${h}`).join('\n');
  const mockSetup = callTargets.slice(0, 3).map((t) => `    // const ${t}Mock = vi.fn();`).join('\n');

  return [
    `import { describe, expect, it, vi } from 'vitest';`,
    `import { ${name} } from './${moduleName}';`,
    ``,
    `describe('${name}', () => {`,
    `  it('should return expected result', () => {`,
    mockSetup ? `${mockSetup}\n` : '',
    `    const result = ${name}(${args});`,
    hintLines,
    `    expect(result).toBeDefined();`,
    `  });`,
    ``,
    `  it('should handle edge cases', () => {`,
    `    // TODO: add edge case tests for ${name}`,
    `  });`,
    `});`,
    ``,
  ].join('\n');
}

function generateSmartPythonTest(name: string, params: string[], callTargets: string[], hints: string[], sourcePath: string): string {
  const moduleName = sourcePath.replace(/^.*\//, '').replace(/\.py$/, '');
  const args = params.join(', ');
  const hintLines = hints.map((h) => `    ${h}`).join('\n');

  return [
    `import pytest`,
    `from ${moduleName} import ${name}`,
    ``,
    ``,
    `def test_${name}_returns_expected():`,
    `    result = ${name}(${args})`,
    hintLines,
    ``,
    ``,
    `def test_${name}_edge_cases():`,
    `    # TODO: add edge case tests`,
    `    pass`,
    ``,
  ].join('\n');
}

function generateSmartGoTest(name: string, params: string[], callTargets: string[], hints: string[]): string {
  const hintLines = hints.map((h) => `    ${h}`).join('\n');

  return [
    `package main`,
    ``,
    `import "testing"`,
    ``,
    `func Test${capitalize(name)}(t *testing.T) {`,
    ...params.map((p) => `    ${p} := "" /* TODO: initialize */`),
    `    result := ${name}(${params.join(', ')})`,
    hintLines,
    `}`,
    ``,
  ].join('\n');
}

function generateSmartRustTest(name: string, params: string[], callTargets: string[], hints: string[]): string {
  const hintLines = hints.map((h) => `        ${h}`).join('\n');

  return [
    `#[cfg(test)]`,
    `mod tests {`,
    `    use super::*;`,
    ``,
    `    #[test]`,
    `    fn test_${name}() {`,
    ...params.map((p) => `        let ${p} = todo!();`),
    `        let result = ${name}(${params.join(', ')});`,
    hintLines,
    `    }`,
    `}`,
    ``,
  ].join('\n');
}

function generateTestFileName(sourcePath: string, lang: string): string {
  switch (lang) {
    case 'python': return `test_${sourcePath.split('/').pop()?.replace(/\.py$/, '') ?? 'module'}.py`;
    case 'go': return sourcePath.replace(/\.go$/, '_test.go');
    case 'rust': return sourcePath;
    default: return sourcePath.replace(/\.\w+$/, '.test.ts');
  }
}

function generateTestName(name: string, lang: string): string {
  switch (lang) {
    case 'python': return `test_${name}`;
    case 'go': return `Test${capitalize(name)}`;
    case 'rust': return `test_${name}`;
    default: return `test ${name}`;
  }
}
