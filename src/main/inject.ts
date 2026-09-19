import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { basename, join, normalize, parse, sep } from 'node:path'
import type {
  BackupEntry,
  GameEntry,
  GameState,
  GameStatus,
  IniConfig,
  InstallPlan,
  InstallPlanAction,
  InstallRecord,
  InstallResult,
  InjectedFileRecord,
  RuntimePackage
} from '@shared/types'
import { KNOWN_PROXIES, RISKY_PROXIES } from '@shared/types'
import { defaultIniConfig, iniConfigToMap, normalizeIniConfig, optimizedTierLabel, parseIniConfig, serializeIniConfig } from '@shared/ini-schema'
import { getGame, getPackage, listPackages, saveGame, settingsStore } from './db'
import { backupsDir } from './paths'
import { atomicCopyFile, atomicWriteFile, ensureDir, humanSize, pathExists, removeIfExists, sha256File } from './fsutil'
import { readGameIni, summarizeLogs } from './logs'

let appVersion = '0.1.0'
export function setAppVersion(version: string): void {
  appVersion = version
}

export interface InstallRequest {
  gameId: string
  packageId: string
  proxyName: string
  config: IniConfig
  exeDir?: string
  exeName?: string
  launchExe?: string
  force?: boolean
  onProgress?: (event: { scope: 'install'; done: number; total: number; label: string }) => void
}

/** tasklist 里出现同名进程即认为游戏在运行。查不到进程列表时返回空数组，写入由文件锁兜底。 */
export async function runningProcesses(names: string[]): Promise<string[]> {
  const wanted = new Set(names.filter(Boolean).map((n) => n.toLowerCase()))
  if (wanted.size === 0) return []
  const stdout = await new Promise<string>((resolvePromise) => {
    try {
      const child = spawn('tasklist.exe', ['/NH', '/FO', 'CSV'], { windowsHide: true })
      let out = ''
      child.stdout?.on('data', (chunk) => {
        out += String(chunk)
      })
      child.on('error', () => resolvePromise(''))
      child.on('close', () => resolvePromise(out))
    } catch {
      resolvePromise('')
    }
  })
  const hits = new Set<string>()
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^"([^"]+)"/.exec(line.trim())
    if (!match) continue
    const name = match[1].toLowerCase()
    if (wanted.has(name)) hits.add(match[1])
  }
  return [...hits]
}

export async function findKnownProxiesInDir(dir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const known = new Map(KNOWN_PROXIES.map((p) => [p.toLowerCase(), p]))
  return names.filter((name) => known.has(name.toLowerCase())).map((name) => known.get(name.toLowerCase())!)
}

function targetFileFor(dir: string, proxyName: string): string {
  return join(dir, proxyName)
}

export async function resolveProxySource(pkg: RuntimePackage, proxyName: string): Promise<{ absPath: string; relPath: string; sha256: string } | undefined> {
  const proxy = pkg.proxies.find((p) => p.name.toLowerCase() === proxyName.toLowerCase())
  if (!proxy) return undefined
  const absPath = join(pkg.rootPath, proxy.relPath.split('/').join(sep))
  return { absPath, relPath: proxy.relPath, sha256: proxy.sha256 }
}

export function validateTargetDir(dir: string): string | null {
  const normalized = normalize(dir)
  const root = parse(normalized).root
  if (normalized.toLowerCase() === root.toLowerCase()) return '不能把运行库放进磁盘根目录'
  if (/^[a-z]:\\windows(\\)?/i.test(normalized)) return '不能写入 Windows 系统目录'
  if (/^[a-z]:\\program files(\\)?$/i.test(normalized)) return '不能写入 Program Files 根目录'
  return null
}

function configsEqual(a: IniConfig | undefined, b: IniConfig | undefined): boolean {
  if (!a || !b) return false
  const mapA = iniConfigToMap(normalizeIniConfig(a), 6)
  const mapB = iniConfigToMap(normalizeIniConfig(b), 6)
  if (mapA.size !== mapB.size) return false
  for (const [section, kv] of mapA) {
    const other = mapB.get(section)
    if (!other || other.size !== kv.size) return false
    for (const [key, value] of kv) {
      if (other.get(key) !== value) return false
    }
  }
  return true
}

export async function getGameStatus(game: GameEntry, options: { withLogs?: boolean } = {}): Promise<GameStatus> {
  const running = await runningProcesses([game.exeName, game.launchExe ? basename(game.launchExe) : ''])
  const base: GameStatus = {
    state: 'not-installed',
    message: '',
    running: running.length > 0,
    runningProcesses: running,
    files: [],
    otherProxies: []
  }
  if (!(await pathExists(game.exeDir))) {
    return { ...base, state: 'dir-missing', message: '目标目录不存在，游戏可能已被移动或卸载' }
  }

  const present = await findKnownProxiesInDir(game.exeDir)
  const installed = game.install

  if (installed) {
    const files = []
    for (const file of installed.files) {
      const exists = await pathExists(file.path)
      const actual = exists ? await sha256File(file.path) : ''
      files.push({ path: file.path, exists, matches: exists && actual === file.sha256, size: exists ? (await stat(file.path)).size : undefined })
    }
    const allOk = files.every((f) => f.exists && f.matches)
    const iniText = await readGameIni(game.exeDir)
    const onDisk = iniText ? parseIniConfig(iniText) : undefined
    const configDrift = onDisk ? !configsEqual(onDisk, installed.config) : true
    let state: GameState = 'installed'
    let message = `已注入 ${installed.proxyName}（${installed.packageName}）`
    if (!allOk) {
      state = 'partial'
      message = '注入的文件被改动或缺失，建议重新注入或还原'
    } else if (configDrift) {
      state = 'outdated'
      message = '磁盘上的 ini 与记录不一致（手动改过或未同步），可以点「同步配置」写回'
    }
    const status: GameStatus = {
      ...base,
      state,
      message,
      proxyName: installed.proxyName,
      files,
      otherProxies: present.filter((p) => p.toLowerCase() !== installed.proxyName.toLowerCase())
    }
    if (status.otherProxies.length > 0) {
      status.state = 'conflict'
      status.message = `同目录还有其它代理（${status.otherProxies.join('、')}），同时启用多个代理会互相干扰`
    }
    if (options.withLogs) {
      status.logSummary = await summarizeLogs(game.exeDir, installed.config.logDirectory || defaultIniConfig().logDirectory)
    }
    return status
  }

  if (present.length > 0) {
    const packages = await listPackages()
    let matched: { pkg: RuntimePackage; name: string } | undefined
    for (const name of present) {
      const hash = await sha256File(join(game.exeDir, name)).catch(() => '')
      for (const pkg of packages) {
        const proxy = pkg.proxies.find((p) => p.name.toLowerCase() === name.toLowerCase() && p.sha256 === hash)
        if (proxy) {
          matched = { pkg, name }
          break
        }
      }
      if (matched) break
    }
    const status: GameStatus = {
      ...base,
      proxyName: matched?.name ?? present[0],
      files: present.map((name) => ({ path: join(game.exeDir, name), exists: true, matches: true })),
      otherProxies: present.slice(1)
    }
    if (matched) {
      status.state = 'installed-external'
      status.message = `目录里已有本项目代理 ${matched.name}（属于运行库「${matched.pkg.name}」），但不由本工具管理`
    } else if (present.length > 1) {
      status.state = 'conflict'
      status.message = `目录里有多个代理 DLL（${present.join('、')}），只能启用一个`
    } else {
      status.state = 'conflict'
      status.message = `目录里已存在 ${present[0]}，不是本工具注入的，可能被其它 MOD 使用`
    }
    return status
  }

  return base
}

export async function planInstall(request: InstallRequest): Promise<InstallPlan> {
  const game = await getGame(request.gameId)
  if (!game) throw new Error('没有找到该游戏条目')
  const pkg = await getPackage(request.packageId)
  if (!pkg) throw new Error('没有找到该运行库，请先在「运行库」里导入或下载')
  const proxyName = request.proxyName || 'version.dll'
  const proxy = await resolveProxySource(pkg, proxyName)
  const dir = request.exeDir ? normalize(request.exeDir) : game.exeDir
  const actions: InstallPlanAction[] = []
  const blockers: string[] = []
  const warnings: string[] = []

  const invalidDir = validateTargetDir(dir)
  if (invalidDir) blockers.push(invalidDir)
  if (!(await pathExists(dir))) blockers.push(`目标目录不存在：${dir}`)
  if (!proxy) blockers.push(`运行库「${pkg.name}」里没有 ${proxyName}`)
  if (RISKY_PROXIES.includes(proxyName.toLowerCase())) {
    warnings.push(`${proxyName} 位于 D3D12 渲染路径，可能影响稳定性；优先用 version.dll 或 winmm.dll`)
  }
  const config = normalizeIniConfig(request.config, pkg.maxMultiplier)
  const running = await runningProcesses([request.exeName ?? game.exeName, game.launchExe ? basename(game.launchExe) : ''])
  if (running.length > 0) blockers.push(`游戏进程正在运行（${running.join('、')}），请先完全退出游戏`)

  const present = await findKnownProxiesInDir(dir)
  const conflicting = present.filter((p) => p.toLowerCase() !== proxyName.toLowerCase())
  if (conflicting.length > 0) {
    // 上游 0.3.x 起：同目录多个代理不会再互相破坏（游戏先加载的那个跑 MOD，其余只转发），
    // 所以这里只提示、不再阻塞。
    warnings.push(
      `同目录还有其它本项目代理（${conflicting.join('、')}）。上游说明多个代理同时存在不会出错（游戏先加载的那个生效，其余只转发），但建议只留一个，避免以后排查时混淆。`
    )
  }

  const targets = [targetFileFor(dir, proxyName), join(dir, 'dlssg_sm86.ini')]
  if (proxy) {
    const exists = await pathExists(targets[0])
    if (exists) {
      const currentHash = await sha256File(targets[0])
      if (currentHash === proxy.sha256) {
        actions.push({ kind: 'keep', target: targets[0], detail: '已是最新，无需替换', level: 'info' })
      } else {
        actions.push({ kind: 'backup', target: targets[0], detail: '备份现有 DLL 后替换', level: 'warn' })
        actions.push({ kind: 'copy-proxy', target: targets[0], detail: `写入 ${proxyName}（${humanSize((await stat(proxy.absPath)).size)}）`, level: 'info' })
      }
    } else {
      actions.push({ kind: 'copy-proxy', target: targets[0], detail: `新建 ${proxyName}`, level: 'info' })
    }
  }
  const iniExists = await pathExists(targets[1])
  if (iniExists) {
    actions.push({ kind: 'backup', target: targets[1], detail: '备份现有 dlssg_sm86.ini', level: 'info' })
  }
  actions.push({
    kind: 'write-ini',
    target: targets[1],
    detail: `写入配置：${config.enabled ? '启用' : '关闭'} / 档位 ${config.optimized}（${optimizedTierLabel(config.optimized)}） / 上限 ${config.maxGeneratedFrames + 1}X / 预设 ${config.preset} / 日志等级 ${config.logLevel}`,
    level: 'info'
  })

  if (game.exeName && !(await pathExists(join(dir, game.exeName)))) {
    warnings.push(`目标目录里没有 ${game.exeName}，确认这是渲染 EXE 目录`)
  }

  return {
    gameId: game.id,
    exeDir: dir,
    proxyName,
    packageId: pkg.id,
    packageName: pkg.name,
    actions,
    blockers,
    warnings,
    runningProcesses: running,
    alreadyInstalled: Boolean(game.install)
  }
}

async function pruneBackups(gameId: string, keep: number): Promise<void> {
  const root = join(backupsDir(), gameId)
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return
  }
  const sorted = entries.sort().reverse()
  for (const dir of sorted.slice(Math.max(0, keep))) {
    await removeIfExists(join(root, dir))
  }
}

export async function listBackups(gameId: string): Promise<BackupEntry[]> {
  const root = join(backupsDir(), gameId)
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return []
  }
  const result: BackupEntry[] = []
  for (const dir of entries.sort().reverse()) {
    const abs = join(root, dir)
    let files: string[]
    try {
      files = await readdir(abs)
    } catch {
      continue
    }
    const list: { name: string; size: number }[] = []
    for (const file of files) {
      const info = await stat(join(abs, file)).catch(() => null)
      if (info?.isFile()) list.push({ name: file, size: info.size })
    }
    result.push({ dir: abs, gameId, createdAt: dir, files: list })
  }
  return result
}

export async function applyInstall(request: InstallRequest): Promise<InstallResult> {
  const plan = await planInstall(request)
  const force = request.force ?? false
  if (plan.blockers.length > 0 && !force) {
    return { ok: false, message: plan.blockers.join('；') }
  }
  const game = await getGame(request.gameId)
  if (!game) return { ok: false, message: '没有找到该游戏条目' }
  const pkg = await getPackage(request.packageId)
  if (!pkg) return { ok: false, message: '没有找到该运行库' }
  const proxy = await resolveProxySource(pkg, plan.proxyName)
  if (!proxy) return { ok: false, message: `运行库「${pkg.name}」里没有 ${plan.proxyName}` }

  const dir = plan.exeDir
  const config = normalizeIniConfig(request.config, pkg.maxMultiplier)
  const backupDir = join(backupsDir(), game.id, new Date().toISOString().replace(/[:.]/g, '-'))
  await ensureDir(backupDir)

  const files: InjectedFileRecord[] = []
  const total = 2
  let done = 0

  const dllTarget = join(dir, plan.proxyName)
  const iniTarget = join(dir, 'dlssg_sm86.ini')

  // 目标文件只要已存在就先备份，还原时才能回到注入前的状态
  const dllExists = await pathExists(dllTarget)
  let dllBackup: string | undefined
  if (dllExists) {
    dllBackup = join(backupDir, plan.proxyName)
    await atomicCopyFile(dllTarget, dllBackup)
  }
  await atomicCopyFile(proxy.absPath, dllTarget)
  const dllWrittenHash = await sha256File(dllTarget)
  files.push({
    path: dllTarget,
    action: dllExists ? 'replaced' : 'created',
    backupPath: dllBackup,
    sha256: dllWrittenHash,
    size: (await stat(dllTarget)).size
  })
  done += 1
  request.onProgress?.({ scope: 'install', done, total, label: `写入 ${plan.proxyName}` })

  const iniExists = await pathExists(iniTarget)
  let iniBackup: string | undefined
  if (iniExists) {
    iniBackup = join(backupDir, 'dlssg_sm86.ini')
    await atomicCopyFile(iniTarget, iniBackup)
  }
  const iniText = serializeIniConfig(config, {
    runtimeMaxMultiplier: pkg.maxMultiplier,
    runtimeVersion: pkg.runtimeVersion,
    generator: `由 DLSSG GUI v${appVersion} 生成 · 运行库 ${pkg.name}`
  })
  await atomicWriteFile(iniTarget, iniText)
  const iniHash = await sha256File(iniTarget)
  files.push({
    path: iniTarget,
    action: iniExists ? 'replaced' : 'created',
    backupPath: iniBackup,
    sha256: iniHash,
    size: Buffer.byteLength(iniText)
  })
  done += 1
  request.onProgress?.({ scope: 'install', done, total, label: '写入配置' })

  const record: InstallRecord = {
    installedAt: new Date().toISOString(),
    packageId: pkg.id,
    packageName: pkg.name,
    runtimeVersion: pkg.runtimeVersion,
    proxyName: plan.proxyName,
    backupDir,
    files,
    config,
    appVersion
  }

  game.install = record
  game.exeDir = dir
  if (request.exeName) game.exeName = request.exeName
  if (request.launchExe) game.launchExe = request.launchExe
  game.config = config
  game.dlssgCapable = game.dlssgCapable || Boolean(game.candidates.some((c) => c.hasDlssg))
  game.history.unshift({
    at: record.installedAt,
    action: request.force && plan.blockers.length > 0 ? 'repair' : 'install',
    ok: true,
    message: `注入 ${plan.proxyName}（${pkg.name}）→ ${dir}`
  })
  game.history = game.history.slice(0, 50)
  await saveGame(game)

  const settings = await settingsStore.read()
  await pruneBackups(game.id, Math.max(1, settings.keepBackups ?? 3))

  const status = await getGameStatus(game)
  return { ok: true, message: `已注入 ${plan.proxyName}，启动游戏后在画质设置里打开 DLSS 帧生成`, status }
}

export async function updateIniOnly(gameId: string, config: IniConfig): Promise<InstallResult> {
  const game = await getGame(gameId)
  if (!game) return { ok: false, message: '没有找到该游戏条目' }
  if (!game.install) return { ok: false, message: '当前游戏还没有注入记录' }
  const pkg = await getPackage(game.install.packageId)
  const normalized = normalizeIniConfig(config, pkg?.maxMultiplier ?? 6)
  const iniPath = join(game.exeDir, 'dlssg_sm86.ini')
  const text = serializeIniConfig(normalized, {
    runtimeMaxMultiplier: pkg?.maxMultiplier ?? 6,
    runtimeVersion: game.install.runtimeVersion,
    generator: `由 DLSSG GUI v${appVersion} 生成 · 运行库 ${game.install.packageName}`
  })
  await atomicWriteFile(iniPath, text)
  game.install.config = normalized
  const newHash = await sha256File(iniPath)
  game.install.files = game.install.files.map((file) =>
    file.path.toLowerCase() === iniPath.toLowerCase()
      ? { ...file, sha256: newHash, size: Buffer.byteLength(text) }
      : file
  )
  game.config = normalized
  game.history.unshift({ at: new Date().toISOString(), action: 'install', ok: true, message: '同步了 ini 配置' })
  await saveGame(game)
  const status = await getGameStatus(game)
  return { ok: true, message: '配置已写入，重启游戏后生效', status }
}

export async function restoreGame(gameId: string, options: { force?: boolean; removeLogs?: boolean } = {}): Promise<InstallResult> {
  const game = await getGame(gameId)
  if (!game) return { ok: false, message: '没有找到该游戏条目' }
  const record = game.install
  if (!record) return { ok: false, message: '没有本工具的注入记录，无法自动还原' }

  const running = await runningProcesses([game.exeName, game.launchExe ? basename(game.launchExe) : ''])
  if (running.length > 0 && !options.force) {
    return { ok: false, message: `游戏正在运行（${running.join('、')}），请先完全退出` }
  }

  const modified: string[] = []
  for (const file of record.files) {
    if (!(await pathExists(file.path))) continue
    const actual = await sha256File(file.path)
    if (actual !== file.sha256) modified.push(file.path)
  }
  if (modified.length > 0 && !options.force) {
    return { ok: false, message: `以下文件在注入后被改动过，还原会覆盖它们：\n${modified.join('\n')}` }
  }

  const messages: string[] = []
  for (const file of record.files) {
    if (file.action === 'created') {
      await removeIfExists(file.path)
      messages.push(`删除 ${file.path}`)
    } else if (file.backupPath && (await pathExists(file.backupPath))) {
      await atomicCopyFile(file.backupPath, file.path)
      messages.push(`还原 ${file.path}`)
    } else {
      await removeIfExists(file.path)
      messages.push(`删除 ${file.path}（没有备份）`)
    }
  }
  if (options.removeLogs) {
    const logDir = join(game.exeDir, record.config.logDirectory || 'dlssg_sm86\\logs')
    await removeIfExists(logDir)
    messages.push(`删除日志目录 ${logDir}`)
  }

  game.install = undefined
  game.history.unshift({
    at: new Date().toISOString(),
    action: 'restore',
    ok: true,
    message: `还原完成：${messages.length} 个文件`
  })
  game.history = game.history.slice(0, 50)
  await saveGame(game)
  const status = await getGameStatus(game)
  return { ok: true, message: messages.join('\n'), status }
}
