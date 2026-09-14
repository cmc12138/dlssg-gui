import type { ExtraIniKey, IniConfig, LogLevel } from './types'

/**
 * dlssg_sm86.ini 的键说明。上游 0.3.0（代理模式）出厂文件只写了
 * [General]/[FrameGeneration]/[Compatibility]/[Logging]/[Runtime] 这几组，
 * 其余"高级键"上游未在公开文档里给全，所以界面把已知键做成表单，
 * 未收录的键走 extra 原样透传。
 */
export interface IniKeySpec {
  section: string
  key: string
  type: 'bool' | 'enum' | 'int' | 'string'
  default: string
  min?: number
  max?: number
  options?: string[]
  /** 需要一个已导入的运行库包才能判断取值上限 */
  dependsOnRuntime?: boolean
}

export const INI_SPECS: IniKeySpec[] = [
  { section: 'General', key: 'Enabled', type: 'bool', default: '1' },
  { section: 'FrameGeneration', key: 'Optimized', type: 'bool', default: '1' },
  { section: 'FrameGeneration', key: 'MaxGeneratedFrames', type: 'int', default: '5', min: 1, max: 5, dependsOnRuntime: true },
  { section: 'Compatibility', key: 'Preset', type: 'enum', default: 'Auto', options: ['Auto', 'A', 'B'] },
  { section: 'Logging', key: 'Level', type: 'int', default: '1', min: 0, max: 3 },
  { section: 'Logging', key: 'Directory', type: 'string', default: 'dlssg_sm86\\logs' },
  { section: 'Runtime', key: 'Mode', type: 'string', default: 'Bundled' },
  { section: 'Runtime', key: 'CacheDirectory', type: 'string', default: '' }
]

export function defaultIniConfig(): IniConfig {
  return {
    enabled: true,
    optimized: true,
    maxGeneratedFrames: 5,
    preset: 'Auto',
    logLevel: 1,
    logDirectory: 'dlssg_sm86\\logs',
    runtimeMode: 'Bundled',
    cacheDirectory: '',
    extra: []
  }
}

function boolToIni(v: boolean): string {
  return v ? '1' : '0'
}

export function iniConfigToMap(config: IniConfig, runtimeMaxMultiplier = 6): Map<string, Map<string, string>> {
  const maxFrames = runtimeMaxMultiplier >= 6 ? 5 : 3
  const frames = Math.min(Math.max(1, Math.trunc(config.maxGeneratedFrames)), maxFrames)
  const map = new Map<string, Map<string, string>>()
  const put = (section: string, key: string, value: string): void => {
    if (!map.has(section)) map.set(section, new Map())
    map.get(section)!.set(key, value)
  }
  put('General', 'Enabled', boolToIni(config.enabled))
  put('FrameGeneration', 'Optimized', boolToIni(config.optimized))
  put('FrameGeneration', 'MaxGeneratedFrames', String(frames))
  if (config.preset !== 'Auto') put('Compatibility', 'Preset', config.preset)
  else put('Compatibility', 'Preset', 'Auto')
  put('Logging', 'Level', String(config.logLevel))
  put('Logging', 'Directory', config.logDirectory)
  put('Runtime', 'Mode', config.runtimeMode)
  put('Runtime', 'CacheDirectory', config.cacheDirectory)
  for (const e of config.extra) {
    if (!e.section.trim() || !e.key.trim()) continue
    put(e.section.trim(), e.key.trim(), e.value)
  }
  return map
}

export interface SerializeOptions {
  runtimeMaxMultiplier?: number
  runtimeVersion?: string
  /** 生成文件的来源标注，写进头部注释 */
  generator?: string
}

/** 生成带注释的 dlssg_sm86.ini。 */
export function serializeIniConfig(config: IniConfig, options: SerializeOptions = {}): string {
  const maxMultiplier = options.runtimeMaxMultiplier ?? 6
  const map = iniConfigToMap(config, maxMultiplier)
  const frames = map.get('FrameGeneration')!.get('MaxGeneratedFrames')!
  const multiplierText = { 1: '2X', 2: '3X', 3: '4X', 4: '5X', 5: '6X' }[Number(frames)] ?? `${Number(frames) + 1}X`

  const lines: string[] = []
  lines.push('; DLSSG SM86 - Ampere（RTX 30 系）与更新架构的 DLSS 帧生成代理配置')
  lines.push('; 本文件由 DLSSG GUI 生成，放在游戏渲染 EXE 旁边，与代理 DLL 同目录。')
  lines.push(`; 运行库：${options.runtimeVersion ?? '未知'}    倍率上限：${multiplierText}`)
  lines.push('; 改动本文件后需要重启游戏才会生效。')
  lines.push('')
  lines.push('[General]')
  lines.push('; 1 = 启用帧生成（使用代理内嵌的 Ampere 优化运行库）。0 = 关闭：游戏自带的 DLSS-G 原样加载。')
  lines.push('; 两种情况下代理都会把调用转发给系统真实 DLL。')
  lines.push(`Enabled=${map.get('General')!.get('Enabled')}`)
  lines.push('')
  lines.push('[FrameGeneration]')
  lines.push('; 1 = 使用最优内核（推荐，已校验的最快内核集，输出与原厂逐位一致）。')
  lines.push('; 0 = 原厂内核：不做优化，使用运行库原始数值。两种模式都能在 Ampere 上运行。')
  lines.push(`Optimized=${map.get('FrameGeneration')!.get('Optimized')}`)
  lines.push('; 帧生成倍率上限：5 = 最高 6X，3 = 最高 4X。实际倍率由游戏请求，并钳到运行库上限。')
  lines.push('; 310.9 版运行库最高 6X，310.1 版最高 4X。')
  lines.push(`MaxGeneratedFrames=${frames}`)
  lines.push('')
  lines.push('[Compatibility]')
  lines.push('; DLSS-G 渲染预设（UI 重组），仅 310.9 版可用。Auto = 交给游戏/驱动档案决定（默认）。')
  lines.push('; A = 强制关闭 UI 重组。B = 强制开启（生成帧里的 HUD/UI 更干净），但仅当游戏同时提供')
  lines.push('; 无 HUD 图像与 UI 平面时 B 才有效，多数游戏不满足，此时 B 等于没开。310.1 版忽略此项。')
  lines.push(`Preset=${map.get('Compatibility')!.get('Preset')}`)
  lines.push('')
  lines.push('[Logging]')
  lines.push('; 0 = 关闭，1 = 只记错误，2 = 记录配置与能力，3 = 内核与求值轨迹。日志写入 Directory。')
  lines.push(`Level=${map.get('Logging')!.get('Level')}`)
  lines.push(`Directory=${map.get('Logging')!.get('Directory')}`)
  lines.push('')
  lines.push('[Runtime]')
  lines.push('; Bundled = 始终使用内嵌的配套运行库与后端（常规用法，不需要匹配游戏里的 DLL 版本）。')
  lines.push(`Mode=${map.get('Runtime')!.get('Mode')}`)
  lines.push('; 留空使用 %LOCALAPPDATA%\\DlssgSm86\\bundles。相对路径基于本 INI 所在目录。')
  lines.push(`CacheDirectory=${map.get('Runtime')!.get('CacheDirectory')}`)

  const known = new Set(INI_SPECS.map((s) => `${s.section}\u0000${s.key}`))
  const extrasBySection = new Map<string, ExtraIniKey[]>()
  for (const e of config.extra) {
    if (!e.section.trim() || !e.key.trim()) continue
    if (known.has(`${e.section.trim()}\u0000${e.key.trim()}`)) continue
    const list = extrasBySection.get(e.section.trim()) ?? []
    list.push(e)
    extrasBySection.set(e.section.trim(), list)
  }
  for (const [section, items] of extrasBySection) {
    lines.push('')
    lines.push(`[${section}]`)
    for (const item of items) lines.push(`${item.key.trim()}=${item.value}`)
  }
  lines.push('')
  if (options.generator) lines.push(`; ${options.generator}`)
  return lines.join('\r\n')
}

/** 宽松解析 ini：忽略注释，段落内保留键值。 */
export function parseIniText(text: string): Map<string, Map<string, string>> {
  const map = new Map<string, Map<string, string>>()
  let section = ''
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const sec = /^\[(.+?)\]$/.exec(line)
    if (sec) {
      section = sec[1].trim()
      if (!map.has(section)) map.set(section, new Map())
      continue
    }
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (!section) continue
    if (!map.has(section)) map.set(section, new Map())
    map.get(section)!.set(key, value)
  }
  return map
}

function pick(map: Map<string, Map<string, string>>, section: string, key: string): string | undefined {
  return map.get(section)?.get(key)
}

/** 把磁盘上的 ini 解析成界面配置；缺键用默认值补齐。 */
export function parseIniConfig(text: string): IniConfig {
  const base = defaultIniConfig()
  const map = parseIniText(text)
  const enabled = pick(map, 'General', 'Enabled')
  if (enabled !== undefined) base.enabled = enabled !== '0'
  const optimized = pick(map, 'FrameGeneration', 'Optimized')
  if (optimized !== undefined) base.optimized = optimized !== '0'
  const frames = Number(pick(map, 'FrameGeneration', 'MaxGeneratedFrames'))
  if (Number.isFinite(frames)) base.maxGeneratedFrames = Math.min(5, Math.max(1, Math.trunc(frames)))
  const preset = pick(map, 'Compatibility', 'Preset')
  if (preset === 'A' || preset === 'B' || preset === 'Auto') base.preset = preset
  const level = Number(pick(map, 'Logging', 'Level'))
  if (Number.isFinite(level)) base.logLevel = Math.min(3, Math.max(0, Math.trunc(level))) as LogLevel
  const dir = pick(map, 'Logging', 'Directory')
  if (dir !== undefined) base.logDirectory = dir
  const mode = pick(map, 'Runtime', 'Mode')
  if (mode !== undefined) base.runtimeMode = mode
  const cache = pick(map, 'Runtime', 'CacheDirectory')
  if (cache !== undefined) base.cacheDirectory = cache

  const known = new Set(INI_SPECS.map((s) => `${s.section}\u0000${s.key}`))
  const extra: ExtraIniKey[] = []
  for (const [section, kv] of map) {
    for (const [key, value] of kv) {
      if (known.has(`${section}\u0000${key}`)) continue
      extra.push({ section, key, value })
    }
  }
  base.extra = extra
  return base
}

/** 归一化：把倍率钳到运行库上限，并清理非法 extra。 */
export function normalizeIniConfig(config: IniConfig, runtimeMaxMultiplier = 6, runtimeSupportsPreset = true): IniConfig {
  const maxFrames = runtimeMaxMultiplier >= 6 ? 5 : 3
  return {
    ...config,
    maxGeneratedFrames: Math.min(Math.max(1, Math.trunc(config.maxGeneratedFrames) || 3), maxFrames),
    preset: runtimeSupportsPreset ? config.preset : 'Auto',
    logLevel: Math.min(3, Math.max(0, Math.trunc(config.logLevel))) as LogLevel,
    logDirectory: config.logDirectory.trim() || 'dlssg_sm86\\logs',
    runtimeMode: config.runtimeMode.trim() || 'Bundled',
    extra: config.extra.filter((e) => e.section.trim() && e.key.trim())
  }
}

export function maxMultiplierForFrames(frames: number): string {
  return `${Math.min(5, Math.max(1, Math.trunc(frames))) + 1}X`
}
