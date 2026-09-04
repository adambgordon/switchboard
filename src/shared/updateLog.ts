export const MAX_UPDATE_LOG_CHARS = 64 * 1024

export function appendUpdateLog(current: string, chunk: string): string {
  const next = current + chunk
  return next.length <= MAX_UPDATE_LOG_CHARS ? next : next.slice(-MAX_UPDATE_LOG_CHARS)
}
