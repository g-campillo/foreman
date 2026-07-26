import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join, resolve } from 'node:path'
import { IPC } from '../shared/types'
import { setMainWindow } from './bridge'
import { registerSessionIpc, disposeAllSessions } from './agent/manager'
import { registerPtyIpc, disposeAllPtys } from './pty'
import { registerDiffIpc } from './agent/snapshots'
import { registerPermissionIpc } from './agent/permissions'
import { registerElicitationIpc } from './agent/elicitation'

let mainWindow: BrowserWindow | null = null

/** Handle to the native glass view, so the Appearance popover can restyle it. */
let glass: { mod: { unstable_setVariant(id: number, v: number): void }; id: number } | null = null

export function setGlassVariant(variant: number): boolean {
  if (!glass) return false
  try {
    glass.mod.unstable_setVariant(glass.id, variant)
    return true
  } catch {
    return false
  }
}

function applyLiquidGlass(win: BrowserWindow): void {
  if (process.platform !== 'darwin') return
  try {
    // Lazy require: the module is a native addon and no-ops off macOS, but a
    // top-level import would still cost us a load on every platform.
    const liquidGlass = require('electron-liquid-glass').default ?? require('electron-liquid-glass')
    const id = liquidGlass.addView(win.getNativeWindowHandle(), { cornerRadius: 12 })
    glass = { mod: liquidGlass, id }
    // Private API — guarded because Apple can move it out from under us.
    try {
      liquidGlass.unstable_setVariant(id, 2)
    } catch {
      /* variant is cosmetic; the base glass is already applied */
    }
  } catch (err) {
    // macOS < 26 or the addon failed to load. The renderer's backdrop-filter
    // layer is the fallback, so the app still looks intentional.
    console.warn('[glass] native Liquid Glass unavailable, using CSS fallback:', err)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    transparent: true, // mandatory for Liquid Glass
    // `vibrancy` is deliberately unset here and applied from the renderer's
    // saved Appearance instead — it overrides the Liquid Glass material, and
    // that trade-off is the user's to make (it's also the only real blur).
    frame: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.setWindowButtonVisibility(true)
  setMainWindow(mainWindow)

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    setMainWindow(null)
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Glass must be attached after content exists or it renders behind nothing.
  mainWindow.webContents.once('did-finish-load', () => {
    if (mainWindow) applyLiquidGlass(mainWindow)
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

app.whenReady().then(() => {
  ipcMain.handle('app:initialProject', () => initialProject())
  ipcMain.handle('app:vibrancy', (_e, { v }: { v: string | null }) => {
    mainWindow?.setVibrancy(v as Parameters<BrowserWindow['setVibrancy']>[0])
    return true
  })
  registerSessionIpc()
  registerPermissionIpc()
  registerElicitationIpc()
  registerDiffIpc()
  registerPtyIpc()

  ipcMain.handle(IPC.pickDirectory, async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Open as agent session',
    })
    return res.canceled ? null : res.filePaths[0]
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  disposeAllSessions()
  disposeAllPtys()
})
