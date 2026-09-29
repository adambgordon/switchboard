/**
 * Default for the tabs-and-split preference when the user has never expressed one.
 *
 * Reserved as a genuine default, not a first-launch value: an ABSENT stored value means "never
 * chosen" and follows this constant, so flipping it later reaches everyone who has not opted out.
 * That only holds because the preference is written when the user changes it and never merely
 * because a window mounted — see `useTabsEnabled`.
 */
export const DEFAULT_TABS_ENABLED = true

/**
 * Read the stored preference, falling back to the default for anything that is not an explicit
 * boolean choice: absent (never chosen), unparseable, or present without an `enabled` field.
 *
 * Kept pure and React-free so this rule is reachable by a test; the hook around it cannot be
 * test-imported. Same split as `storageSync` and `theme`.
 *
 * `fallback` is a parameter rather than a closed-over constant for one reason: the rule is "absence
 * follows the default", and at any one default that is indistinguishable from a function that
 * simply returns that value. Passing the fallback in lets a test pin the rule at BOTH values, so a
 * flip of the default is covered rather than newly untested.
 */
export function parseTabsEnabled(
  raw: string | null,
  fallback: boolean = DEFAULT_TABS_ENABLED
): boolean {
  if (!raw) return fallback
  try {
    const stored = JSON.parse(raw) as { enabled?: unknown }
    return typeof stored.enabled === 'boolean' ? stored.enabled : fallback
  } catch {
    return fallback
  }
}
