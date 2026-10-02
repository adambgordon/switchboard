import { Fragment, type ReactNode } from 'react'
import { META_SEP } from '../lib/format'

/**
 * A metadata line written as one string (tooltips, the bell), with each `META_SEP` drawn as the meta
 * dot the rail rows and pane header use — inline, since these lines are text that may truncate.
 */
export default function MetaText({ text }: { text: string }): ReactNode {
  return text.split(META_SEP).map((part, i) => (
    <Fragment key={i}>
      {i > 0 && <span className="sb-sep sb-sep-inline" aria-hidden="true" />}
      {part}
    </Fragment>
  ))
}
