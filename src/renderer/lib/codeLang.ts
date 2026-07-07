/* Fenced-code language label — pure string logic, unit-tested.
 *
 * rehype-highlight / mdast stamp a fenced block's info string onto the <code> element as
 * `language-<token>` (alongside `hljs`), where <token> is the raw first word the author typed — present
 * even for languages outside our highlighted subset (the class comes from the fence, not highlight.js).
 * We read that token to caption the block. Aliases are normalised to a canonical display name so ```ts
 * and ```typescript read the same. Casing is left lowercase — the caption's .label-caps CSS uppercases.
 *
 * Kept DOM/electron-free so it imports under the node tsconfig (see the repo CLAUDE.md testing note). */

/** Common short forms → canonical display name. The value is still lowercase (CSS uppercases it). */
const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  sh: 'bash',
  zsh: 'bash',
  shell: 'bash',
  yml: 'yaml',
  md: 'markdown'
}

// Language tokens can carry +, #, ., - (c++, c#, objective-c, f#), so the char class is permissive.
const LANGUAGE_CLASS = /(?:^|\s)language-([\w+#.-]+)/

/** Extract and normalise the language label from a code element's className.
 *  Returns the lowercase display token, or null when there's no `language-` class (bare fences,
 *  inline code). */
export function langLabelFromClassName(className: string | undefined | null): string | null {
  if (!className) return null
  const match = LANGUAGE_CLASS.exec(className)
  if (!match) return null
  const token = match[1].toLowerCase()
  return LANG_ALIASES[token] ?? token
}
