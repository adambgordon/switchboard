import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IPC, type SwitchboardApi } from '../shared/types'

function subscribe(channel: string, cb: (...args: never[]) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]): void =>
    (cb as (...a: unknown[]) => void)(...args)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: SwitchboardApi = {
  listConversations: () => ipcRenderer.invoke(IPC.sessionsList),
  getTranscript: (id) => ipcRenderer.invoke(IPC.sessionsGet, id),
  onSessionsChanged: (cb) => subscribe(IPC.sessionsChanged, cb as never),
  renameConversation: (id, title) => ipcRenderer.invoke(IPC.sessionsRename, id, title),

  resume: (sessionId, cwd, agent, title) => ipcRenderer.invoke(IPC.ptyResume, sessionId, cwd, agent, title),
  startNew: (cwd, agent) => ipcRenderer.invoke(IPC.ptyStartNew, cwd, agent),
  sendInput: (ptyId, data) => ipcRenderer.send(IPC.ptyInput, ptyId, data),
  resize: (ptyId, cols, rows) => ipcRenderer.send(IPC.ptyResize, ptyId, cols, rows),
  kill: (ptyId) => ipcRenderer.send(IPC.ptyKill, ptyId),
  onPtyData: (cb) => subscribe(IPC.ptyData, cb as never),
  onPtyExit: (cb) => subscribe(IPC.ptyExit, cb as never),
  onPtyBound: (cb) => subscribe(IPC.ptyBound, cb as never),
  listActive: () => ipcRenderer.invoke(IPC.ptyActiveList),
  onActiveChanged: (cb) => subscribe(IPC.ptyActiveChanged, cb as never),
  setMaxLiveSessions: (n) => ipcRenderer.send(IPC.ptySetMaxLive, n),
  listAgents: () => ipcRenderer.invoke(IPC.agentsAvailable),

  pickDirectory: () => ipcRenderer.invoke(IPC.dialogPickDirectory),
  openExternal: (url) => ipcRenderer.send(IPC.openExternal, url),
  setBackgroundColor: (color) => ipcRenderer.send(IPC.windowSetBackgroundColor, color),
  syncTrafficLights: () => ipcRenderer.send(IPC.windowSyncTrafficLights),
  onRefreshStart: (cb) => subscribe(IPC.appRefreshStart, cb as never),
  onRefreshEnd: (cb) => subscribe(IPC.appRefreshEnd, cb as never),
  setDockIcon: (dark) => ipcRenderer.send(IPC.windowSetDockIcon, dark),

  getPathForFile: (file) => webUtils.getPathForFile(file),

  getUpdateInfo: () => ipcRenderer.invoke(IPC.updatesGetInfo),
  checkForUpdates: () => ipcRenderer.invoke(IPC.updatesCheck),
  runUpdate: () => ipcRenderer.invoke(IPC.updatesRun),
  onUpdateProgress: (cb) => subscribe(IPC.updatesProgress, cb as never),
  relaunchForUpdate: () => ipcRenderer.send(IPC.updatesRelaunch)
}

contextBridge.exposeInMainWorld('api', api)
contextBridge.exposeInMainWorld('platform', process.platform)
// Dev-only: the label from SWITCHBOARD_DEV_LABEL so the
// renderer can badge the wordmark — distinguishes parallel `npm run dev` windows. null in
// normal/packaged runs. (Preload has process access; sandbox is off for the ESM preload.)
contextBridge.exposeInMainWorld('devLabel', process.env.SWITCHBOARD_DEV_LABEL?.trim() || null)
// Dev-only: hold the updater UI in its in-flight state for visual checks.
contextBridge.exposeInMainWorld('fakeUpdating', process.env.SWITCHBOARD_FAKE_UPDATING === '1')
