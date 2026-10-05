interface IconProps {
  size?: number
  className?: string
  strokeWidth?: number
}

function svg(path: React.ReactNode, { size = 16, className, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {path}
    </svg>
  )
}

export const Chevron = (p: IconProps) => svg(<polyline points="6 9 12 15 18 9" />, p)
// Up arrow (shaft + head) — the jump-to-top/bottom pills (rotate 180° for down).
export const Arrow = (p: IconProps) =>
  svg(
    <>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </>,
    p
  )
// Vertical three-dot "kebab" — the row overflow-menu trigger. Filled dots (the shared svg() sets
// fill:none for line icons, so each circle opts back into a solid fill).
export const Dots = (p: IconProps) =>
  svg(
    <>
      <circle cx="12" cy="5" r="2.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="2.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="2.3" fill="currentColor" stroke="none" />
    </>,
    p
  )
export const Check = (p: IconProps) => svg(<polyline points="20 6 9 17 4 12" />, p)
export const Copy = (p: IconProps) =>
  svg(
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>,
    p
  )
// Eight rounded segments forming a quiet ring around a background session's agent mark.
export const DashedCircle = (p: IconProps) =>
  svg(
    <circle cx="12" cy="12" r="9.5" strokeDasharray="3.6 3.86" strokeDashoffset="1.8" />,
    { ...p, strokeWidth: p.strokeWidth ?? 1.8 }
  )
export const Search = (p: IconProps) =>
  svg(
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>,
    p
  )
export const Plus = (p: IconProps) =>
  svg(
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>,
    p
  )
// New conversation: a pencil breaking out of an open-cornered page. The pencil's tip reaches above
// and right of the page, so the whole drawing is shifted back by that much to sit centered.
export const Compose = (p: IconProps) =>
  svg(
    <g transform="translate(-0.6 0.6)">
      <path d="M11 4.5H7A2.5 2.5 0 0 0 4.5 7v10A2.5 2.5 0 0 0 7 19.5h10a2.5 2.5 0 0 0 2.5-2.5v-4" />
      <path d="M17.4 3.6a1.9 1.9 0 0 1 2.7 2.7L12.5 14l-3.6.9.9-3.6z" />
      <line x1="15.6" y1="5.4" x2="18.3" y2="8.1" />
    </g>,
    p
  )
/** A pencil alone — renaming. Compose (the pencil over a page) is reserved for a new conversation. */
export const Rename = (p: IconProps) =>
  svg(
    <>
      <path d="M16.6 4.4a2.1 2.1 0 0 1 3 3L8.4 18.6l-4 1 1-4z" />
      <line x1="14.6" y1="6.4" x2="17.6" y2="9.4" />
    </>,
    p
  )
export const Play = (p: IconProps) => svg(<polygon points="7 5 19 12 7 19 7 5" />, { ...p, strokeWidth: p.strokeWidth ?? 1.4 })
export const Close = (p: IconProps) =>
  svg(
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>,
    p
  )
export const Folder = (p: IconProps) =>
  svg(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />, p)
// The open counterpart of Folder: the same back panel, with the front flap tipped forward.
export const FolderOpen = (p: IconProps) =>
  svg(
    <>
      <path d="M3 17V7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v2" />
      <path d="M3 17l2.3-5.1A1.5 1.5 0 0 1 6.7 11H20a1 1 0 0 1 .95 1.3l-1.6 5.3A2 2 0 0 1 17.4 19H5a2 2 0 0 1-2-2z" />
    </>,
    p
  )
export const Help = (p: IconProps) =>
  svg(
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </>,
    p
  )
export const Rows = (p: IconProps) =>
  svg(<path d="M4 6h16M4 10h16M4 14h16M4 18h16" />, p)
export const Palette = (p: IconProps) =>
  svg(
    <>
      <path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z" />
      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
    </>,
    p
  )
export const AppWindow = (p: IconProps) =>
  svg(
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M2 8h20M6 4v4M10 4v4" />
    </>,
    p
  )
export const Flask = (p: IconProps) =>
  svg(
    <>
      <path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2" />
      <path d="M6.453 15h11.094M8.5 2h7" />
    </>,
    p
  )
export const Keyboard = (p: IconProps) =>
  svg(
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10" />
    </>,
    p
  )
export const Info = (p: IconProps) =>
  svg(
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </>,
    p
  )
export const Warning = (p: IconProps) =>
  svg(
    <>
      <path d="M10.3 3.7 2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </>,
    p
  )
// Person (head + shoulders) — the "You" section tag's mark, the human counterpart to the agent logos.
export const Person = (p: IconProps) =>
  svg(
    <>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>,
    p
  )
// Counter-clockwise circular arrow — a "rewind / reset to default" affordance.
export const Reset = (p: IconProps) =>
  svg(
    <>
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </>,
    p
  )
export const Stop = (p: IconProps) => svg(<rect x="6" y="6" width="12" height="12" rx="1.5" />, p)
export const Transcript = (p: IconProps) =>
  svg(
    <>
      <line x1="5" y1="7" x2="19" y2="7" />
      <line x1="5" y1="12" x2="19" y2="12" />
      <line x1="5" y1="17" x2="13" y2="17" />
    </>,
    p
  )
export const PanelLeft = (p: IconProps) =>
  svg(
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </>,
    p
  )
export const PanelRight = (p: IconProps) =>
  svg(
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="15" y1="3" x2="15" y2="21" />
    </>,
    p
  )
/** A pane split down the middle — the vertical-split toggle. Sibling of PanelLeft, drawn to match. */
export const SplitVertical = (p: IconProps) =>
  svg(
    <>
      {/* TWO separate frames with a gap between them. What this must not be is one rectangle with a
          single interior stroke — that was a near-copy of PanelLeft, differing only in where the stroke
          sat, so the rail toggle and the split toggle read as the same control two positions apart. Two
          detached panes is a distinct silhouette at 16px, which is the only size that matters. Drawn to
          PanelLeft's 3→21 box so it does not also look a size smaller than its neighbors. */}
      <rect x="3" y="3" width="8" height="18" rx="2" />
      <rect x="13" y="3" width="8" height="18" rx="2" />
    </>,
    p
  )

/** Two offset frames — open in its own window. */
export const NewWindow = (p: IconProps) =>
  svg(
    <>
      <rect x="3" y="7" width="13" height="12" rx="2" />
      <path d="M8 7V6a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-1" />
    </>,
    p
  )

// Two chevrons pointing in — collapse every folder — and out — expand every folder.
export const CollapseAll = (p: IconProps) =>
  svg(
    <>
      <polyline points="7 20 12 15 17 20" />
      <polyline points="7 4 12 9 17 4" />
    </>,
    p
  )
export const ExpandAll = (p: IconProps) =>
  svg(
    <>
      <polyline points="7 15 12 20 17 15" />
      <polyline points="7 9 12 4 17 9" />
    </>,
    p
  )

// The rail head's filter: three centered lines, each shorter than the last. Heavier while a filter is on.
export const ListFilter = ({ heavy = false, ...p }: IconProps & { heavy?: boolean }) =>
  svg(
    <>
      <line x1="3.5" y1="6.5" x2="20.5" y2="6.5" />
      <line x1="7" y1="12" x2="17" y2="12" />
      <line x1="10" y1="17.5" x2="14" y2="17.5" />
    </>,
    { ...p, strokeWidth: heavy ? 2.6 : (p.strokeWidth ?? 1.8) }
  )
export const Eye = (p: IconProps) =>
  svg(
    <>
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </>,
    p
  )
export const EyeOff = (p: IconProps) =>
  svg(
    <>
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
      <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
      <path d="m2 2 20 20" />
    </>,
    p
  )

export const Gear = (p: IconProps) =>
  svg(
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>,
    p
  )
export const Sun = (p: IconProps) =>
  svg(
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </>,
    p
  )
export const Moon = (p: IconProps) =>
  svg(<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />, p)
export const CheckCircle = (p: IconProps) =>
  svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>,
    p
  )
// `filled` fills the body only: the clapper is an open arc, which would fill into a sliver.
export const Bell = ({ filled = false, ...p }: IconProps & { filled?: boolean }) =>
  svg(
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" fill={filled ? 'currentColor' : 'none'} />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </>,
    p
  )

export function Pin({ size = 16, className, filled = false }: IconProps & { filled?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  )
}
