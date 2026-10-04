import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { WhatsNewRelease } from '../lib/onceTasks'
import { Bell, Close, EyeOff, Folder, ListFilter, Rows, SplitVertical } from './icons'

interface Props {
  /** The releases to show, newest first; null while closed. */
  releases: readonly WhatsNewRelease[] | null
  onClose: () => void
  /** Tabs are off for someone who chose Off, so the slide about them offers the switch. */
  tabsEnabled: boolean
  onEnableTabs: () => void
  onShowShortcuts: () => void
}

interface Slide {
  release: WhatsNewRelease
  icon: ReactNode
  title: string
  body: ReactNode
}

const ICON = 26

/**
 * What changed, one slide per feature: at launch the releases this profile has not seen (see
 * `WHATS_NEW_RELEASES`), and all of them when reopened from Preferences → Application. Drawn, not
 * screenshotted: a picture of the app would be a picture of someone's conversations.
 */
export default function WhatsNewModal({ releases, ...rest }: Props) {
  // The deck mounts on each open, so it always starts on its first slide.
  return releases ? <Deck releases={releases} {...rest} /> : null
}

function Deck({
  releases,
  onClose,
  tabsEnabled,
  onEnableTabs,
  onShowShortcuts
}: Omit<Props, 'releases'> & { releases: readonly WhatsNewRelease[] }) {
  // Take focus on open, as the other modals do, so keys reach the dialog rather than whatever was
  // focused behind it — a field there would keep Esc and whatever is typed.
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => panelRef.current?.focus(), [])
  const [index, setIndex] = useState(0)

  const slidesOf = (release: WhatsNewRelease): Omit<Slide, 'release'>[] => {
    switch (release) {
      case 'whatsNew:2':
        return [
          {
            icon: <EyeOff size={ICON} />,
            title: 'Hide conversations and folders',
            body: (
              <>
                Right-click a conversation or a folder and choose Hide to keep it out of the sidebar. A
                hidden conversation keeps its tab, and the bell still tells you when it needs you.
              </>
            )
          },
          {
            icon: <ListFilter size={ICON} />,
            title: 'Filter the sidebar',
            body: (
              <>
                The filter button at the top of the sidebar narrows it to live conversations, or shows what
                you’ve hidden so you can bring it back.
              </>
            )
          }
        ]
      case 'whatsNew:1':
        return [
          {
            icon: <SplitVertical size={ICON} />,
            title: 'Tabs and split view',
            body: (
              <>
                Keep several conversations open as tabs. Clicking one previews it in a tab; double-click,
                resume, or type to keep it. Tabs can be dragged, multi-selected, opened in split view and new
                windows, and reopened after closing. Right-click on a tab to open a menu and see the{' '}
                <button className="sb-whatsnew-link" onClick={onShowShortcuts}>
                  keyboard shortcuts
                </button>{' '}
                for more. Your tabs are always preserved, even when you quit or update the app. Choose
                whether a full tab strip wraps or scrolls in Preferences → Appearance.
                {!tabsEnabled && (
                  <button className="sb-setting-btn sb-whatsnew-action" onClick={onEnableTabs}>
                    Turn on tabs
                  </button>
                )}
              </>
            )
          },
          {
            icon: <Rows size={ICON} />,
            title: 'A compact sidebar',
            body: (
              <>
                Conversations take one line each; hover one for its preview, folder and last activity.
                Prefer more detail? Switch to Spacious in Preferences → Appearance → Sidebar.
              </>
            )
          },
          {
            icon: <Folder size={ICON} />,
            title: 'Folders',
            body: (
              <>
                Conversations are grouped by project folder, with pinned ones at the top of each. Collapse
                folders, drag them into your own order, or switch to All for a single list.
              </>
            )
          },
          {
            icon: <Bell size={ICON} />,
            title: 'The bell',
            body: (
              <>
                The bell in the top right shows what needs you. It pulses when an agent is waiting on your
                answer and turns solid when a turn has finished unread. Hover it to see them all and jump
                straight in.
              </>
            )
          }
        ]
    }
  }
  const slides: Slide[] = releases.flatMap((release) => slidesOf(release).map((s) => ({ release, ...s })))
  const last = slides.length - 1
  // A caption only tells the newest release from the older ones, so a deck of one release has none.
  const captioned = releases.length > 1

  return (
    <div className="sb-modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="sb-modal sb-modal-whatsnew"
        role="dialog"
        aria-modal="true"
        aria-label="What's new"
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') setIndex((i) => Math.min(last, i + 1))
          else if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1))
        }}
      >
        <div className="sb-modal-head">
          <h2 className="sb-modal-title">What’s new in Switchboard</h2>
          <button className="sb-modal-close" onClick={onClose} aria-label="Close">
            <Close size={16} />
          </button>
        </div>
        {/* Every slide shares one grid cell, so the deck is as tall as its tallest slide and the
            controls below stay put; only the current one is visible. */}
        <div className="sb-whatsnew-deck">
          {slides.map((s, i) => (
            <div
              key={s.title}
              className={`sb-whatsnew-slide${i === index ? ' current' : ''}`}
              aria-hidden={i !== index}
            >
              <span className="sb-whatsnew-icon">{s.icon}</span>
              {captioned && (
                <div className="sb-whatsnew-caption label-caps">
                  {s.release === releases[0] ? 'New' : 'Earlier'}
                </div>
              )}
              <div className="sb-whatsnew-title">{s.title}</div>
              <div className="sb-whatsnew-desc">{s.body}</div>
            </div>
          ))}
        </div>
        <p className="sb-whatsnew-again">Want to find this again? Preferences → Application.</p>
        <div className="sb-whatsnew-foot">
          <button
            className="sb-whatsnew-back"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={index === 0}
          >
            Back
          </button>
          {slides.length > 1 && (
            <div className="sb-whatsnew-dots">
              {slides.map((s, i) => (
                <button
                  key={s.title}
                  className={`sb-whatsnew-dot${i === index ? ' current' : ''}`}
                  onClick={() => setIndex(i)}
                  aria-label={`${s.title}, ${i + 1} of ${slides.length}`}
                  aria-current={i === index}
                />
              ))}
            </div>
          )}
          <button
            className="sb-whatsnew-done"
            onClick={() => (index === last ? onClose() : setIndex(index + 1))}
          >
            {index === last ? 'Got it' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}
