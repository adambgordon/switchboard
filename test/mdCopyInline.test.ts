import { describe, expect, it } from 'vitest'
import { emitInline, hasInlineMarkup, planInline, type InlineToken } from '../src/renderer/lib/mdCopyInline'

const text = (value: string): InlineToken => ({ kind: 'text', value })
const marker = (value: string, open: boolean): InlineToken => ({ kind: 'marker', value, open })

describe('inline emission boundaries', () => {
  it('propagates repairs across previously checked marker runs', () => {
    const tokens = planInline([
      { styles: 0, tokens: [text('x')] }, { styles: 1, tokens: [text('a')] },
      { styles: 2, tokens: [text('.')] }, { styles: 0, tokens: [text(' R')] }
    ])
    expect(emitInline(tokens, true)).toBe('&#120;*&#97;***\\.** R')
  })
  it('repairs the two ends of a shared literal independently', () => {
    const tokens = planInline([
      { styles: 1, tokens: [text('a_')] }, { styles: 0, tokens: [text('xy')] },
      { styles: 1, tokens: [text('_b')] }
    ])
    expect(emitInline(tokens, true)).toBe('*a\\_*&#120;&#121;*\\_b*')
  })
  it.each([
    [text('x'), marker('*', true), { kind: 'atom', value: ' q' }, marker('*', false), text('y')],
    [text('x'), marker('*', true), { kind: 'atom', value: 'q ' }, marker('*', false), text('y')]
  ] satisfies InlineToken[][])('rejects a repeated edge repair instead of looping', (...tokens) => {
    expect(() => emitInline(tokens, true)).toThrow('Repeated Markdown boundary repair')
  })
  it('does not rewrite a protected nonliteral neighbour', () => {
    expect(() => emitInline([
      { kind: 'atom', value: 'x' }, marker('*', true), text('_a'), marker('*', false)
    ], true)).toThrow('Non-literal Markdown boundary')
  })
  it('encodes complete astral characters on either side', () => {
    const tokens = planInline([
      { styles: 0, tokens: [text('🐈')] }, { styles: 1, tokens: [text('_a_')] },
      { styles: 0, tokens: [text('𝔸')] }
    ])
    expect(emitInline(tokens, true)).toBe('&#128008;*\\_a\\_*&#120120;')
  })
  it('hoists boundary whitespace before checking delimiters', () => {
    const tokens = planInline([{ styles: 1, tokens: [text(' \tq\n ')] }])
    expect(emitInline(tokens, true)).toBe(' \t*q*\n ')
  })
  it('protects literal punctuation only when requested', () => {
    expect(emitInline([text('*a* &copy;')], true)).toBe('\\*a\\* \\&copy\\;')
    expect(emitInline([text('*a* &copy;')], false)).toBe('*a* &copy;')
  })
})

describe('typed inline payloads', () => {
  it.each(['code', 'math'] as const)('separates touching %s atoms using retained italic', kind => {
    const values = kind === 'code' ? ['`a`', '`b`', '`c`', '`d`'] : ['$a$', '$b$', '$c$', '$d$']
    const tokens = planInline(values.map(value => ({ styles: 1, tokens: [{ kind, value }] })))
    expect(emitInline(tokens, true)).toBe(kind === 'code' ? '*`a`_`b`_`c`_`d`_*' : '*$a$_$b$_$c$_$d$_*')
    expect(hasInlineMarkup([{ kind, value: values[0] }])).toBe(true)
  })
  it('uses bold when italic is unavailable', () => {
    const tokens = planInline([
      { styles: 2, tokens: [{ kind: 'code', value: '`a`' }] },
      { styles: 2, tokens: [{ kind: 'code', value: '`b`' }] }
    ])
    expect(emitInline(tokens, true)).toBe('**`a`__`b`__**')
  })
  it('does not add a separator between different atom kinds or across whitespace', () => {
    const tokens = planInline([{ styles: 1, tokens: [
      { kind: 'code', value: '`a`' }, { kind: 'math', value: '$b$' }, text(' '), { kind: 'math', value: '$c$' }
    ] }])
    expect(emitInline(tokens, true)).toBe('*`a`$b$ $c$*')
  })
  it('rejects an atom collision with no representable style boundary', () => {
    expect(() => planInline([{ styles: 0, tokens: [
      { kind: 'code', value: '`a`' }, { kind: 'code', value: '`b`' }
    ] }])).toThrow('Unrepresentable adjacent Markdown atoms')
  })
  it('preserves terminal breaks and whitespace without rewriting protected bytes', () => {
    expect(emitInline([text('Alpha'), { kind: 'break', marked: true }, text(' \t'),
      { kind: 'break', marked: true }, text(' ')], true)).toBe('Alpha\n \t\n ')
    expect(emitInline([{ kind: 'atom', value: 'protected\\\n' }], true)).toBe('protected\\\n')
  })
  it('retains break syntax inside link metadata and before later content', () => {
    expect(emitInline([{ kind: 'atom', value: '[' }, text('Alpha'), { kind: 'break', marked: true },
      { kind: 'atom', value: '](<x>)' }], true)).toBe('[Alpha\\\n](<x>)')
    expect(emitInline([text('Alpha'), { kind: 'break', marked: true },
      { kind: 'break', marked: true }, text('Bravo')], true)).toBe('Alpha\\\n\\\nBravo')
  })
})
