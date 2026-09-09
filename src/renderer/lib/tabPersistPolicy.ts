/** What to do with the saved tab workspace when the preference or the layout changes. */
export type TabPersistAction = 'activate' | 'persist' | 'clear' | 'ignore'

/**
 * Decide from the preference's PREVIOUS and current value, never from its current value alone.
 *
 * Clearing the saved workspace is the right response to the user actively switching the feature
 * off — the tabs they had are not coming back and should not reappear later. It is the wrong
 * response to the feature merely BEING off, which is the state every launch starts in now that the
 * default is off. Deciding on the current value alone conflates the two, so the first launch with
 * the toggle off deletes a layout the user never asked to lose.
 *
 * `ignore` is therefore a distinct outcome from `clear`, not a variant of it: while the feature is
 * off the window holds a single preview tab, so persisting that would overwrite a saved multi-tab
 * layout just as surely as clearing it. Off means leave the file alone.
 */
export function tabPersistAction(wasEnabled: boolean, isEnabled: boolean): TabPersistAction {
  if (!wasEnabled && isEnabled) return 'activate'
  if (isEnabled) return 'persist'
  return wasEnabled ? 'clear' : 'ignore'
}

/** Layout writes stay blocked until any dormant primary layout has committed in the reducer. */
export function canPersistTabWorkspace(enabled: boolean, ready: boolean): boolean {
  return enabled && ready
}

export function restoredWorkspaceApplied(
  pendingLayoutKey: string | null,
  currentLayoutKey: string
): boolean {
  return pendingLayoutKey !== null && pendingLayoutKey === currentLayoutKey
}
