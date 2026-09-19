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
  /** 来自 GitHub 时记录仓库坐标，供「检查上游更新」比对 */
  remoteRepo?: string
  /** 仓库内目录前缀，'' = 仓库根目录 */
  remotePath?: string
  /** 导入时仓库内各文件的 git blob sha（路径 → sha），与远端树比对即可判断有没有更新 */
  remoteBlobs?: Record<string, string>
  /** 上游项目版本（如 0.3.4） */
  projectVersion?: string
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
  /** 一致性档位 0–3（上游 0.3.2 起；0 原厂，1 逐位一致，2/3 有损更快） */
  optimized: number
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
  /** 游戏整体（整棵目录树）是否带 DLSS-G：nvngx_dlssg.dll 或 sl.dlss_g.dll */
  hasDlssg: boolean
  /** 游戏整体是否带 DLSS 超分：nvngx_dlss.dll 或 sl.dlss.dll */
  hasDlss: boolean
  /** 这个目录里有没有 AMD FSR3 帧生成（放在渲染 EXE 旁边，是"这里就是渲染目录"的强信号） */
  hasFsrFrameGen: boolean
  /** 排序第一的候选，通常是渲染 EXE 目录 */
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

/** 我们装进游戏目录的 REFramework（卡普空 RE Engine 游戏需要它才加载得了代理 DLL） */
export interface ReframeworkRecord {
  installedAt: string
  /** 上游 tag，例如 nightly-01424-d1461375… */
  tag: string
  assetName: string
  source: string
  /** 安装目标目录（游戏根目录） */
  targetDir: string
  backupDir: string
  files: { path: string; action: 'created' | 'replaced'; backupPath?: string; size: number }[]
}

export interface RefStatus {
  /** 是不是卡普空 RE Engine 游戏（发现 re_chunk_*.pak / re_dlc_*.pak） */
  reEngine: boolean
  engineEvidence?: string
  /** 目录里已经存在 REFramework 的痕迹（dinput8.dll / reframework 文件夹） */
  hasRefFiles: boolean
  installed: boolean
  record?: ReframeworkRecord
  /** 会把文件装到这里 */
  targetDir: string
  targetExists: boolean
  error?: string
}

export interface RefReleaseInfo {
  tag: string
  assetName: string
  size: number
  publishedAt: string
  repo: string
  url: string
  /** GitHub 资产 id，走 api.github.com 的 assets 接口下载（github.com 不通时这条更可靠） */
  assetId?: number
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
  /** 装进游戏目录的 REFramework（卡普空 RE Engine 游戏用） */
  reframework?: ReframeworkRecord
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

/** 添加游戏的结果：created=false 表示同一个游戏已经在列表里（不会重复添加） */
export interface AddGameResult {
  game: GameEntry
  created: boolean
}

/** 重复条目分组（同一个游戏被加了多条） */
export interface DuplicateReport {
  groups: GameEntry[][]
  entries: number
}

export interface MergeResult {
  mergedGroups: number
  removedEntries: number
  details: string[]
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
  /**
   * 下载运行库时是否连 alternatives 里的其它代理名一起下。
   * 默认 false：只下 version.dll（约 30MB）；全部代理约 180MB，慢线路上很痛。
   */
  downloadAllProxies: boolean
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
  /** 已完成的项目数（下载时 = 已下完的文件数） */
  done: number
  /** 总项目数（下载时 = 文件个数） */
  total: number
  label: string
  /** 当前这个文件的字节进度 */
  received?: number
  totalBytes?: number
  /** 总体进度 0–1；下载多文件时会把当前文件已下的比例也算进去 */
  overall?: number
  /** 当前这一步是否已经结束（用于界面判停） */
  finished?: boolean
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

/** 上游仓库里发现的一个发布包（一个含 version.dll 的目录） */
export interface UpstreamPackage {
  /** 仓库内目录前缀，'' = 仓库根目录 */
  path: string
  label: string
  runtimeVersion: string
  maxMultiplier: number
  /** 主 DLL（version.dll）的 git blob sha，用来跟本地导入的包比对 */
  versionBlobSha: string
  versionSize: number
  proxies: { name: string; path: string; size: number; blobSha: string }[]
  iniPath?: string
  iniSize?: number
  /** 出厂 ini 的 git blob sha */
  iniBlobSha?: string
  notes?: string
  /** 本地已经导入过这个路径的运行库 */
  localPackageId?: string
  localPackageName?: string
  /** 与本地导入的包相比，远端内容变了 */
  updateAvailable: boolean
}

export interface UpstreamRelease {
  tag: string
  name: string
  publishedAt: string
  assetCount: number
}

export interface UpstreamStatus {
  repo: string
  repoUrl: string
  branch: string
  checkedAt: string
  /** 最新提交 */
  latestCommit: { sha: string; date: string; message: string }
  /** 最新发行版 tag（上游用它标项目版本，比如 0.3.4） */
  projectVersion?: string
  releases: UpstreamRelease[]
  packages: UpstreamPackage[]
  /** 本地已导入运行库的上游受管情况 */
  managedPackages: number
  error?: string
}


