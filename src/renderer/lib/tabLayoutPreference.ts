export type TabLayout = 'wrap' | 'scroll'

export const DEFAULT_TAB_LAYOUT: TabLayout = 'wrap'

export function parseTabLayout(
  raw: string | null,
  fallback: TabLayout = DEFAULT_TAB_LAYOUT
): TabLayout {
  return raw === 'wrap' || raw === 'scroll' ? raw : fallback
}
