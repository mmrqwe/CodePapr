import { describe, expect, it } from 'vitest';
import { normalizeMarkdownCodeLanguage } from './markdownCodeLanguage';

describe('normalizeMarkdownCodeLanguage', () => {
  it.each([
    ['html', 'html'],
    ['HTM', 'html'],
    ['js', 'javascript'],
    ['jsx', 'javascript'],
    ['ts', 'typescript'],
    ['tsx', 'typescript'],
    ['bash', 'shell'],
    ['zsh', 'shell'],
    ['yml', 'yaml'],
    ['plaintext', 'plaintext'],
    ['', 'plaintext'],
  ])('maps %s to %s', (input, expected) => {
    expect(normalizeMarkdownCodeLanguage(input)).toBe(expected);
  });

  it('keeps unknown language ids untouched after normalization', () => {
    expect(normalizeMarkdownCodeLanguage('graphql')).toBe('graphql');
  });
});