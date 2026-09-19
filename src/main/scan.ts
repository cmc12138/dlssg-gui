import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, normalize } from 'node:path'
import type { DetectedExe, GameSource, ScannedGame } from '@shared/types'
import { pathExists, walkDirs } from './fsutil'

const SKIP_DIRS = new Set([
  'redist',
  '_commonredist',
  'redistributable',
  'directx',
  'vcredist',
  'installer',
  '__installer',
  'support',
  'tools',
  'docs',
  'node_modules',
  // 纯素材目录：UE 游戏的 Content/Paks 动辄几万个文件，翻它没有意义（DLL 不会在这下面）
  'content',
  'paks',
  'movies',
  'audio',
  'localization',
  'shaders',
  'shadercache',
  'savegames',
  'saved',
  'videos',
  'derivedatacache',
  'webcache'
])

const HELPER_EXE = /(unitycrashhandler|crashreport|crashpad|crashhandler|crashsender|launcher|setup|installer|unins|prereq|eossdk|epicwebhelper|activation|vcredist|dxsetup|dotnet|report|updater|patcher|dowser|bootstrap)/i

/** 帧生成相关的运行库文件名：NVIDIA DLSS-G（含 Streamline 插件） */
const DLSSG_DLLS = ['nvngx_dlssg.dll', 'sl.dlss_g.dll']
/** DLSS 超分 / 光线重建 */
const DLSS_DLLS = ['nvngx_dlss.dll', 'sl.dlss.dll']
/** AMD FSR3 帧生成（放在渲染 EXE 旁边，是判断"渲染目录"的强信号） */
const FSR_FG_DLLS = ['amd_fidelityfx_framegeneration_dx12.dll', 'amd_fidelityfx_framegeneration_dx12_dx12.dll']

/** 常见的渲染 EXE 目录命名 */
const RENDER_DIR_PATTERNS = [
  /(^|\\)binaries\\win64$/i,
  /(^|\\)binaries\\win32$/i,
  /(^|\\)bin\\x64(_dx12|_vk)?$/i,
  /(^|\\)win64$/i,
  /(^|\\)binaries$/i
]

/** 找游戏目录时最多下探多少层：UE 游戏的 DLSS 插件在 Plugins\...\Binaries\ThirdParty\Win64（约 8 层） */
const MAX_SCAN_DEPTH = 9

export interface ScanProgress {
  done: number
  total: number
  label: string
}

export interface ScanOptions {
  onProgress?: (progress: ScanProgress) => void
  knownKeys?: Set<string>
}

function run(command: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { windowsHide: true })
    let stdout = ''
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.on('error', () => resolvePromise({ code: -1, stdout: '' }))
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout }))
  })
}

async function regQuery(key: string, value?: string): Promise<string> {
  const args = value ? ['query', key, '/v', value] : ['query', key, '/s']
  const { stdout } = await run('reg.exe', args)
  return stdout
}

function regValue(output: string, name: string): string | undefined {
  const re = new RegExp(`^\\s*${name}\\s+REG_SZ\\s+(.+?)\\s*$`, 'im')
  const match = re.exec(output)
  return match?.[1]?.trim()
}

/** 找出 Steam 安装目录。 */
export async function findSteamRoot(): Promise<string | undefined> {
  const hkcu = await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath')
  const fromHkcu = regValue(hkcu, 'SteamPath')
  if (fromHkcu && (await pathExists(fromHkcu))) return normalize(fromHkcu)
  const hklm = await regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath')
  const fromHklm = regValue(hklm, 'InstallPath')
  if (fromHklm && (await pathExists(fromHklm))) return normalize(fromHklm)
  for (const guess of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam', 'D:\\Steam', 'E:\\Steam']) {
    if (await pathExists(guess)) return guess
  }
  return undefined
}

async function scanSteam(onProgress?: (p: ScanProgress) => void, knownKeys?: Set<string>): Promise<{ games: ScannedGame[]; warnings: string[] }> {
  const warnings: string[] = []
  const games: ScannedGame[] = []
  const root = await findSteamRoot()
  if (!root) {
    warnings.push('没有找到 Steam 安装目录，可在「添加游戏」里手动选择游戏目录')
    return { games, warnings }
  }
  const vdfPaths = new Set<string>([join(root, 'steamapps')])
  const vdf = join(root, 'steamapps', 'libraryfolders.vdf')
  if (await pathExists(vdf)) {
    const text = await readFile(vdf, 'utf8')
    for (const match of text.matchAll(/"path"\s*"([^"]+)"/g)) {
      vdfPaths.add(normalize(join(match[1], 'steamapps')))
    }
  }
  let index = 0
  const total = vdfPaths.size
  for (const steamapps of vdfPaths) {
    index += 1
    onProgress?.({ done: index, total, label: `扫描 Steam 库 ${steamapps}` })
    let files: string[]
    try {
      files = await readdir(steamapps)
    } catch {
      continue
    }
    for (const file of files) {
      if (!/^appmanifest_\d+\.acf$/i.test(file)) continue
      let text: string
      try {
        text = await readFile(join(steamapps, file), 'utf8')
      } catch {
        continue
      }
      const name = /"name"\s*"([^"]*)"/.exec(text)?.[1]
      const installdir = /"installdir"\s*"([^"]*)"/.exec(text)?.[1]
      const appid = /"appid"\s*"([^"]*)"/.exec(text)?.[1]
      if (!name || !installdir) continue
      const installDir = join(steamapps, 'common', installdir)
      if (!(await pathExists(installDir))) continue
      const key = `${name.toLowerCase()}|${installDir.toLowerCase()}`
      games.push({
        name,
        source: 'steam',
        installDir,
        appId: appid,
        candidates: [],
        dlssgCapable: false,
        known: knownKeys?.has(key) ?? false
      })
    }
  }
  return { games, warnings }
}

async function scanEpic(onProgress?: (p: ScanProgress) => void, knownKeys?: Set<string>): Promise<{ games: ScannedGame[]; warnings: string[] }> {
  const games: ScannedGame[] = []
  const warnings: string[] = []
  const manifestDir = join(process.env.ProgramData ?? 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
  if (!(await pathExists(manifestDir))) {
    return { games, warnings }
  }
  let files: string[] = []
  try {
    files = await readdir(manifestDir)
  } catch {
    return { games, warnings }
  }
  let index = 0
  for (const file of files) {
    index += 1
    onProgress?.({ done: index, total: files.length, label: `扫描 Epic 清单 ${file}` })
    if (!file.toLowerCase().endsWith('.item')) continue
    try {
      const raw = JSON.parse(await readFile(join(manifestDir, file), 'utf8')) as Record<string, unknown>
      const name = String(raw.DisplayName ?? '').trim()
      const installDir = String(raw.InstallLocation ?? '').trim()
      const launch = String(raw.LaunchExecutable ?? '').trim()
      if (!name || !installDir) continue
      if (!(await pathExists(installDir))) continue
      const key = `${name.toLowerCase()}|${installDir.toLowerCase()}`
      games.push({
        name,
        source: 'epic',
        installDir,
        appId: String(raw.AppName ?? ''),
        exeName: launch ? basename(launch) : undefined,
        candidates: [],
        dlssgCapable: false,
        known: knownKeys?.has(key) ?? false
      })
    } catch {
      /* 单个清单坏了不影响其它 */
    }
  }
  return { games, warnings }
}

async function scanGog(onProgress?: (p: ScanProgress) => void, knownKeys?: Set<string>): Promise<{ games: ScannedGame[]; warnings: string[] }> {
  const games: ScannedGame[] = []
  const warnings: string[] = []
  const output = await regQuery('HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games')
  if (!output.trim()) return { games, warnings }
  const blocks = output.split(/^HKEY_/im).slice(1)
  let index = 0
  for (const block of blocks) {
    index += 1
    onProgress?.({ done: index, total: blocks.length, label: '扫描 GOG 游戏' })
    const name = regValue(block, 'gameName')
    const path = regValue(block, 'path')
    if (!name || !path || !(await pathExists(path))) continue
    const key = `${name.toLowerCase()}|${path.toLowerCase()}`
    games.push({
      name,
      source: 'gog',
      installDir: normalize(path),
      candidates: [],
      dlssgCapable: false,
      known: knownKeys?.has(key) ?? false
    })
  }
  return { games, warnings }
}

/**
 * 在一个游戏目录里找可能的渲染 EXE 目录。
 *
 * 关键点：DLSS-G 的 DLL 和渲染 EXE 不一定在同一层。
 * UE 游戏（例如《光与影：33 号远征队》）把 DLSS 整套放在
 * `<项目>\Plugins\NVIDIA\...\Binaries\ThirdParty\Win64\`（约 8 层深），
 * 而渲染 EXE 在 `<项目>\Binaries\Win64\`。所以这里分两步：
 *   1. 把整棵树翻一遍（限制深度 + 跳过素材目录），判断**游戏整体**有没有 DLSS-G / DLSS；
 *   2. 在所有含 EXE 的目录里挑出最像渲染目录的那个（旁边有帧生成相关 DLL、命名符合惯例、EXE 最大）。
 */
export async function findCandidates(gameDir: string): Promise<DetectedExe[]> {
  const dirs = await walkDirs(gameDir, { maxDepth: MAX_SCAN_DEPTH, skipDirNames: SKIP_DIRS })

  let gameHasDlssg = false
  let gameHasDlss = false
  for (const [, files] of dirs) {
    const lower = files.map((file) => file.toLowerCase())
    if (DLSSG_DLLS.some((name) => lower.includes(name))) gameHasDlssg = true
    if (DLSS_DLLS.some((name) => lower.includes(name))) gameHasDlss = true
  }

  const scored: { candidate: DetectedExe; score: number }[] = []
  for (const [dir, files] of dirs) {
    const lower = files.map((file) => file.toLowerCase())
    const exes = files.filter((file) => file.toLowerCase().endsWith('.exe') && !HELPER_EXE.test(file))
    if (exes.length === 0) continue

    const hasFrameGenDll = DLSSG_DLLS.some((name) => lower.includes(name))
    const hasSuperResDll = DLSS_DLLS.some((name) => lower.includes(name))
    const hasFsrFrameGen = FSR_FG_DLLS.some((name) => lower.includes(name))
    const looksLikeRenderDir = RENDER_DIR_PATTERNS.some((pattern) => pattern.test(dir))

    let best: { name: string; size: number } | undefined
    for (const exe of exes) {
      const size = await stat(join(dir, exe)).then((info) => info.size).catch(() => 0)
      if (!best || size > best.size) best = { name: exe, size }
    }
    if (!best) continue

    // 权重：旁边就是帧生成 DLL > 旁边是超分 DLL / FSR 帧生成 > 目录命名像渲染目录 > EXE 大
    const score =
      (hasFrameGenDll ? 1e9 : 0) +
      (hasFsrFrameGen ? 5e8 : 0) +
      (hasSuperResDll ? 5e8 : 0) +
      (looksLikeRenderDir ? 2e8 : 0) +
      Math.min(best.size, 1e8)

    scored.push({
      score,
      candidate: {
        dir,
        exeName: best.name,
        hasDlssg: gameHasDlssg,
        hasDlss: gameHasDlss,
        hasFsrFrameGen,
        recommended: false
      }
    })
  }

  scored.sort((a, b) => b.score - a.score)
  const candidates = scored.map((item) => item.candidate)
  if (candidates.length > 0) candidates[0].recommended = true
  return candidates
}

/** 探测单个游戏目录：找候选 EXE 目录并判断是否具备 DLSS-G。 */
export async function detectGameFolder(folder: string): Promise<{ candidates: DetectedExe[]; dlssgCapable: boolean; exeDir: string; exeName: string }> {
  const candidates = await findCandidates(folder)
  const primary = candidates[0]
  const dlssgCapable = candidates.some((candidate) => candidate.hasDlssg)
  if (primary) {
    return { candidates, dlssgCapable, exeDir: primary.dir, exeName: primary.exeName }
  }
  // 一个 EXE 都没找到（或者只有被排除的 helper），退回到游戏根目录
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
  const list = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe') && !HELPER_EXE.test(entry.name))
  return { candidates, dlssgCapable, exeDir: folder, exeName: list[0]?.name ?? '' }
}

async function mapWithLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/** 扫描本机所有支持的平台，逐个游戏探测 DLSS-G 能力。 */
export async function scanLibraries(options: ScanOptions = {}): Promise<{ games: ScannedGame[]; warnings: string[] }> {
  const warnings: string[] = []
  const collected: ScannedGame[] = []
  const steam = await scanSteam(options.onProgress, options.knownKeys)
  collected.push(...steam.games)
  warnings.push(...steam.warnings)
  const epic = await scanEpic(options.onProgress, options.knownKeys)
  collected.push(...epic.games)
  warnings.push(...epic.warnings)
  const gog = await scanGog(options.onProgress, options.knownKeys)
  collected.push(...gog.games)
  warnings.push(...gog.warnings)

  const seen = new Set<string>()
  const unique = collected.filter((game) => {
    const key = `${game.name.toLowerCase()}|${game.installDir.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  let done = 0
  await mapWithLimit(unique, 4, async (game) => {
    done += 1
    options.onProgress?.({ done, total: unique.length, label: `探测 ${game.name}` })
    try {
      const detection = await detectGameFolder(game.installDir)
      game.candidates = detection.candidates
      game.dlssgCapable = detection.dlssgCapable
      game.exeDir = detection.exeDir
      game.exeName = detection.exeName
    } catch {
      game.candidates = []
      game.dlssgCapable = false
    }
  })

  unique.sort((a, b) => Number(b.dlssgCapable) - Number(a.dlssgCapable) || a.name.localeCompare(b.name, 'zh-Hans-CN'))
  return { games: unique, warnings }
}

export function gameKey(name: string, installDir: string): string {
  return `${name.toLowerCase()}|${installDir.toLowerCase()}`
}

export function sourceLabel(source: GameSource): string {
  switch (source) {
    case 'steam':
      return 'Steam'
    case 'epic':
      return 'Epic'
    case 'gog':
      return 'GOG'
    default:
      return '手动添加'
  }
}
