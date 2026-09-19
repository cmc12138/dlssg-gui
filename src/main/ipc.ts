import { spawn } from 'node:child_process'
import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions, type OpenDialogReturnValue } from 'electron'
import { basename, dirname, join } from 'node:path'
import { IPC, type DetectResponse, type InstallRequestPayload, type ScanResponse } from '@shared/api'
import type { AppSettings, GameEntry, IniConfig, ProgressEvent } from '@shared/types'
import { defaultIniConfig, normalizeIniConfig } from '@shared/ini-schema'
import { deleteGame, getGame, listGames, listPackages, saveGame, settingsStore } from './db'
import { applyInstall, getGameStatus, listBackups, planInstall, restoreGame, runningProcesses, updateIniOnly } from './inject'
import { deletePackage, downloadVariant, importFromFolder, importFromZip, importSingleDll, verifyPackage } from './library'
import { getSeed, invalidateRemoteCache, listRemoteVariants } from './remote-variants'
import { checkUpstream } from './upstream'
import { listGameLogs, readLogFile } from './logs'
import { detectGameFolder, gameKey, scanLibraries } from './scan'
import { listDuplicateGames, mergeDuplicateGames, sameGame } from './games'
import { fetchLatestRefRelease, getRefStatus, installReframework, uninstallReframework } from './reframework'
import { detectEnvironment } from './env'
import { backupsDir } from './paths'
import { removeIfExists } from './fsutil'

function createId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return `${slug || 'game'}-${Date.now().toString(36)}`
}

function serializeError(error: unknown): Error {
  if (error instanceof Error) return new Error(error.message)
  return new Error(String(error))
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const sendProgress = (event: ProgressEvent): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.progress, event)
  }
  const onProgress = (event: { scope: ProgressEvent['scope']; done: number; total: number; label: string }): void => {
    sendProgress(event)
  }
  const openDialog = (options: OpenDialogOptions): Promise<OpenDialogReturnValue> => {
    const window = getWindow()
    return window && !window.isDestroyed() ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options)
  }

  ipcMain.handle(IPC.env, async () => {
    const info = await detectEnvironment(process.versions.electron, process.versions.chrome)
    info.appVersion = app.getVersion()
    return info
  })

  ipcMain.handle(IPC.settingsGet, () => settingsStore.read())
  ipcMain.handle(IPC.settingsUpdate, async (_event, patch: Partial<AppSettings>) => {
    return settingsStore.update((settings) => {
      Object.assign(settings, patch)
    })
  })

  ipcMain.handle(IPC.packagesList, () => listPackages())
  ipcMain.handle(IPC.packagesImportFolder, async () => {
    const result = await openDialog({
      title: '选择解压后的 DLSSG 发布目录（含 version.dll）',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    try {
      return await importFromFolder(result.filePaths[0], onProgress)
    } catch (error) {
      throw serializeError(error)
    }
  })
  ipcMain.handle(IPC.packagesImportZip, async () => {
    const result = await openDialog({
      title: '选择 DLSSG 发布压缩包（GitHub Download ZIP 也可以）',
      properties: ['openFile'],
      filters: [{ name: '压缩包', extensions: ['zip'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    try {
      return await importFromZip(result.filePaths[0], onProgress)
    } catch (error) {
      throw serializeError(error)
    }
  })
  ipcMain.handle(IPC.packagesImportPath, async (_event, path: string, targetName?: string) => {
    try {
      const lower = path.toLowerCase()
      if (lower.endsWith('.zip')) return await importFromZip(path, onProgress)
      if (lower.endsWith('.dll')) return await importSingleDll(path, targetName ?? 'version.dll')
      return await importFromFolder(path, onProgress)
    } catch (error) {
      throw serializeError(error)
    }
  })
  ipcMain.handle(IPC.packagesRemote, () => listRemoteVariants())
  ipcMain.handle(IPC.packagesDownload, async (_event, id: string) => {
    const settings = await settingsStore.read()
    let seed = getSeed(id)
    if (!seed) {
      // 动态发现的种子要先跑一次「列出可下载项」才会注册进来
      await listRemoteVariants().catch(() => undefined)
      seed = getSeed(id)
    }
    if (!seed) throw new Error(`未知的下载项：${id}（上游结构可能变了，请刷新下载列表）`)
    try {
      return await downloadVariant(seed, {
        onProgress,
        preferMirror: settings.preferMirror,
        includeAlternatives: settings.downloadAllProxies
      })
    } catch (error) {
      invalidateRemoteCache()
      throw serializeError(error)
    }
  })
  ipcMain.handle(IPC.packagesRemove, async (_event, id: string) => {
    await deletePackage(id)
  })
  ipcMain.handle(IPC.packagesVerify, async (_event, id: string) => {
    try {
      return await verifyPackage(id, onProgress)
    } catch (error) {
      throw serializeError(error)
    }
  })
  ipcMain.handle(IPC.upstreamCheck, async (_event, force?: boolean) => {
    try {
      return await checkUpstream({ force: force ?? false })
    } catch (error) {
      throw serializeError(error)
    }
  })

  ipcMain.handle(IPC.gamesList, () => listGames())
  ipcMain.handle(IPC.gamesScan, async (): Promise<ScanResponse> => {
    const existing = await listGames()
    const knownKeys = new Set(existing.map((game) => gameKey(game.name, game.installDir ?? game.exeDir)))
    try {
      const result = await scanLibraries({
        knownKeys,
        onProgress: (progress) => sendProgress({ scope: 'scan', ...progress })
      })
      return result
    } catch (error) {
      throw serializeError(error)
    }
  })
  ipcMain.handle(IPC.gamesAdd, async (_event, folder?: string) => {
    let target = folder
    if (!target) {
      const result = await openDialog({
        title: '选择游戏目录（可以是游戏根目录，我来找渲染 EXE）',
        properties: ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      target = result.filePaths[0]
    }
    const detection = await detectGameFolder(target)
    const name = basename(target) || target
    const now = new Date().toISOString()

    // 先查重：同一个游戏只允许有一条记录，否则会各带一份配置、状态互相干扰
    const existing = await listGames()
    const probe: GameEntry = {
      id: 'probe',
      name,
      source: 'manual',
      installDir: target,
      exeDir: detection.exeDir,
      exeName: detection.exeName,
      candidates: detection.candidates,
      dlssgCapable: detection.dlssgCapable,
      config: defaultIniConfig(),
      history: [],
      createdAt: now,
      updatedAt: now
    }
    const duplicate = existing.find((game) => sameGame(game, probe, true))
    if (duplicate) {
      return { game: duplicate, created: false }
    }

    const game: GameEntry = { ...probe, id: createId(name) }
    await saveGame(game)
    return { game, created: true }
  })
  ipcMain.handle(IPC.gamesDuplicates, () => listDuplicateGames())
  ipcMain.handle(IPC.gamesMergeDuplicates, async () => {
    try {
      return await mergeDuplicateGames()
    } catch (error) {
      throw serializeError(error)
    }
  })
  ipcMain.handle(IPC.gamesDetect, async (_event, folder: string): Promise<DetectResponse> => {
    const detection = await detectGameFolder(folder)
    return detection
  })
  ipcMain.handle(IPC.gamesUpdate, async (_event, id: string, patch: Partial<GameEntry>) => {
    const game = await getGame(id)
    if (!game) throw new Error('没有找到该游戏条目')
    const next: GameEntry = { ...game, ...patch, id: game.id }
    if (patch.config) next.config = normalizeIniConfig(patch.config, 6)
    await saveGame(next)
    return next
  })
  ipcMain.handle(IPC.gamesRemove, async (_event, id: string, deleteBackupFiles?: boolean) => {
    const game = await getGame(id)
    if (game?.install) {
      const running = await runningProcesses([game.exeName])
      if (running.length > 0) throw new Error(`游戏正在运行（${running.join('、')}），请先退出并还原后再删除`)
    }
    await deleteGame(id)
    if (deleteBackupFiles) await removeIfExists(join(backupsDir(), id))
  })
  ipcMain.handle(IPC.gamesStatus, async (_event, id: string, withLogs?: boolean) => {
    const game = await getGame(id)
    if (!game) throw new Error('没有找到该游戏条目')
    return getGameStatus(game, { withLogs: withLogs ?? true })
  })
  ipcMain.handle(IPC.refStatus, async (_event, id: string) => {
    try {
      return await getRefStatus(id)
    } catch (error) {
      throw serializeError(error)
    }
  })
  ipcMain.handle(IPC.refLatest, async (_event, id: string) => {
    try {
      const game = await getGame(id)
      return await fetchLatestRefRelease(game)
    } catch {
      return null
    }
  })
  ipcMain.handle(IPC.refInstall, async (_event, id: string, zipPath?: string) => {
    try {
      return await installReframework(id, { zipPath, onProgress })
    } catch (error) {
      return { ok: false, message: `安装 REFramework 失败：${(error as Error).message}` }
    }
  })
  ipcMain.handle(IPC.refRemove, async (_event, id: string) => {
    try {
      return await uninstallReframework(id)
    } catch (error) {
      return { ok: false, message: `卸载 REFramework 失败：${(error as Error).message}` }
    }
  })
  ipcMain.handle(IPC.gamesLaunch, async (_event, id: string) => {
    const game = await getGame(id)
    if (!game) throw new Error('没有找到该游戏条目')
    const exePath = game.launchExe ?? (game.exeName ? join(game.exeDir, game.exeName) : '')
    if (!exePath) throw new Error('没有可执行文件记录')
    const child = spawn(exePath, [], { cwd: dirname(exePath), detached: true, stdio: 'ignore' })
    child.unref()
    game.history.unshift({ at: new Date().toISOString(), action: 'install', ok: true, message: `启动 ${basename(exePath)}` })
    game.history = game.history.slice(0, 50)
    await saveGame(game)
  })
  ipcMain.handle(IPC.gamesLogs, async (_event, id: string) => {
    const game = await getGame(id)
    if (!game) throw new Error('没有找到该游戏条目')
    const logDir = game.install?.config.logDirectory ?? game.config.logDirectory ?? 'dlssg_sm86\\logs'
    return listGameLogs(game.exeDir, logDir)
  })
  ipcMain.handle(IPC.gamesReadLog, async (_event, path: string) => {
    try {
      return await readLogFile(path)
    } catch (error) {
      throw serializeError(error)
    }
  })

  ipcMain.handle(IPC.installPlan, async (_event, request: InstallRequestPayload) => {
    try {
      return await planInstall(request)
    } catch (error) {
      throw serializeError(error)
    }
  })
  ipcMain.handle(IPC.installApply, async (_event, request: InstallRequestPayload) => {
    try {
      return await applyInstall({ ...request, onProgress })
    } catch (error) {
      return { ok: false, message: `写入失败：${(error as Error).message}` }
    }
  })
  ipcMain.handle(IPC.installUpdateIni, async (_event, id: string, config: IniConfig) => {
    try {
      return await updateIniOnly(id, config)
    } catch (error) {
      return { ok: false, message: `写入失败：${(error as Error).message}` }
    }
  })
  ipcMain.handle(IPC.installRestore, async (_event, id: string, options?: { force?: boolean; removeLogs?: boolean }) => {
    try {
      return await restoreGame(id, options)
    } catch (error) {
      return { ok: false, message: `还原失败：${(error as Error).message}` }
    }
  })
  ipcMain.handle(IPC.installBackups, (_event, id: string) => listBackups(id))

  ipcMain.handle(IPC.dialogFolder, async (_event, title?: string) => {
    const result = await openDialog({
      title: title ?? '选择目录',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
  ipcMain.handle(IPC.dialogFile, async (_event, filter?: { name: string; extensions: string[] }) => {
    const result = await openDialog({
      title: '选择文件',
      properties: ['openFile'],
      filters: filter ? [filter] : undefined
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
  ipcMain.handle(IPC.shellOpenPath, async (_event, path: string) => {
    if (!path) return
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  })
  ipcMain.handle(IPC.shellOpenExternal, async (_event, url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('只允许打开 http/https 链接')
    await shell.openExternal(url)
  })
}
