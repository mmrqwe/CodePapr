import { describe, expect, it } from 'vitest';
import { languageFromPath, lspLanguageFromPath } from './editorLanguage';

describe('languageFromPath', () => {
  it.each([
    ['src/App.tsx', 'typescript'],
    ['src/main.ts', 'typescript'],
    ['src/index.js', 'javascript'],
    ['src/index.mjs', 'javascript'],
    ['src/styles.css', 'css'],
    ['src/styles.scss', 'scss'],
    ['src/template.html', 'html'],
    ['src/template.shtml', 'html'],
    ['src/config.json', 'json'],
    ['src/config.jsonc', 'json'],
    ['src/readme.md', 'markdown'],
    ['src/schema.proto', 'protobuf'],
    ['src/query.graphql', 'graphql'],
    ['src/script.py', 'python'],
    ['src/program.rs', 'rust'],
    ['src/service.go', 'go'],
    ['src/Main.java', 'java'],
    ['src/model.kt', 'kotlin'],
    ['src/app.swift', 'swift'],
    ['src/file.rb', 'ruby'],
    ['src/file.php', 'php'],
    ['src/file.sql', 'sql'],
    ['src/file.ps1', 'powershell'],
    ['src/file.sh', 'shell'],
    ['src/file.yml', 'yaml'],
    ['src/file.xml', 'xml'],
    ['src/file.cs', 'csharp'],
    ['src/file.cpp', 'cpp'],
    ['Dockerfile', 'dockerfile'],
    ['containers/api.Dockerfile', 'dockerfile'],
    ['Makefile', 'shell'],
  ])('maps %s to %s', (path, expected) => {
    expect(languageFromPath(path)).toBe(expected);
  });

  it.each([
    ['.prettierrc', 'json'],
    ['.eslintrc', 'json'],
    ['.babelrc', 'json'],
    ['.stylelintrc', 'json'],
    ['.swcrc', 'json'],
    ['.env', 'ini'],
    ['.env.local', 'ini'],
    ['.editorconfig', 'ini'],
    ['.gitignore', 'plaintext'],
    ['.dockerignore', 'plaintext'],
  ])('maps dotfile %s to %s', (path, expected) => {
    expect(languageFromPath(path)).toBe(expected);
  });

  it('falls back to plaintext for unknown extensions', () => {
    expect(languageFromPath('notes/custom.unknown')).toBe('plaintext');
  });
});

describe('lspLanguageFromPath', () => {
  it.each([
    ['src/native/main.c', 'cpp'],
    ['src/native/main.cpp', 'cpp'],
    ['src/native/include/lib.hpp', 'cpp'],
    ['src/Program.cs', 'csharp'],
    ['src/Script.csx', 'csharp'],
    ['src/Main.java', 'java'],
    ['src/App.tsx', 'typescriptreact'],
    ['src/main.ts', 'typescript'],
    ['src/index.js', 'javascript'],
    ['src/index.jsx', 'javascriptreact'],
    ['src/index.html', 'html'],
    ['src/styles.css', 'css'],
    ['src/styles.scss', 'scss'],
    ['src/styles.less', 'less'],
    ['src/config.json', 'json'],
    ['src/config.jsonc', 'jsonc'],
    ['.eslintrc', 'json'],
    ['src/config.yaml', 'yaml'],
    ['src/script.py', 'python'],
    ['scripts/setup.sh', 'shellscript'],
    ['src/lib.rs', 'rust'],
    ['cmd/api.go', 'go'],
  ])('maps %s to %s', (path, expected) => {
    expect(lspLanguageFromPath(path)).toBe(expected);
  });

  it('returns null for unsupported extensions', () => {
    expect(lspLanguageFromPath('README.txt')).toBeNull();
  });
});