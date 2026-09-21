import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import TranscriptView from '@renderer/components/TranscriptView'
import '@fontsource/hanken-grotesk/400.css'
import '@fontsource/hanken-grotesk/500.css'
import '@fontsource/hanken-grotesk/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@renderer/styles/tokens.css'
import '@renderer/styles/global.css'
import '@renderer/styles/transcript.css'

window.copyErrors = []
window.addEventListener('error', event => window.copyErrors.push(event.message))
window.addEventListener('unhandledrejection', event => window.copyErrors.push(String(event.reason)))
window.api = {
  onRefreshStart: () => () => {}, onRefreshEnd: () => () => {},
  codeContextMenu: value => { window.contextCopy = value },
  linkContextMenu: value => { window.contextCopy = value }
}
Object.defineProperty(navigator, 'clipboard', { value: { writeText: value => {
  window.buttonCopy = value
  return Promise.resolve()
} } })
const root = createRoot(document.getElementById('root'))
const scrollStateRef = { current: new Map() }
let serial = 0, transcript, markdown = true, width = 760, copyFault = null
window.copyFault = stage => { copyFault = stage }
const render = () => flushSync(() => root.render(
  <div style={{ width, height: 700, display: 'flex', background: 'var(--paper-pane)' }}>
    <TranscriptView transcript={transcript} loading={false} messageCount={transcript.messages.length}
      scrollStateRef={scrollStateRef} markdownCopy={markdown} />
  </div>
))
window.mountCopy = ({ source = '', blocks, messages, agent = 'claude', theme = 'light', mode = 'markdown', size = 760 }) => {
  window.getSelection().removeAllRanges()
  document.documentElement.dataset.theme = theme
  markdown = mode === 'markdown'
  width = size
  transcript = { sessionId: 'copy-fixture-' + serial++, agent, messages: messages ?? [{
    uuid: 'm', role: 'assistant', timestamp: null, isSidechain: false,
    blocks: blocks ?? [{ kind: 'text', text: source }]
  }] }
  render()
}
window.copyMode = mode => { markdown = mode === 'markdown'; render() }
window.copyWidth = size => { width = size; render() }
function element(selector, index = 0) {
  const found = document.querySelectorAll(selector)[index]
  if (!found) throw new Error('Missing fixture element: ' + selector + ' [' + index + ']')
  return found
}
function point(selector, offset, index = 0) {
  const el = element(selector, index)
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const nodes = []
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (!node.parentElement.closest('button,[data-md-skip]') || el.closest('[data-md-skip]')) nodes.push(node)
  }
  for (const node of nodes) {
    if (offset <= node.length) return [node, offset]
    offset -= node.length
  }
  throw new Error('Fixture offset out of bounds: ' + selector + ':' + offset)
}
function dispatch(range, reverse) {
  const selection = window.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  if (reverse) selection.setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset)
  const data = new DataTransfer()
  if (copyFault === 'clipboard-write') data.setData = () => { throw new Error('private clipboard content') }
  const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data })
  const scroll = element('.transcript-scroll'), query = scroll.querySelectorAll
  const ownQuery = Object.getOwnPropertyDescriptor(scroll, 'querySelectorAll')
  let collections = 0
  scroll.querySelectorAll = function (...args) {
    collections++
    if (copyFault === 'collection') throw new Error('private selection content')
    return query.apply(this, args)
  }
  const diagnostics = [], warn = console.warn, error = console.error
  console.warn = (...args) => diagnostics.push({ level: 'warn', args })
  console.error = (...args) => diagnostics.push({ level: 'error', args })
  try {
    scroll.dispatchEvent(event)
  } finally {
    if (ownQuery) Object.defineProperty(scroll, 'querySelectorAll', ownQuery)
    else delete scroll.querySelectorAll
    console.warn = warn
    console.error = error
    copyFault = null
  }
  return { text: data.getData('text/plain'), prevented: event.defaultPrevented, types: Array.from(data.types), collections, diagnostics }
}
window.copyRange = (start, end, reverse = false) => {
  const range = document.createRange()
  range.setStart(...point(...start))
  range.setEnd(...point(...end))
  return dispatch(range, reverse)
}
window.copyBreakTail = (selector, from, to, reverse = false) => {
  const text = element(selector).querySelector('br').nextSibling
  if (!text || text.nodeType !== Node.TEXT_NODE) throw new Error('Missing renderer newline after break')
  const range = document.createRange()
  range.setStart(text, from)
  range.setEnd(text, to)
  return dispatch(range, reverse)
}
window.copyNodes = (start, end = start, reverse = false) => {
  const range = document.createRange()
  range.setStartBefore(element(...start))
  range.setEndAfter(element(...end))
  return dispatch(range, reverse)
}
window.copyCurrent = () => {
  const selection = window.getSelection()
  return selection.rangeCount ? dispatch(selection.getRangeAt(0).cloneRange(), false)
    : { text: '', prevented: false, types: [] }
}
window.copyContents = (selector, index = 0) => {
  const range = document.createRange()
  range.selectNodeContents(element(selector, index))
  return dispatch(range, false)
}
window.copyButton = label => {
  window.buttonCopy = null
  element('[aria-label="' + label + '"]').click()
  return window.buttonCopy
}
window.openTools = () => { for (const details of document.querySelectorAll('details.tool-run')) details.open = true }
window.expandResult = () => element('.tool-result-toggle').click()
window.clampExpected = () => {
  const pre = element('.tool-result-text'), clip = element('.tool-result-clip')
  const range = document.createRange()
  range.selectNodeContents(pre)
  const bound = clip.getBoundingClientRect()
  const lines = Array.from(range.getClientRects()).filter(rect => rect.top < bound.bottom && rect.bottom > bound.top)
  const last = lines[lines.length - 1]
  // Hit-testing the faded line can land on the Expand overlay. Enumerate native line rectangles
  // instead: this linear oracle is independent of the collector's binary search at the clip edge.
  const lineCount = Math.round(parseFloat(getComputedStyle(clip).maxHeight) / parseFloat(getComputedStyle(pre).lineHeight))
  const positions = []
  let end = 0
  for (let i = 0; i < pre.firstChild.length; i++) {
    range.setStart(pre.firstChild, i)
    range.setEnd(pre.firstChild, i + 1)
    const rect = range.getBoundingClientRect()
    if (!positions.some(top => Math.abs(top - rect.top) < 0.5)) positions.push(rect.top)
    if (positions.length > lineCount) break
    end = i + 1
  }
  return { prefix: pre.textContent.slice(0, end), full: pre.textContent, lines: lines.length, bounds: bound.toJSON() }
}
window.copyStats = () => ({ errors: window.copyErrors, articles: document.querySelectorAll('article.message').length })
