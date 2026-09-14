import { existsSync, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { ensureDataDirs, setDataDir } from './paths'
import { registerIpc } from './ipc'
import { reconcilePackages } from './library'
import { setAppVersion } from './inject'

let mainWindow: BrowserWindow | null = null

/**
 * 数据目录优先级：
 * 1. 环境变量 DLSSG_GUI_DATA_DIR
 * 2. 便携模式：exe 旁边有 portable.txt（便携版 exe 用 electron-builder 的 PORTABLE_EXECUTABLE_DIR 定位）
 * 3. Electron userData（%APPDATA%\dlssg-gui）
 */
function resolveDataDir(): string {
  const override = process.env.DLSSG_GUI_DATA_DIR
  if (override) return override
  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR ?? dirname(app.getPath('exe'))
  if (existsSync(join(exeDir, 'portable.txt'))) return join(exeDir, 'data')
  return app.getPath('userData')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0d1014',
    title: 'DLSSG 帧生成管理器',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // 自检开关：DLSSG_GUI_SCREENSHOT=<png 路径> 时，加载完成后截图并退出（用于验证界面能正常渲染）
  const screenshotPath = process.env.DLSSG_GUI_SCREENSHOT
  if (screenshotPath) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        const window = mainWindow
        if (!window) return
        void window.webContents
          .capturePage()
          .then((image) => writeFile(screenshotPath, image.toPNG()))
          .catch(() => undefined)
          .finally(() => app.quit())
      }, 3000)
    })
  }
}

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    setDataDir(resolveDataDir())
    mkdirSync(resolveDataDir(), { recursive: true })
    ensureDataDirs()
    setAppVersion(app.getVersion())
    await reconcilePackages().catch(() => undefined)
    registerIpc(() => mainWindow)
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
