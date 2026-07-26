/**
 * The IPC contract. Shared by main, preload, and renderer.
 *
 * Main normalises raw Agent SDK messages into ChatItems before they cross the
 * bridge, so the renderer never imports the SDK and never has to track its churn.
 */

export type SessionStatus = 'starting' | 'idle' | 'running' | 'awaiting-approval' | 'error'

/** Mirrors the SDK's own union, minus 'auto' (no UI for the classifier yet).
 *  'dontAsk' denies anything not pre-approved instead of prompting. */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk'

export interface SessionMeta {
  id: string
  title: string
  cwd: string
  status: SessionStatus
  model: string | null
  costUsd: number
  inputTokens: number
  outputTokens: number
  permissionMode: PermissionMode
  createdAt: number
}

export type ChatItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'thinking'; text: string }
  | {
      id: string
      kind: 'tool'
      name: string
      input: unknown
      status: 'pending' | 'done' | 'error'
      result?: string
    }
  | { id: string; kind: 'result'; text: string; costUsd: number; durationMs: number; isError: boolean }
  | { id: string; kind: 'error'; text: string }

export interface PermissionRequest {
  requestId: string
  sessionId: string
  toolName: string
  input: Record<string, unknown>
  /** Present when the SDK offers "always allow"-style rule suggestions. */
  hasSuggestions: boolean
}

export interface FileDiff {
  path: string
  /** Path relative to the session cwd, for display. */
  relPath: string
  /** null when the agent created the file. */
  before: string | null
  after: string | null
  added: number
  removed: number
  hunks: DiffHunk[]
}

export interface DiffHunk {
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

export interface DiffLine {
  type: 'add' | 'del' | 'ctx'
  text: string
  oldNo: number | null
  newNo: number | null
}

export interface ModelInfo {
  /** The alias to pass to setModel — may be '' for "Default (recommended)". */
  id: string
  displayName: string
  /** Canonical wire id the alias resolves to, e.g. 'sonnet' -> 'claude-sonnet-5'.
   *  This is what matches against SessionMeta.model. */
  resolvedModel?: string
}

export interface PastSession {
  sessionId: string
  summary: string
  cwd?: string
  updatedAt?: string
}

/** Appearance knobs the renderer persists and applies as CSS custom properties. */
export interface Appearance {
  surfaceAlpha: number
  terminalAlpha: number
  /** 'auto' follows the OS live via matchMedia; the other two pin it. */
  theme: 'auto' | 'dark' | 'light'
  /**
   * macOS vibrancy material, or null for none.
   *
   * This is the only thing that actually blurs the desktop behind the window.
   * CSS backdrop-filter can't: the window is transparent, so Chromium has no
   * in-page backdrop to sample. NSGlassEffectView (electron-liquid-glass) gives
   * translucency and the Tahoe material but leaves the desktop sharp.
   *
   * Trade-off: vibrancy overrides the Liquid Glass material. Blur on means
   * vibrancy's look; blur off means pure Liquid Glass.
   */
  vibrancy: string | null
}

export const IPC = {
  // session lifecycle
  sessionCreate: 'session:create',
  sessionResume: 'session:resume',
  sessionClose: 'session:close',
  sessionList: 'session:list',
  sessionSend: 'session:send',
  sessionInterrupt: 'session:interrupt',
  sessionSetMode: 'session:setMode',
  sessionSetModel: 'session:setModel',
  sessionModels: 'session:models',
  sessionPastList: 'session:pastList',

  // session → renderer events
  evtItem: 'session:item',
  evtDelta: 'session:delta',
  evtMeta: 'session:meta',
  evtRemoved: 'session:removed',

  // permissions
  permRequest: 'permission:request',
  permResolved: 'permission:resolved',
  permRespond: 'permission:respond',

  // diffs
  diffList: 'diff:list',
  diffRevert: 'diff:revert',
  diffClear: 'diff:clear',
  evtDiffChanged: 'diff:changed',

  // terminal
  ptyStart: 'pty:start',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  evtPtyData: 'pty:data',
  evtPtyExit: 'pty:exit',

  // misc
  pickDirectory: 'app:pickDirectory',
} as const
