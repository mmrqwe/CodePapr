import { describe, expect, it } from 'vitest';
import {
  isLspFamilyEnabled,
  lspFamilyFromLanguageId,
  normalizeLspDisabledFamilies,
} from './lspFamilies';

describe('lspFamilies', () => {
  it('maps language aliases onto a shared family', () => {
    expect(lspFamilyFromLanguageId('typescriptreact')).toBe('typescript');
    expect(lspFamilyFromLanguageId('javascript')).toBe('typescript');
    expect(lspFamilyFromLanguageId('scss')).toBe('css');
    expect(lspFamilyFromLanguageId('c')).toBe('cpp');
    expect(lspFamilyFromLanguageId('unknown')).toBeNull();
  });

  it('treats missing disabled list as all enabled', () => {
    expect(isLspFamilyEnabled(undefined, 'typescript')).toBe(true);
    expect(isLspFamilyEnabled([], 'python')).toBe(true);
    expect(isLspFamilyEnabled(['rust'], 'typescript')).toBe(true);
    expect(isLspFamilyEnabled(['rust'], 'rust')).toBe(false);
    expect(isLspFamilyEnabled(['typescript'], 'tsx' as string)).toBe(true);
    expect(isLspFamilyEnabled(['typescript'], 'javascriptreact')).toBe(false);
  });

  it('drops unknown family ids so stale settings cannot disable everything', () => {
    expect(normalizeLspDisabledFamilies(['rust', 'nope', 1, 'rust', 'java'])).toEqual([
      'rust',
      'java',
    ]);
    expect(normalizeLspDisabledFamilies(undefined)).toEqual([]);
  });
});
