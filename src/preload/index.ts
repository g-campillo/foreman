import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/types'

function on(channel: string, cb: (payload: any) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: any): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  // sessions
  createSession: (init: unknown) => ipcRenderer.invoke(IPC.sessionCreate, init),
  resumeSession: (init: unknown) => ipcRenderer.invoke(IPC.sessionResume, init),
  closeSession: (sessionId: string) => ipcRenderer.invoke(IPC.sessionClose, { sessionId }),
  listSessions: () => ipcRenderer.invoke(IPC.sessionList),
  listPastSessions: (dir?: string) => ipcRenderer.invoke(IPC.sessionPastList, { dir }),
  sendMessage: (sessionId: string, text: string) =>
    ipcRenderer.invoke(IPC.sessionSend, { sessionId, text }),
  interrupt: (sessionId: string) => ipcRenderer.invoke(IPC.sessionInterrupt, { sessionId }),
  setPermissionMode: (sessionId: string, mode: string) =>
    ipcRenderer.invoke(IPC.sessionSetMode, { sessionId, mode }),
  setModel: (sessionId: string, model: string) =>
    ipcRenderer.invoke(IPC.sessionSetModel, { sessionId, model }),
  supportedModels: (sessionId: string) => ipcRenderer.invoke(IPC.sessionModels, { sessionId }),

  // read-only panels
  contextUsage: (sessionId: string) => ipcRenderer.invoke(IPC.sessionContextUsage, { sessionId }),
  accountInfo: (sessionId: string) => ipcRenderer.invoke(IPC.sessionAccount, { sessionId }),
  usageInfo: (sessionId: string) => ipcRenderer.invoke(IPC.sessionUsage, { sessionId }),
  supportedAgents: (sessionId: string) => ipcRenderer.invoke(IPC.sessionAgents, { sessionId }),
  mcpStatus: (sessionId: string) => ipcRenderer.invoke(IPC.sessionMcpStatus, { sessionId }),
  reloadSkills: (sessionId: string) => ipcRenderer.invoke(IPC.sessionReloadSkills, { sessionId }),

  // permissions
  respondPermission: (requestId: string, behavior: 'allow' | 'deny') =>
    ipcRenderer.invoke(IPC.permRespond, { requestId, behavior }),

  // MCP elicitation
  respondElicitation: (
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>,
  ) => ipcRenderer.invoke(IPC.elicitRespond, { requestId, action, content }),

  // diffs
  listDiffs: (sessionId: string, cwd: string) =>
    ipcRenderer.invoke(IPC.diffList, { sessionId, cwd }),
  revertFile: (sessionId: string, path: string) =>
    ipcRenderer.invoke(IPC.diffRevert, { sessionId, path }),
  clearDiffs: (sessionId: string) => ipcRenderer.invoke(IPC.diffClear, { sessionId }),

  // terminal
  startPty: (sessionId: string, cwd: string, cols: number, rows: number) =>
    ipcRenderer.invoke(IPC.ptyStart, { sessionId, cwd, cols, rows }),
  writePty: (sessionId: string, data: string) =>
    ipcRenderer.invoke(IPC.ptyWrite, { sessionId, data }),
  resizePty: (sessionId: string, cols: number, rows: number) =>
    ipcRenderer.invoke(IPC.ptyResize, { sessionId, cols, rows }),
  killPty: (sessionId: string) => ipcRenderer.invoke(IPC.ptyKill, { sessionId }),

  // misc
  pickDirectory: () => ipcRenderer.invoke(IPC.pickDirectory),
  initialProject: () => ipcRenderer.invoke('app:initialProject'),
  setVibrancy: (v: string | null) => ipcRenderer.invoke('app:vibrancy', { v }),

  // events
  onItem: (cb: (p: any) => void) => on(IPC.evtItem, cb),
  onDelta: (cb: (p: any) => void) => on(IPC.evtDelta, cb),
  onMeta: (cb: (p: any) => void) => on(IPC.evtMeta, cb),
  onRemoved: (cb: (p: any) => void) => on(IPC.evtRemoved, cb),
  onPermissionRequest: (cb: (p: any) => void) => on(IPC.permRequest, cb),
  onPermissionResolved: (cb: (p: any) => void) => on(IPC.permResolved, cb),
  onElicitationRequest: (cb: (p: any) => void) => on(IPC.elicitRequest, cb),
  onElicitationResolved: (cb: (p: any) => void) => on(IPC.elicitResolved, cb),
  onDiffChanged: (cb: (p: any) => void) => on(IPC.evtDiffChanged, cb),
  onPtyData: (cb: (p: any) => void) => on(IPC.evtPtyData, cb),
  onPtyExit: (cb: (p: any) => void) => on(IPC.evtPtyExit, cb),
}

contextBridge.exposeInMainWorld('foreman', api)

export type ForemanApi = typeof api
