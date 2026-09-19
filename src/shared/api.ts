import type {
  AppSettings,
  BackupEntry,
  EnvironmentInfo,
  GameEntry,
  GameLogFile,
  GameStatus,
  ImportResult,
  IniConfig,
  InstallPlan,
  InstallResult,
  LogReadResult,
  ProgressEvent,
  RemoteVariant,
  RuntimePackage,
  ScannedGame,
  UpstreamStatus,
  VerifyResult,
  AddGameResult,
  DuplicateReport,
  MergeResult,
  RefReleaseInfo,
  RefStatus,
  CleanupReport,
  CleanupRunResult,
  DetectedExe
} from './types'

/** REFramework 安装/卸载的结果 */
export interface RefInstallOutcome {
  ok: boolean
  message: string
  record?: import('./types').ReframeworkRecord
}

export interface InstallRequestPayload {
  gameId: string
  packageId: string
  proxyName: string
  config: IniConfig
  exeDir?: string
  exeName?: string
  launchExe?: string
  force?: boolean
}

export interface ScanResponse {
  games: ScannedGame[]
  warnings: string[]
}

export interface DetectResponse {
  candidates: DetectedExe[]
  dlssgCapable: boolean
  exeDir: string
  exeName: string
}

export interface FileFilter {
  name: string
  extensions: string[]
}

/** 渲染进程可用的全部能力（由 preload 通过 contextBridge 暴露为 window.api）。 */
export interface DshApi {
  getEnvironment(): Promise<EnvironmentInfo>
  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>

  listPackages(): Promise<RuntimePackage[]>
  importPackageFromFolder(): Promise<ImportResult | null>
  importPackageFromZip(): Promise<ImportResult | null>
  importPackageFromPath(path: string, targetName?: string): Promise<ImportResult>
  listRemoteVariants(): Promise<RemoteVariant[]>
  downloadVariant(id: string): Promise<RuntimePackage>
  removePackage(id: string): Promise<void>
  verifyPackage(id: string): Promise<VerifyResult[]>
  checkUpstream(force?: boolean): Promise<UpstreamStatus>
  scanCleanup(): Promise<CleanupReport>
  runCleanup(paths: string[]): Promise<CleanupRunResult>

  listGames(): Promise<GameEntry[]>
  scanGames(): Promise<ScanResponse>
  addGameFromFolder(folder?: string): Promise<AddGameResult | null>
  detectFolder(folder: string): Promise<DetectResponse>
  duplicateGames(): Promise<DuplicateReport>
  mergeDuplicates(): Promise<MergeResult>
  updateGame(id: string, patch: Partial<GameEntry>): Promise<GameEntry>
  removeGame(id: string, deleteBackups?: boolean): Promise<void>
  gameStatus(id: string, withLogs?: boolean): Promise<GameStatus>
  refStatus(id: string): Promise<RefStatus>
  refLatest(id: string): Promise<RefReleaseInfo | null>
  refInstall(id: string, zipPath?: string): Promise<RefInstallOutcome>
  refRemove(id: string): Promise<RefInstallOutcome>
  launchGame(id: string): Promise<void>
  listGameLogs(id: string): Promise<GameLogFile[]>
  readLog(path: string): Promise<LogReadResult>

  planInstall(request: InstallRequestPayload): Promise<InstallPlan>
  applyInstall(request: InstallRequestPayload): Promise<InstallResult>
  updateGameIni(id: string, config: IniConfig): Promise<InstallResult>
  restoreGame(id: string, options?: { force?: boolean; removeLogs?: boolean }): Promise<InstallResult>
  listBackups(id: string): Promise<BackupEntry[]>

  pickFolder(title?: string): Promise<string | null>
  pickFile(filter?: FileFilter): Promise<string | null>
  openPath(path: string): Promise<void>
  openExternal(url: string): Promise<void>

  onProgress(callback: (event: ProgressEvent) => void): () => void
}

export const IPC = {
  env: 'app:env',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  packagesList: 'packages:list',
  packagesImportFolder: 'packages:import-folder',
  packagesImportZip: 'packages:import-zip',
  packagesImportPath: 'packages:import-path',
  packagesRemote: 'packages:remote',
  packagesDownload: 'packages:download',
  packagesRemove: 'packages:remove',
  packagesVerify: 'packages:verify',
  upstreamCheck: 'upstream:check',
  cleanupScan: 'cleanup:scan',
  cleanupRun: 'cleanup:run',
  gamesList: 'games:list',
  gamesScan: 'games:scan',
  gamesAdd: 'games:add',
  gamesDetect: 'games:detect',
  gamesDuplicates: 'games:duplicates',
  gamesMergeDuplicates: 'games:merge-duplicates',
  gamesUpdate: 'games:update',
  gamesRemove: 'games:remove',
  gamesStatus: 'games:status',
  refStatus: 'ref:status',
  refLatest: 'ref:latest',
  refInstall: 'ref:install',
  refRemove: 'ref:remove',
  gamesLaunch: 'games:launch',
  gamesLogs: 'games:logs',
  gamesReadLog: 'games:read-log',
  installPlan: 'install:plan',
  installApply: 'install:apply',
  installUpdateIni: 'install:update-ini',
  installRestore: 'install:restore',
  installBackups: 'install:backups',
  dialogFolder: 'dialog:folder',
  dialogFile: 'dialog:file',
  shellOpenPath: 'shell:open-path',
  shellOpenExternal: 'shell:open-external',
  progress: 'app:progress'
} as const
