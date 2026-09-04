import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IPC, type SwitchboardApi, type WindowInit } from '../shared/types'
import { sanitizeTabLayout } from '../shared/tabWorkspace'

function subscribe(channel: string, cb: (...args: never[]) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]): void =>
    (cb as (...a: unknown[]) => void)(...args)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: SwitchboardApi = {
  listConversations: () => ipcRenderer.invoke(IPC.sessionsList),
  getTranscript: (id, revision) => ipcRenderer.invoke(IPC.sessionsGet, id, revision),
  onSessionsChanged: (cb) => subscribe(IPC.sessionsChanged, cb as never),
  renameConversation: (id, title) => ipcRenderer.invoke(IPC.sessionsRename, id, title),

  resume: (sessionId, cwd, agent, title) => ipcRenderer.invoke(IPC.ptyResume, sessionId, cwd, agent, title),
  startNew: (cwd, agent) => ipcRenderer.invoke(IPC.ptyStartNew, cwd, agent),
  sendInput: (ptyId, data) => ipcRenderer.send(IPC.ptyInput, ptyId, data),
  resize: (ptyId, cols, rows) => ipcRenderer.send(IPC.ptyResize, ptyId, cols, rows),
  kill: (ptyId) => ipcRenderer.send(IPC.ptyKill, ptyId),
  setPtyOutputPaused: (ptyId, paused) =>
    ipcRenderer.send(paused ? IPC.ptyFlowPause : IPC.ptyFlowResume, ptyId),
  onPtyData: (cb) => subscribe(IPC.ptyData, cb as never),
  onPtyExit: (cb) => subscribe(IPC.ptyExit, cb as never),
  onPtyBound: (cb) => subscribe(IPC.ptyBound, cb as never),
  listActive: () => ipcRenderer.invoke(IPC.ptyActiveList),
  onActiveChanged: (cb) => subscribe(IPC.ptyActiveChanged, cb as never),
  setMaxLiveSessions: (n) => ipcRenderer.send(IPC.ptySetMaxLive, n),
  listAgents: () => ipcRenderer.invoke(IPC.agentsAvailable),

  pickDirectory: () => ipcRenderer.invoke(IPC.dialogPickDirectory),
  openExternal: (url) => ipcRenderer.send(IPC.openExternal, url),
  linkContextMenu: (url) => ipcRenderer.send(IPC.linkContextMenu, url),
  codeContextMenu: (code) => ipcRenderer.send(IPC.codeContextMenu, code),
  tabContextMenu: (opts) => ipcRenderer.invoke(IPC.tabContextMenu, opts),
  onMenuCloseTab: (cb) => subscribe(IPC.menuCloseTab, cb as never),
  closeWindow: () => ipcRenderer.send(IPC.windowClose),
  openConversationWindow: (payload) => ipcRenderer.send(IPC.windowOpenConversation, payload),
  tabDragBegin: (payload) => ipcRenderer.send(IPC.tabDragBegin, payload),
  tabDragHover: () => ipcRenderer.send(IPC.tabDragHover),
  tabDragDrop: () => ipcRenderer.invoke(IPC.tabDragDrop),
  tabDragCancel: () => ipcRenderer.send(IPC.tabDragCancel),
  onTabDragOver: (cb) => subscribe(IPC.tabDragOver, cb as never),
  onTabDragLeave: (cb) => subscribe(IPC.tabDragLeave, cb as never),
  onTabDropHere: (cb) => subscribe(IPC.tabDropHere, cb as never),
  tabsChanged: (sessionIds) => ipcRenderer.send(IPC.tabsChanged, sessionIds),
  persistTabLayout: (layout) => ipcRenderer.send(IPC.tabWorkspaceChanged, layout),
  onTabsElsewhere: (cb) => subscribe(IPC.tabsElsewhere, cb as never),
  revealConversation: (sessionId) => ipcRenderer.send(IPC.conversationReveal, sessionId),
  resumeConversationElsewhere: (sessionId) => ipcRenderer.send(IPC.conversationResume, sessionId),
  claimConversation: (sessionId) => ipcRenderer.send(IPC.conversationClaim, sessionId),
  onTabActivate: (cb) => subscribe(IPC.tabActivate, cb as never),
  onTabResume: (cb) => subscribe(IPC.tabResume, cb as never),
  onTabRelease: (cb) => subscribe(IPC.tabRelease, cb as never),
  shouldReleaseTab: (sessionId) => ipcRenderer.invoke(IPC.tabShouldRelease, sessionId),
  claimTerminal: (ptyId) => ipcRenderer.invoke(IPC.ptyClaim, ptyId),
  onPtySnapshotRequest: (cb) => subscribe(IPC.ptySnapshotRequest, cb as never),
  replyPtySnapshot: (requestId, ptyId, snapshot) =>
    ipcRenderer.send(IPC.ptySnapshotReply, requestId, ptyId, snapshot),
  onPtySnapshotStage: (cb) => subscribe(IPC.ptySnapshotStage, cb as never),
  confirmPtySnapshotRestored: (ptyId) => ipcRenderer.send(IPC.ptySnapshotRestored, ptyId),
  setBackgroundColor: (color) => ipcRenderer.send(IPC.windowSetBackgroundColor, color),
  syncTrafficLights: () => ipcRenderer.send(IPC.windowSyncTrafficLights),
  onRefreshStart: (cb) => subscribe(IPC.appRefreshStart, cb as never),
  onRefreshEnd: (cb) => subscribe(IPC.appRefreshEnd, cb as never),
  setDockIcon: (dark) => ipcRenderer.send(IPC.windowSetDockIcon, dark),
  isWindowFocused: () => ipcRenderer.invoke(IPC.windowIsFocused),
  onWindowFocusChanged: (cb) => subscribe(IPC.windowFocusChanged, cb as never),

  getPathForFile: (file) => webUtils.getPathForFile(file),

  getUpdateInfo: () => ipcRenderer.invoke(IPC.updatesGetInfo),
  checkForUpdates: (force = false) => ipcRenderer.invoke(IPC.updatesCheck, force),
  runUpdate: () => ipcRenderer.invoke(IPC.updatesRun),
  onUpdateProgress: (cb) => subscribe(IPC.updatesProgress, cb as never),
  getUpdateRunState: () => ipcRenderer.invoke(IPC.updatesRunStateGet),
  onUpdateRunState: (cb) => subscribe(IPC.updatesRunStateChanged, cb as never),
  relaunchForUpdate: () => ipcRenderer.send(IPC.updatesRelaunch)
}

contextBridge.exposeInMainWorld('api', api)
contextBridge.exposeInMainWorld('platform', process.platform)
// Dev-only: the label from SWITCHBOARD_DEV_LABEL so the
// renderer can badge the wordmark — distinguishes parallel `npm run dev` windows. null in
// normal/packaged runs. (Preload has process access; sandbox is off for the ESM preload.)
contextBridge.exposeInMainWorld('devLabel', process.env.SWITCHBOARD_DEV_LABEL?.trim() || null)

/**
 * What this window was opened to show, delivered through `webPreferences.additionalArguments` rather
 * than an IPC round trip.
 *
 * Synchronous is the whole point: the rail's collapsed state has to be known for the FIRST render of a
 * detached window, and an async answer would show the browser for a frame and then snap it shut. Falls
 * back to an ordinary browser window when the flag is absent.
 */
const WINDOW_FLAG = '--sb-window='
function readWindowInit(): WindowInit {
  const arg = process.argv.find((a) => a.startsWith(WINDOW_FLAG))
  if (!arg) {
    return {
      sessionIds: [],
      activeSessionId: null,
      restoredTabs: null,
      primary: true,
      collapseRail: false
    }
  }
  try {
    const parsed = JSON.parse(arg.slice(WINDOW_FLAG.length)) as Partial<WindowInit>
    const sessionIds = Array.isArray(parsed.sessionIds)
      ? [...new Set(parsed.sessionIds.filter((id): id is string => typeof id === 'string' && !!id))]
      : []
    return {
      sessionIds,
      activeSessionId:
        typeof parsed.activeSessionId === 'string' && sessionIds.includes(parsed.activeSessionId)
          ? parsed.activeSessionId
          : sessionIds[0] ?? null,
      restoredTabs: sanitizeTabLayout(parsed.restoredTabs),
      primary: parsed.primary === true,
      collapseRail: parsed.collapseRail === true
    }
  } catch {
    return {
      sessionIds: [],
      activeSessionId: null,
      restoredTabs: null,
      primary: true,
      collapseRail: false
    }
  }
}
contextBridge.exposeInMainWorld('sbWindow', readWindowInit())
// Dev-only: hold the updater UI in its in-flight state for visual checks.
contextBridge.exposeInMainWorld('fakeUpdating', process.env.SWITCHBOARD_FAKE_UPDATING === '1')
