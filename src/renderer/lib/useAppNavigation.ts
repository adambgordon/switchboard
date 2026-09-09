import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { sameVisit, type NavigationCommand, type NavigationVisit } from '@shared/navigation'

interface ReportedVisit {
  visit: NavigationVisit | null
  intent: number
}

/** Renderer adapter: local actions paint immediately; only tagged remote activation needs an ack. */
export function useAppNavigation(
  apply: RefObject<((command: NavigationCommand) => void) | null>,
  hidden: ReadonlySet<string>
) {
  const hiddenRef = useRef(hidden)
  hiddenRef.current = hidden
  const pending = useRef<NavigationCommand | null>(null)
  const latestRequest = useRef(0)
  // Intent rejects queued activations; generation also invalidates asynchronous work on replay/blur.
  const intent = useRef(0)
  const generation = useRef(0)
  const chosenView = useRef<NavigationVisit | null>(null)
  const reported = useRef<ReportedVisit | null>(null)
  const [, render] = useState(0)

  useLayoutEffect(() => {
    const offActivate = window.api.onTabActivate((command) => {
      if (command.requestId <= latestRequest.current) return
      latestRequest.current = command.requestId
      if (command.targetRevision !== intent.current || hiddenRef.current.has(command.sessionId)) {
        window.api.completeNavigation(command.requestId, null)
        return
      }
      generation.current += 1
      chosenView.current = null
      pending.current = command
      apply.current?.(command)
      // An already-active tab still needs a committed acknowledgement.
      render((n) => n + 1)
    })
    const offCancel = window.api.onNavigationCancelled((requestId) => {
      latestRequest.current = Math.max(latestRequest.current, requestId)
      if (pending.current?.requestId === requestId) pending.current = null
    })
    const offFocus = window.api.onWindowFocusChanged((focused) => {
      if (!focused) generation.current += 1
    })
    return () => { offActivate(); offCancel(); offFocus() }
  }, [apply])

  useLayoutEffect(() => {
    if (pending.current && hidden.has(pending.current.sessionId)) {
      pending.current = null
      generation.current += 1
    }
  }, [hidden])

  const beginVisit = useCallback((view: NavigationVisit | null = null) => {
    pending.current = null
    chosenView.current = view
    intent.current += 1
    const started = ++generation.current
    window.api.interruptNavigation(intent.current)
    render((n) => n + 1)
    return () => generation.current === started
  }, [])

  const go = useCallback((direction: -1 | 1) => {
    generation.current += 1
    chosenView.current = null
    window.api.stepNavigation(direction)
  }, [])

  const rekey = useCallback((from: string, to: string) => {
    if (pending.current?.sessionId === from) pending.current = { ...pending.current, sessionId: to }
    const last = reported.current
    if (last?.visit?.sessionId === from) last.visit = { ...last.visit, sessionId: to }
    if (chosenView.current?.sessionId === from) chosenView.current = { ...chosenView.current, sessionId: to }
  }, [])

  const report = useCallback((visit: NavigationVisit | null, terminalAvailable: boolean) => {
    const command = pending.current
    if (command) {
      if (visit?.sessionId !== command.sessionId) return
      if (command.view !== null && visit.view !== command.view &&
        !(command.view === 'terminal' && !terminalAvailable)) return
      pending.current = null
      reported.current = { visit, intent: intent.current }
      window.api.completeNavigation(command.requestId, visit)
      return
    }
    const previous = reported.current
    if (previous && sameVisit(previous.visit, visit) && previous.intent === intent.current) return
    const choiceArrived = chosenView.current !== null && sameVisit(chosenView.current, visit)
    if (choiceArrived) chosenView.current = null
    const cleanup = previous?.visit && hiddenRef.current.has(previous.visit.sessionId) && previous.intent === intent.current
    const record = !cleanup && (!previous || previous.visit?.sessionId !== visit?.sessionId || previous.intent !== intent.current || choiceArrived)
    reported.current = { visit, intent: intent.current }
    window.api.reportNavigation(visit, record, intent.current)
  }, [])

  return { beginVisit, go, rekey, report }
}
