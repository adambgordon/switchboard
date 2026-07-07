import { describe, expect, it } from 'vitest'
import { langLabelFromClassName } from '../src/renderer/lib/codeLang'

describe('langLabelFromClassName', () => {
  it('reads a plain language- class', () => {
    expect(langLabelFromClassName('language-python')).toBe('python')
  })

  it('reads language- alongside hljs (the rehype-highlight shape)', () => {
    expect(langLabelFromClassName('hljs language-python')).toBe('python')
    expect(langLabelFromClassName('md-code hljs language-go')).toBe('go')
  })

  it('normalises common aliases', () => {
    expect(langLabelFromClassName('hljs language-ts')).toBe('typescript')
    expect(langLabelFromClassName('language-tsx')).toBe('typescript')
    expect(langLabelFromClassName('language-js')).toBe('javascript')
    expect(langLabelFromClassName('language-py')).toBe('python')
    expect(langLabelFromClassName('language-sh')).toBe('bash')
    expect(langLabelFromClassName('language-zsh')).toBe('bash')
    expect(langLabelFromClassName('language-yml')).toBe('yaml')
    expect(langLabelFromClassName('language-md')).toBe('markdown')
  })

  it('lowercases the token', () => {
    expect(langLabelFromClassName('language-Python')).toBe('python')
    expect(langLabelFromClassName('language-SQL')).toBe('sql')
  })

  it('labels languages outside the highlighted subset (class present regardless)', () => {
    expect(langLabelFromClassName('language-proto')).toBe('proto')
    expect(langLabelFromClassName('language-dockerfile')).toBe('dockerfile')
  })

  it('keeps tokens with +, #, ., - intact', () => {
    expect(langLabelFromClassName('language-c++')).toBe('c++')
    expect(langLabelFromClassName('language-c#')).toBe('c#')
    expect(langLabelFromClassName('language-objective-c')).toBe('objective-c')
  })

  it('returns null when there is no language- class', () => {
    expect(langLabelFromClassName('md-code hljs')).toBeNull()
    expect(langLabelFromClassName('md-code')).toBeNull()
  })

  it('returns null for empty / missing className (bare fence, inline code)', () => {
    expect(langLabelFromClassName('')).toBeNull()
    expect(langLabelFromClassName(undefined)).toBeNull()
    expect(langLabelFromClassName(null)).toBeNull()
  })

  it('does not match a bare "language-" prefix inside another word', () => {
    expect(langLabelFromClassName('my-language-x')).toBeNull()
  })
})
