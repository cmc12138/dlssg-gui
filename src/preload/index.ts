import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type DshApi, type InstallRequestPayload } from '@shared/api'
import type { AppSettings, GameEntry, IniConfig, ProgressEvent } from '@shared/types'

const api: DshApi = {
  getEnvironment: () => ipcRenderer.invoke(IPC.env),
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  updateSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.settingsUpdate, patch),

  listPackages: () => ipcRenderer.invoke(IPC.packagesList),
  importPackageFromFolder: () => ipcRenderer.invoke(IPC.packagesImportFolder),
  importPackageFromZip: () => ipcRenderer.invoke(IPC.packagesImportZip),
  importPackageFromPath: (path: string, targetName?: string) => ipcRenderer.invoke(IPC.packagesImportPath, path, targetName),
  listRemoteVariants: () => ipcRenderer.invoke(IPC.packagesRemote),
  downloadVariant: (id: string) => ipcRenderer.invoke(IPC.packagesDownload, id),
  removePackage: (id: string) => ipcRenderer.invoke(IPC.packagesRemove, id),
  verifyPackage: (id: string) => ipcRenderer.invoke(IPC.packagesVerify, id),
  checkUpstream: (force?: boolean) => ipcRenderer.invoke(IPC.upstreamCheck, force),

  listGames: () => ipcRenderer.invoke(IPC.gamesList),
  scanGames: () => ipcRenderer.invoke(IPC.gamesScan),
  addGameFromFolder: (folder?: string) => ipcRenderer.invoke(IPC.gamesAdd, folder),
  detectFolder: (folder: string) => ipcRenderer.invoke(IPC.gamesDetect, folder),
  duplicateGames: () => ipcRenderer.invoke(IPC.gamesDuplicates),
  mergeDuplicates: () => ipcRenderer.invoke(IPC.gamesMergeDuplicates),
  updateGame: (id: string, patch: Partial<GameEntry>) => ipcRenderer.invoke(IPC.gamesUpdate, id, patch),
  removeGame: (id: string, deleteBackups?: boolean) => ipcRenderer.invoke(IPC.gamesRemove, id, deleteBackups),
  gameStatus: (id: string, withLogs?: boolean) => ipcRenderer.invoke(IPC.gamesStatus, id, withLogs),
  launchGame: (id: string) => ipcRenderer.invoke(IPC.gamesLaunch, id),
  listGameLogs: (id: string) => ipcRenderer.invoke(IPC.gamesLogs, id),
  readLog: (path: string) => ipcRenderer.invoke(IPC.gamesReadLog, path),

  planInstall: (request: InstallRequestPayload) => ipcRenderer.invoke(IPC.installPlan, request),
  applyInstall: (request: InstallRequestPayload) => ipcRenderer.invoke(IPC.installApply, request),
  updateGameIni: (id: string, config: IniConfig) => ipcRenderer.invoke(IPC.installUpdateIni, id, config),
  restoreGame: (id: string, options?: { force?: boolean; removeLogs?: boolean }) =>
    ipcRenderer.invoke(IPC.installRestore, id, options),
  listBackups: (id: string) => ipcRenderer.invoke(IPC.installBackups, id),

  pickFolder: (title?: string) => ipcRenderer.invoke(IPC.dialogFolder, title),
  pickFile: (filter) => ipcRenderer.invoke(IPC.dialogFile, filter),
  openPath: (path: string) => ipcRenderer.invoke(IPC.shellOpenPath, path),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.shellOpenExternal, url),

  onProgress: (callback: (event: ProgressEvent) => void) => {
    const listener = (_event: unknown, payload: ProgressEvent): void => callback(payload)
    ipcRenderer.on(IPC.progress, listener)
    return () => {
      ipcRenderer.off(IPC.progress, listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
