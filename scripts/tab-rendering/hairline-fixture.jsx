import React from 'react'
import { createRoot } from 'react-dom/client'
import ResizeHandle from '@renderer/components/ResizeHandle'
import '@renderer/styles/tokens.css'
import '@renderer/styles/global.css'
import '@renderer/styles/app.css'
import '@renderer/styles/pane.css'
import '@renderer/styles/rail.css'
import '@renderer/styles/tabs.css'
import '@renderer/styles/transcript.css'

window.auditErrors = []
window.addEventListener('error', event => window.auditErrors.push(event.message))
window.addEventListener('unhandledrejection', event => window.auditErrors.push(String(event.reason)))
window.configure = ({ theme }) => {
  if (theme) document.documentElement.dataset.theme = theme
}

// Twelve consecutive rail widths land the divider's edge at enough device-pixel phases that some of
// them round up at every zoom step. Rows stack at a height (31px) sharing no factor with the zoom
// steps' ratios, so the horizontal lines move through those phases too.
const RAIL_WIDTHS = Array.from({ length: 12 }, (_, i) => 48 + i)
const ROW_HEIGHT = 31
const noAction = () => {}

// Each row is a miniature of the app's layout: each kind of hairline the app draws, on the surface it
// sits on in the app. Container sizes are shrunk so a row fits; the lines themselves keep their real styles.
// The row's own background shows only where a line's box is wider than the line it paints, so it is a
// color no surface or rule uses.
function Row({ width }) {
  return <div className="hl-row" data-rail={width}
    style={{ height: ROW_HEIGHT, display: 'flex', flexDirection: 'column', background: 'var(--live-ink)' }}>
    <div className="sb-titlebar" style={{ height: 5, padding: 0 }} />
    <div className="hl-body" style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <div className="hl-rail" style={{ width, flex: 'none', background: 'var(--paper-sunken)' }}>
        <div className="sb-rail-head scrolled" style={{ height: 8, padding: 0 }} />
      </div>
      <ResizeHandle ariaLabel="Resize pane" onResize={noAction} onResizeEnd={noAction} onResizeStart={noAction} onReset={noAction} />
      <div className="sb-pane">
        <div className="sb-pane-header" style={{ height: 6, padding: 0 }} />
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '4px 12px 0' }}>
          <div className="sb-ctxmenu" style={{ position: 'static', minWidth: 0, width: 56, padding: 0, boxShadow: 'none', animation: 'none' }}>
            <div className="sb-ctxmenu-sep" />
          </div>
          <div style={{ width: 48, paddingTop: 5 }}>
            <div className="transcript-foot-rule" />
          </div>
          <div className="sb-chooser-other" style={{ width: 48, height: 4 }} />
          <div className="sb-tabstrip" style={{ '--tab-h': '14px' }}>
            <div className="sb-tab sb-tab-after-drag-gap" style={{ marginLeft: 8 }} />
          </div>
        </div>
      </div>
    </div>
  </div>
}

createRoot(document.querySelector('#root')).render(
  <div id="hairlines" style={{ margin: 8 }}>
    {RAIL_WIDTHS.map(width => <Row key={width} width={width} />)}
  </div>
)
