import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import TabStrip from '@renderer/components/TabStrip'
import '@fontsource/hanken-grotesk/400.css'
import '@fontsource/hanken-grotesk/500.css'
import '@fontsource/hanken-grotesk/600.css'
import '@renderer/styles/tokens.css'
import '@renderer/styles/global.css'
import '@renderer/styles/tabs.css'

window.auditErrors = []
window.addEventListener('error', event => window.auditErrors.push(event.message))
window.addEventListener('unhandledrejection', event => window.auditErrors.push(String(event.reason)))
window.dragCalls = []
window.api = new Proxy({}, { get: (_, key) => () => {
  if (key === 'tabDragCancel' || key === 'tabDragDrop') window.dragCalls.push(key)
  return key === 'tabDragDrop' ? Promise.resolve('cancelled') : undefined
} })
const titles = ['Arithmetic sketch', 'Review examples in depth', 'Slider mechanics', 'Evaluate powers', 'Square root example', 'Review system thoroughly', 'Planning a moonlit picnic for seventeen imaginary penguins', 'Calculate square root']
const makeTabs = count => Array.from({ length: count }, (_, i) => ({
  sessionId: String(i), title: titles[i % titles.length], subtitle: null, preview: false, dot: null, unlinked: false
}))
const noAction = () => {}
function Fixture() {
  const [tabs, setTabs] = useState(makeTabs(8))
  const [layout, setLayout] = useState('wrap')
  const [active, setActive] = useState(6)
  const [secondary, setSecondary] = useState(false)
  window.configure = ({ count, layout: next, activeIndex, theme, secondary: second }) => {
    if (count !== undefined) setTabs(makeTabs(count))
    if (next) setLayout(next)
    if (activeIndex !== undefined) setActive(activeIndex)
    if (theme) document.documentElement.dataset.theme = theme
    if (second !== undefined) setSecondary(second)
  }
  const shared = {
    layout, canSplitRight: () => true, canMoveToOtherPane: false, onCloseOthers: noAction,
    onPromote: noAction, onShowInfo: noAction, onSplitRight: noAction, onMoveToOtherPane: noAction,
    onOpenInNewWindow: noAction, onMoveTab: () => window.dragCalls.push('move'), onTabLeftWindow: noAction,
    selectedIds: new Set(), onMoveTabGroup: () => window.dragCalls.push('moveGroup'), onResolveTargets: (_, id) => [id],
    onToggleSelect: noAction, onExtendSelect: noAction
  }
  return <div id="fixture" style={{ margin: 16, border: '1px solid var(--rule)', background: 'var(--paper-pane)' }}>
    <TabStrip {...shared} tabs={tabs} paneIndex={0} activeIndex={active} focused
      onActivate={(_, index) => setActive(index)} onClose={(_, index) => setTabs(current => current.filter((_, i) => i !== index))} />
    {secondary ? <div style={{ marginTop: 16 }}>
      <TabStrip {...shared} tabs={makeTabs(16).map(tab => ({ ...tab, sessionId: 'target-' + tab.sessionId }))}
        paneIndex={1} activeIndex={0} focused={false} onActivate={noAction} onClose={noAction} />
    </div> : null}
    <div style={{ height: 48 }} />
  </div>
}
createRoot(document.querySelector('#root')).render(<Fixture />)
