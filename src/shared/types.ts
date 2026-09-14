/**
 * 应用内共享的领域类型：主进程与渲染进程都引用这里的定义。
 * 命名参照 dlssg_for_sm86 的部署模型：一个"运行库包"提供若干代理 DLL，
 * 部署动作 = 把一个代理 DLL + 生成的 dlssg_sm86.ini 放进游戏的渲染 EXE 目录。
 */

/** 代理 DLL 文件名。上游提供 version/winmm/dbghelp/dinput8/dxgi/d3d12（旧版还有 winhttp）。 */
export type ProxyName = string

/** 优先推荐的代理名（工具类在最前，渲染路径在后）。 */
export const KNOWN_PROXIES: ProxyName[] = [
  'version.dll',
  'winmm.dll',
  'dbghelp.dll',
  'dinput8.dll',
  'dxgi.dll',
  'd3d12.dll',
  'winhttp.dll'
]

/** 风险较高的渲染路径代理，界面里要给出额外提示。 */
export const RISKY_PROXIES: ProxyName[] = ['dxgi.dll', 'd3d12.dll']

export interface ProxyFile {
  name: ProxyName
  /** 相对包根目录的路径，例如 alternatives\winmm.dll */
  relPath: string
  size: number
  sha256: string
}

export type PackageSource = 'github' | 'folder' | 'zip'

export interface RuntimePackage {
  id: string
  name: string
  /** 内嵌运行库版本，例如 310.9.1 / 310.1 */
  runtimeVersion: string
  /** 运行库允许的最大 MaxGeneratedFrames 上限，6 = 支持 6X，4 = 支持 4X */
  maxMultiplier: number
  source: PackageSource
  sourceDetail: string
  importedAt: string
  /** 包在应用数据目录中的落地路径 */
  rootPath: string
  proxies: ProxyFile[]
  /** 随包附带的出厂 ini，用来作为注释模板 */
  iniTemplatePath?: string
  notes?: string
}

export type LogLevel = 0 | 1 | 2 | 3

export interface ExtraIniKey {
  section: string
  key: string
  value: string
}

/** 界面暴露的 dlssg_sm86.ini 配置项。 */
export interface IniConfig {
  enabled: boolean
  optimized: boolean
  maxGeneratedFrames: number
  preset: 'Auto' | 'A' | 'B'
  logLevel: LogLevel
  logDirectory: string
  runtimeMode: string
  cacheDirectory: string
  extra: ExtraIniKey[]
}

export type GameSource = 'steam' | 'epic' | 'gog' | 'manual'

export interface DetectedExe {
  /** 渲染 EXE 目录 */
  dir: string
  exeName: string
  hasDlssg: boolean
  hasDlss: boolean
  /** 同目录里最大的 EXE，通常就是渲染进程 */
  recommended: boolean
}

export interface InjectedFileRecord {
  path: string
  action: 'created' | 'replaced'
  backupPath?: string
  sha256: string
  size: number
}

export interface InstallRecord {
  installedAt: string
  packageId: string
  packageName: string
  runtimeVersion: string
  proxyName: ProxyName
  backupDir: string
  files: InjectedFileRecord[]
  config: IniConfig
  appVersion: string
}

export interface HistoryEntry {
  at: string
  action: 'install' | 'restore' | 'repair'
  ok: boolean
  message: string
}

export type GameState =
  | 'not-installed'
  | 'installed'
  | 'installed-external'
  | 'outdated'
  | 'partial'
  | 'conflict'
  | 'dir-missing'

export interface DeployedFileState {
  path: string
  exists: boolean
  matches: boolean
  size?: number
}

export interface GameStatus {
  state: GameState
  proxyName?: ProxyName
  message: string
  running: boolean
  runningProcesses: string[]
  files: DeployedFileState[]
  /** 目录里发现的其它本项目代理，会与本次注入冲突 */
  otherProxies: string[]
  logSummary?: LogSummary
}

export interface LogSummary {
  files: number
  lastWrite?: string
  proxyRedirect: boolean
  routeActive: boolean
  errors: string[]
}

export interface GameEntry {
  id: string
  name: string
  source: GameSource
  installDir?: string
  appId?: string
  /** 部署目标目录（渲染 EXE 所在目录） */
  exeDir: string
  /** 判断游戏是否在运行用的 EXE 名 */
  exeName: string
  /** 启动游戏用的可执行文件（可选） */
  launchExe?: string
  candidates: DetectedExe[]
  dlssgCapable: boolean
  config: IniConfig
  install?: InstallRecord
  history: HistoryEntry[]
  notes?: string
  createdAt: string
  updatedAt: string
}

export interface ScannedGame {
  name: string
  source: GameSource
  installDir: string
  appId?: string
  exeDir?: string
  exeName?: string
  candidates: DetectedExe[]
  dlssgCapable: boolean
  /** 已经在列表里 */
  known: boolean
}

export interface AppSettings {
  /** 默认使用的运行库包 */
  defaultPackageId?: string
  defaultProxy: ProxyName
  /** 注入前是否必须二次确认 */
  confirmBeforeInstall: boolean
  /** 保留的备份份数，超出后删最旧的 */
  keepBackups: number
  /** GitHub 下载走国内镜像加速 */
  preferMirror: boolean
}

export interface GpuInfo {
  name: string
  driver: string
}

export interface EnvironmentInfo {
  appVersion: string
  electron: string
  node: string
  chrome: string
  platform: string
  arch: string
  dataDir: string
  gpus: GpuInfo[]
  driverMajor: number | null
  smKind: 'sm86' | 'sm75' | 'ada+' | 'unknown'
  warnings: string[]
  notes: string[]
}

export interface BackupEntry {
  dir: string
  gameId: string
  createdAt: string
  files: { name: string; size: number }[]
}

/** 主进程 → 渲染进程的进度事件 */
export interface ProgressEvent {
  scope: 'scan' | 'import' | 'download' | 'install'
  done: number
  total: number
  label: string
}

export interface InstallPlanAction {
  kind: 'copy-proxy' | 'write-ini' | 'backup' | 'delete' | 'restore' | 'keep'
  target: string
  detail: string
  level: 'info' | 'warn' | 'error'
}

export interface InstallPlan {
  gameId: string
  exeDir: string
  proxyName: ProxyName
  packageId: string
  packageName: string
  actions: InstallPlanAction[]
  blockers: string[]
  warnings: string[]
  runningProcesses: string[]
  alreadyInstalled: boolean
}

export interface InstallResult {
  ok: boolean
  message: string
  status?: GameStatus
}

export interface GameLogFile {
  name: string
  path: string
  size: number
  mtime: string
  kind: 'loader' | 'backend' | 'other'
}

export interface RemoteVariant {
  id: string
  name: string
  runtimeVersion: string
  maxMultiplier: number
  /** 仓库内目录前缀，'' 表示仓库根目录 */
  prefix: string
  repoPath: string
  proxies: { name: ProxyName; url: string; size: number }[]
  iniUrl?: string
  available?: boolean
  error?: string
}

export interface ImportResult {
  packages: RuntimePackage[]
  warnings: string[]
}

export interface VerifyResult {
  name: string
  ok: boolean
  expected: string
  actual: string
  size: number
}

export interface LogLine {
  raw: string
  level?: string
  message?: string
  time?: string
}

export interface LogReadResult {
  file: GameLogFile
  lines: LogLine[]
  truncated: boolean
}

