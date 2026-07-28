import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join, resolve } from 'node:path'
import { IPC } from '../shared/types'
import { setMainWindow } from './bridge'
import { adoptHosts, registerSessionIpc, disposeAllSessions } from './agent/manager'
import { registerPtyIpc, disposeAllPtys } from './pty'
import { registerFileIpc } from './files'
import { listUsage } from './agent/usage'

let mainWindow: BrowserWindow | null = null

/**
 * Set by `before-quit`, which Electron fires ahead of the window closes it
 * causes. Without it the close handler below would swallow ⌘Q's close too and
 * the app could never quit.
 */
let quitting = false

/**
 * Last value the renderer pushed for Appearance.trafficLights.
 *
 * Kept here so a window recreated from the dock is built with the user's
 * setting already applied. The renderer re-asserts it on boot anyway, but
 * without this the buttons flash back on for the length of that round trip.
 */
let trafficLights = true

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    // Opaque, deliberately. A transparent window makes WindowServer alpha-blend
    // the whole thing against the desktop every frame, and the CSS glass it
    // existed for was rendering nothing anyway — backdrop-filter has no in-page
    // backdrop to sample over a transparent window. `frame: false`,
    // titleBarStyle and trafficLightPosition stay: that chrome is not the glass.
    transparent: false,
    frame: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    // What Chromium paints before the renderer's first frame, so launch does not
    // flash. Dark is the default theme; the renderer pushes the resolved theme's
    // real --bg through app:background on boot and on every theme flip.
    backgroundColor: '#000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.setWindowButtonVisibility(trafficLights)
  setMainWindow(mainWindow)

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // ⌘W and the red traffic light hide the window instead of destroying it. A
  // parked permission prompt lives in main's `waiting` map while its card lives
  // only in the renderer, so tearing the renderer down orphans the request AND
  // wedges the session — setStatus holds the input queue gate shut while it is
  // 'awaiting-approval'. Mail and Music behave this way for the same reason.
  //
  // Off darwin there is no Dock to restore from and `window-all-closed` would
  // never fire, so hiding would make the app unreachable.
  mainWindow.on('close', (e) => {
    if (quitting || process.platform !== 'darwin') return
    e.preventDefault()
    mainWindow?.hide()
  })

  mainWindow.on('closed', () => {
    setMainWindow(null)
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) mainWindow.loadURL(devUrl)
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

/**
 * Project to open on launch: `foreman /path/to/repo`, or FOREMAN_OPEN.
 * Returns null when there's nothing to open, and the renderer shows the picker.
 */
function initialProject(): string | null {
  const fromEnv = process.env.FOREMAN_OPEN
  if (fromEnv) return resolve(fromEnv)

  // In dev, argv is [electron, ., ...]; in prod, [Foreman, ...].
  const args = process.argv.slice(app.isPackaged ? 1 : 2)
  const candidate = args.find((a) => !a.startsWith('-') && a !== '.')
  return candidate ? resolve(candidate) : null
}

// Dev-only: lets us drive the renderer over CDP for end-to-end checks.
if (!app.isPackaged) app.commandLine.appendSwitch('remote-debugging-port', '9222')

/**
 * Keep a dev run's state away from the installed app's, so you can use Foreman
 * while working on Foreman.
 *
 * Without this they share one directory. `app.getName()` is `foreman` from
 * package.json in dev and `Foreman` from productName when packaged — and APFS
 * is case-INsensitive by default, so those are the same path. Two Electron
 * processes on one userData means one Chromium profile: the second to start
 * can't take the LevelDB lock and its localStorage silently stops persisting,
 * and both would share `userData/worktrees`.
 *
 * setName rather than setPath, so the Dock, menu bar and About box say which
 * one you're looking at too. Must run before anything reads a path — the value
 * is resolved at first use, not on demand.
 */
if (!app.isPackaged) app.setName('Foreman Dev')

app.whenReady().then(async () => {
  // Published rather than imported: agent code runs in detached host processes
  // where `require('electron')` yields a path string, not the module. Hosts
  // inherit this through spawn. Must be set before anything reads a userData
  // path — see agent/usage.ts.
  process.env.FOREMAN_USER_DATA = app.getPath('userData')

  ipcMain.handle('app:initialProject', () => initialProject())
  // The colour Chromium paints before the renderer's first frame of a resize or
  // a reload. Pushed by applyAppearance so a theme flip does not leave the old
  // theme's fill showing through in those gaps.
  ipcMain.handle('app:background', (_e, { hex }: { hex: string }) => {
    mainWindow?.setBackgroundColor(hex)
    return true
  })
  ipcMain.handle('app:trafficLights', (_e, { on }: { on: boolean }) => {
    // macOS-only API. Elsewhere there are no window buttons to hide.
    if (process.platform !== 'darwin') return false
    // Remembered so a window recreated from the dock (see `activate`) comes back
    // with the user's setting rather than flashing the buttons on until the
    // renderer boots and applyAppearance re-asserts it.
    trafficLights = on
    mainWindow?.setWindowButtonVisibility(on)
    return true
  })
  ipcMain.handle(IPC.usageList, () => listUsage())
  registerSessionIpc()
  registerPtyIpc()
  registerFileIpc()

  // Re-attach to agents left running by a previous run — a clean quit, or a
  // crash. Awaited before the window loads so `session:list` already has them
  // and the renderer's bootstrap adopts them instead of opening a duplicate.
  // Any host whose process is gone gets its orphaned agent killed here.
  await adoptHosts().catch((err) => console.warn('[hosts] adopt failed:', err))

  ipcMain.handle(IPC.pickDirectory, async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Open as agent session',
    })
    return res.canceled ? null : res.filePaths[0]
  })

  createWindow()

  // The window now survives ⌘W, so `getAllWindows()` is never empty and the
  // old length check would leave the Dock icon doing nothing. Show, don't rebuild.
  app.on('activate', () => (mainWindow ? mainWindow.show() : createWindow()))
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // First, so the close handler above lets the real quit through.
  quitting = true
  // Detaches from the agent hosts WITHOUT stopping them — quitting the app no
  // longer throws away a turn in flight, and next launch adopts them back.
  // The PTYs do die: a terminal is UI state, not agent state.
  disposeAllSessions()
  disposeAllPtys()
})
