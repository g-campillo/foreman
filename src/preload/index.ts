import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC,
  type BranchList,
  type CheckoutResult,
  type McpActionResult,
  type McpStatus,
  type PermissionAnswer,
} from '../shared/types'

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
  /* Annotated where every other channel here is inferred as `any`, because the
     failure reason is the entire point: it has to reach the panel typed, or the
     renderer silently ignores it exactly as the old `void` did. */
  reconnectMcp: (sessionId: string, name: string): Promise<McpActionResult> =>
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
  mcpStatus: (sessionId: string): Promise<McpStatus> =>
    ipcRenderer.invoke(IPC.sessionMcpStatus, { sessionId }),
  reloadSkills: (sessionId: string) => ipcRenderer.invoke(IPC.sessionReloadSkills, { sessionId }),

  // permissions
  /**
   * Answer a parked prompt.
   *
   * The two decisions every caller makes stay positional; everything else is an
   * options bag typed off the wire contract itself, so a field added there
   * cannot be forgotten here. This used to be six positionals and PlanCard's own
   * comment said "if a seventh parameter ever lands here, that is the argument
   * for turning respondPermission into an options object" — `alwaysAllow` is
   * the seventh.
   */
  respondPermission: (
    requestId: string,
    behavior: 'allow' | 'deny',
    opts?: Omit<PermissionAnswer, 'requestId' | 'behavior'>,
  ) => ipcRenderer.invoke(IPC.permRespond, { requestId, behavior, ...opts }),

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

  // branches. Both annotated, for the reason reconnectMcp gives above: the
  // failure reason IS the feature here — git's refusal to overwrite local
  // changes is what the rail notice shows — so it must not arrive as `any` and
  // get quietly dropped.
  listBranches: (cwd: string): Promise<BranchList> =>
    ipcRenderer.invoke(IPC.gitBranches, { cwd }),
  checkoutBranch: (
    sessionId: string,
    cwd: string,
    name: string,
    remote: string | null,
  ): Promise<CheckoutResult> =>
    ipcRenderer.invoke(IPC.gitCheckout, { sessionId, cwd, name, remote }),

  // editor files
  readFile: (cwd: string, path: string) => ipcRenderer.invoke(IPC.fileRead, { cwd, path }),
  writeFile: (
    sessionId: string,
    cwd: string,
    path: string,
    text: string,
    bom: boolean,
    expectMtimeMs?: number,
  ) => ipcRenderer.invoke(IPC.fileWrite, { sessionId, cwd, path, text, bom, expectMtimeMs }),
  statFiles: (cwd: string, paths: string[]) => ipcRenderer.invoke(IPC.fileStat, { cwd, paths }),
  fileTree: (cwd: string) => ipcRenderer.invoke(IPC.fileTree, { cwd }),
  /** Complete an absolute or `~`-rooted path, one directory at a time. No cwd:
   *  this is the source for mentions that point outside the project. */
  browsePath: (query: string): Promise<string[]> =>
    ipcRenderer.invoke(IPC.fileBrowse, { query }),

  // lsp — raw JSON-RPC frames to and from the session's server fleet
  lspSend: (sessionId: string, msg: unknown) =>
    ipcRenderer.invoke(IPC.lspSend, { sessionId, msg }),
  lspRequest: (sessionId: string, method: string, params: unknown) =>
    ipcRenderer.invoke(IPC.lspRequest, { sessionId, method, params }),
  lspServers: (cwd: string) => ipcRenderer.invoke(IPC.lspServers, { cwd }),
  lspRecheck: (sessionId: string) => ipcRenderer.invoke(IPC.lspRecheck, { sessionId }),

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
  onLspMessage: (cb: (p: any) => void) => on(IPC.evtLspMessage, cb),
  onPtyData: (cb: (p: any) => void) => on(IPC.evtPtyData, cb),
  onPtyExit: (cb: (p: any) => void) => on(IPC.evtPtyExit, cb),
}

contextBridge.exposeInMainWorld('foreman', api)

export type ForemanApi = typeof api
