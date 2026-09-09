export type DeferredResumeAction = 'cancel' | 'wait' | 'resume'

/** Decide whether a routed Resume still belongs to the tab that originally received it. */
export function deferredResumeAction(
  tabPresent: boolean,
  metadataPresent: boolean
): DeferredResumeAction {
  if (!tabPresent) return 'cancel'
  return metadataPresent ? 'resume' : 'wait'
}
