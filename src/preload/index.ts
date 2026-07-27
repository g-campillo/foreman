import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type PermissionMode } from '../shared/types'

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
  replaySessions: () => ipcRenderer.invoke(IPC.sessionReplay),

  // time travel + actions
  rewind: (sessionId: string, messageId: string, dryRun: boolean) =>
    ipcRenderer.invoke(IPC.sessionRewind, { sessionId, messageId, dryRun }),
  setEffort: (sessionId: string, effort: string | null) =>
    ipcRenderer.invoke(IPC.sessionSetEffort, { sessionId, effort }),
  backgroundTasks: (sessionId: string, toolUseId?: string) =>
    ipcRenderer.invoke(IPC.sessionBackground, { sessionId, toolUseId }),
  stopTask: (sessionId: string, taskId: string) =>
    ipcRenderer.invoke(IPC.sessionStopTask, { sessionId, taskId }),
  toggleMcp: (sessionId: string, name: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC.mcpToggle, { sessionId, name, enabled }),
  reconnectMcp: (sessionId: string, name: string) =>
    ipcRenderer.invoke(IPC.mcpReconnect, { sessionId, name }),
  setMcpPermissionOverride: (sessionId: string, name: string, mode: string | null) =>
    ipcRenderer.invoke(IPC.mcpPermissionOverride, { sessionId, name, mode }),

  // history
  sessionTranscript: (sessionId: string, dir?: string) =>
    ipcRenderer.invoke(IPC.sessionTranscript, { sessionId, dir }),
  searchTranscripts: (query: string, dir?: string) =>
    ipcRenderer.invoke(IPC.sessionSearch, { query, dir }),
  forkSession: (sessionId: string, upToMessageId?: string, title?: string) =>
    ipcRenderer.invoke(IPC.sessionFork, { sessionId, upToMessageId, title }),
  renameSession: (sessionId: string, title: string) =>
    ipcRenderer.invoke(IPC.sessionRename, { sessionId, title }),
  sendMessage: (sessionId: string, content: unknown) =>
    ipcRenderer.invoke(IPC.sessionSend, { sessionId, content }),
  cancelQueued: (sessionId: string, itemId: string) =>
    ipcRenderer.invoke(IPC.sessionCancelQueued, { sessionId, itemId }),
  supportedCommands: (sessionId: string) =>
    ipcRenderer.invoke(IPC.sessionCommands, { sessionId }),
  projectFiles: (sessionId: string) => ipcRenderer.invoke(IPC.sessionFiles, { sessionId }),
  interrupt: (sessionId: string) => ipcRenderer.invoke(IPC.sessionInterrupt, { sessionId }),
  setPermissionMode: (sessionId: string, mode: string) =>
    ipcRenderer.invoke(IPC.sessionSetMode, { sessionId, mode }),
  setModel: (sessionId: string, model: string) =>
    ipcRenderer.invoke(IPC.sessionSetModel, { sessionId, model }),
  supportedModels: (sessionId: string) => ipcRenderer.invoke(IPC.sessionModels, { sessionId }),

  // read-only panels
  contextUsage: (sessionId: string) => ipcRenderer.invoke(IPC.sessionContextUsage, { sessionId }),
  listUsage: () => ipcRenderer.invoke(IPC.usageList),
  accountInfo: (sessionId: string) => ipcRenderer.invoke(IPC.sessionAccount, { sessionId }),
  usageInfo: (sessionId: string) => ipcRenderer.invoke(IPC.sessionUsage, { sessionId }),
  supportedAgents: (sessionId: string) => ipcRenderer.invoke(IPC.sessionAgents, { sessionId }),
  mcpStatus: (sessionId: string) => ipcRenderer.invoke(IPC.sessionMcpStatus, { sessionId }),
  reloadSkills: (sessionId: string) => ipcRenderer.invoke(IPC.sessionReloadSkills, { sessionId }),

  // permissions
  respondPermission: (
    requestId: string,
    behavior: 'allow' | 'deny',
    message?: string,
    /** Switch the session to this mode as part of the same allow. */
    setMode?: PermissionMode,
  ) => ipcRenderer.invoke(IPC.permRespond, { requestId, behavior, message, setMode }),

  // MCP elicitation
  respondElicitation: (
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>,
  ) => ipcRenderer.invoke(IPC.elicitRespond, { requestId, action, content }),

  // diffs
  listDiffs: (sessionId: string, cwd: string) =>
    ipcRenderer.invoke(IPC.diffList, { sessionId, cwd }),
  revertFile: (sessionId: string, cwd: string, path: string) =>
    ipcRenderer.invoke(IPC.diffRevert, { sessionId, cwd, path }),
  commitFiles: (sessionId: string, cwd: string, paths: string[], message: string) =>
    ipcRenderer.invoke(IPC.diffCommit, { sessionId, cwd, paths, message }),

  // terminal
  startPty: (sessionId: string, cwd: string, cols: number, rows: number) =>
    ipcRenderer.invoke(IPC.ptyStart, { sessionId, cwd, cols, rows }),
  writePty: (sessionId: string, data: string) =>
    ipcRenderer.invoke(IPC.ptyWrite, { sessionId, data }),
  resizePty: (sessionId: string, cols: number, rows: number) =>
    ipcRenderer.invoke(IPC.ptyResize, { sessionId, cols, rows }),
  killPty: (sessionId: string) => ipcRenderer.invoke(IPC.ptyKill, { sessionId }),

  // misc
  pendingRequests: () => ipcRenderer.invoke(IPC.pendingList),
  pickDirectory: () => ipcRenderer.invoke(IPC.pickDirectory),
  initialProject: () => ipcRenderer.invoke('app:initialProject'),
  setVibrancy: (v: string | null) => ipcRenderer.invoke('app:vibrancy', { v }),
  setTrafficLights: (on: boolean) => ipcRenderer.invoke('app:trafficLights', { on }),
  setAgentPolicy: (policy: {
    lifetime: 'persist' | 'stop'
    idleMinutes: number
    notifications: boolean
  }) => ipcRenderer.invoke(IPC.agentPolicy, policy),

  // events
  onItem: (cb: (p: any) => void) => on(IPC.evtItem, cb),
  onDelta: (cb: (p: any) => void) => on(IPC.evtDelta, cb),
  onMeta: (cb: (p: any) => void) => on(IPC.evtMeta, cb),
  onRemoved: (cb: (p: any) => void) => on(IPC.evtRemoved, cb),
  onQueue: (cb: (p: any) => void) => on(IPC.evtQueue, cb),
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
