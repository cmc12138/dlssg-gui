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
  'node_modules'
])

const HELPER_EXE = /(unitycrashhandler|crashreport|crashpad|crashhandler|launcher|setup|unins|prereq|eossdk|epicwebhelper|activation|vcredist|dxsetup|dotnet|report)/i

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

/** 在一个游戏目录里找可能的渲染 EXE 目录（按是否带 nvngx_dlssg.dll / nvngx_dlss.dll 判断）。 */
export async function findCandidates(gameDir: string): Promise<DetectedExe[]> {
  const dirs = await walkDirs(gameDir, { maxDepth: 4, skipDirNames: SKIP_DIRS })
  const candidates: DetectedExe[] = []
  for (const [dir, files] of dirs) {
    const lower = files.map((f) => f.toLowerCase())
    const hasDlssg = lower.includes('nvngx_dlssg.dll')
    const hasDlss = lower.includes('nvngx_dlss.dll')
    if (!hasDlssg && !hasDlss) continue
    const exes = files.filter((f) => f.toLowerCase().endsWith('.exe') && !HELPER_EXE.test(f))
    let best: { name: string; size: number } | undefined
    for (const exe of exes) {
      const size = await stat(join(dir, exe)).then((s) => s.size).catch(() => 0)
      if (!best || size > best.size) best = { name: exe, size }
    }
    const fallbackExes = files.filter((f) => f.toLowerCase().endsWith('.exe'))
    const exeName = best?.name ?? fallbackExes[0] ?? ''
    candidates.push({ dir, exeName, hasDlssg, hasDlss, recommended: hasDlssg })
  }
  candidates.sort((a, b) => Number(b.hasDlssg) - Number(a.hasDlssg) || Number(b.recommended) - Number(a.recommended))
  return candidates
}

/** 探测单个游戏目录：找候选 EXE 目录并判断是否具备 DLSS-G。 */
export async function detectGameFolder(folder: string): Promise<{ candidates: DetectedExe[]; dlssgCapable: boolean; exeDir: string; exeName: string }> {
  const candidates = await findCandidates(folder)
  const primary = candidates.find((c) => c.hasDlssg) ?? candidates[0]
  let exeDir = primary?.dir ?? folder
  let exeName = primary?.exeName ?? ''
  if (!exeName) {
    const exes = await readdir(folder, { withFileTypes: true }).catch(() => [])
    const list = exes.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.exe') && !HELPER_EXE.test(e.name))
    if (list.length > 0) exeName = list[0].name
    exeDir = folder
  }
  return { candidates, dlssgCapable: candidates.some((c) => c.hasDlssg), exeDir, exeName }
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
