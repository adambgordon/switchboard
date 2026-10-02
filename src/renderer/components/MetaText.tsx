import { Fragment, type ReactNode } from 'react'
import { META_SEP } from '../lib/format'

/**
 * A metadata line written as one string (tooltips, the bell), with each `META_SEP` drawn as the meta
 * dot the rail rows and pane header use — inline, since these lines are text that may truncate.
 * The separator's spaces stay as text either side of the dot, IN the neighboring words' own text
 * nodes: the dot is hidden from assistive tech, and Chromium's accessible-name computation drops a
 * text node that is only a space beside it — so a bell entry's name ran "app" into "finished 4m ago".
 */
export default function MetaText({ text }: { text: string }): ReactNode {
  const parts = text.split(META_SEP)
  return parts.map((part, i) => (
    <Fragment key={i}>
      {i > 0 && <span className="sb-sep sb-sep-inline" aria-hidden="true" />}
      {`${i > 0 ? ' ' : ''}${part}${i < parts.length - 1 ? ' ' : ''}`}
    </Fragment>
  ))
}
