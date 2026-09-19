import type { ExtraIniKey, IniConfig, LogLevel } from './types'

/**
 * dlssg_sm86.ini 的键说明，对齐上游 0.3.4（docs/INSTALL.md）。
 *
 * 上游把键分成两类：
 * - 出厂 INI 里的决定性键（core）：界面直接给控件、一定会写进生成的 ini；
 * - 高级 / 诊断键（optional）：默认不写、缺失时上游取安全默认值。界面做成
 *   「可选键目录」，用户按需添加，添加后按类型渲染控件；未收录的键走 extra 原样透传。
 */
export type IniKeyType = 'bool' | 'enum' | 'int' | 'string' | 'tristate'

export interface IniOption {
  value: string
  label: string
}

export interface IniKeySpec {
  section: string
  key: string
  type: IniKeyType
  default: string
  label: string
  help: string
  options?: IniOption[]
  min?: number
  max?: number
  /** 出厂 INI 里的键：始终写入生成的文件 */
  core?: boolean
  /** 会降性能 / 实验性 / 有损，界面要标出来 */
  risk?: 'perf' | 'experimental' | 'lossy'
}

/** 一致性档位：[FrameGeneration] Optimized（上游 0.3.2 起是 0–3 四级） */
export const OPTIMIZED_TIERS: { value: number; label: string; help: string }[] = [
  { value: 0, label: '0 — 原厂内核', help: '不做任何加速，运行库原始数值（最保守，也最慢）' },
  { value: 1, label: '1 — 逐位一致（推荐）', help: '全部加速，输出与官方运行库逐位相同。上游出厂默认' },
  { value: 2, label: '2 — 有损图像内核', help: '在档位 1 之上再加有损图像内核，对官方输出 PSNR 仍在 ~50 dB 以上。仅 310.9 构建' },
  { value: 3, label: '3 — 全部有损加速', help: '画质代价最大、速度最快。仅 310.9 构建（310.1 上 2/3 等同 1）' }
]

export function optimizedTierLabel(tier: number): string {
  return OPTIMIZED_TIERS.find((item) => item.value === tier)?.label ?? `档位 ${tier}`
}

/** 需要写进生成文件的核心键（与上游出厂 INI 同款） */
export const INI_CORE_SPECS: IniKeySpec[] = [
  {
    section: 'General',
    key: 'Enabled',
    type: 'bool',
    default: '1',
    label: '启用帧生成',
    help: '1 = 用代理内嵌的运行库做帧生成；0 = 关闭，游戏自带的 DLSS-G 原样加载（Ampere/Turing 上等于没有帧生成）。两种情况代理都会转发系统 DLL。',
    core: true
  },
  {
    section: 'FrameGeneration',
    key: 'Optimized',
    type: 'int',
    default: '1',
    min: 0,
    max: 3,
    label: '优化内核档位',
    help: '一致性档位：数字越大越快、离官方画面越远。0 原厂 / 1 逐位一致（上游出厂默认）/ 2 有损约 50dB（仅 310.9）/ 3 全部有损最快（仅 310.9）。',
    core: true
  },
  {
    section: 'FrameGeneration',
    key: 'MaxGeneratedFrames',
    type: 'int',
    default: '3',
    min: 1,
    max: 5,
    label: '帧生成倍率上限',
    help: '3 = 最高 4X（上游出厂默认），5 = 最高 6X（仅 310.9 构建）。实际倍率由游戏请求，并钳到这个上限与运行库上限的较小者。',
    core: true
  },
  {
    section: 'Compatibility',
    key: 'Preset',
    type: 'enum',
    default: 'Auto',
    label: '渲染预设（UI 重组）',
    help: '仅 310.9 构建有效。Auto = 不干预；A = 强制关闭 UI 重组；B = 强制开启，需要游戏同时提供 HUD-less 与 UI 平面，多数游戏下等于没开。',
    options: [
      { value: 'Auto', label: 'Auto — 不干预（默认）' },
      { value: 'A', label: 'A — 强制关闭 UI 重组' },
      { value: 'B', label: 'B — 强制开启（多数游戏无效）' }
    ],
    core: true
  },
  {
    section: 'Logging',
    key: 'Level',
    type: 'int',
    default: '1',
    min: 0,
    max: 3,
    label: '日志等级',
    help: '0 关闭 / 1 仅错误（默认）/ 2 配置与能力 / 3 内核与求值轨迹。排查问题用 2 或 3。',
    core: true
  },
  {
    section: 'Logging',
    key: 'Directory',
    type: 'string',
    default: 'dlssg_sm86\\logs',
    label: '日志目录',
    help: '相对 ini 所在目录（也就是游戏渲染 EXE 目录）。',
    core: true
  },
  {
    section: 'Runtime',
    key: 'Mode',
    type: 'string',
    default: 'Bundled',
    label: '运行库模式',
    help: 'Bundled = 始终使用代理内嵌的配套运行库与后端（常规用法，不需要匹配游戏里的 DLL 版本）。',
    core: true
  },
  {
    section: 'Runtime',
    key: 'CacheDirectory',
    type: 'string',
    default: '',
    label: '内核缓存目录',
    help: '留空 = %LOCALAPPDATA%\\DlssgSm86\\bundles；相对路径基于 ini 所在目录。',
    core: true
  }
]

/** 高级 / 诊断键目录：默认不写，缺失时上游取安全默认值 */
export const INI_OPTIONAL_SPECS: IniKeySpec[] = [
  {
    section: 'Compatibility',
    key: 'Router',
    type: 'enum',
    default: 'Auto',
    label: '内核族 Router',
    help: 'Auto 按物理显卡选（SM86 及以上走 SM86，Turing 走 SM75）。SM75 是实验项、两种构建都有；真 20 系实机实测输出与 3080 Ti 逐位一致，性能尚未测量。',
    options: [
      { value: 'Auto', label: 'Auto — 按显卡自动（推荐）' },
      { value: 'SM86', label: 'SM86 — 强制 Ampere 路由' },
      { value: 'SM75', label: 'SM75 — 强制 Turing 路由（实验）' }
    ],
    risk: 'experimental'
  },
  {
    section: 'Compatibility',
    key: 'SM75Family',
    type: 'enum',
    default: 'Repaired',
    label: 'SM75 原厂内核族',
    help: '只在走 SM75 路由时有意义。Repaired = 上游修复过的那份（默认，仓库全部结果都测在它上面）；Original = 原样导入的 Coldwood1026 二进制，给真 Turing 用户做 A/B。',
    options: [
      { value: 'Repaired', label: 'Repaired — 修复版（默认）' },
      { value: 'Original', label: 'Original — 原样导入（A/B 用）' }
    ]
  },
  {
    section: 'Compatibility',
    key: 'KernelImage',
    type: 'enum',
    default: 'Auto',
    label: '内核加载格式',
    help: 'Auto 在物理 SM 匹配时用 Cubin，否则 PTX；Cubin 被驱动拒绝会自动回退同一内核的 PTX；Original 只装钩子不替换内核（310.9 在 Ampere 上用不了）。',
    options: [
      { value: 'Auto', label: 'Auto — 自动（推荐）' },
      { value: 'PTX', label: 'PTX — 驱动 JIT' },
      { value: 'Cubin', label: 'Cubin — 预编译内核' },
      { value: 'Original', label: 'Original — 不替换内核（诊断）' }
    ]
  },
  {
    section: 'Compatibility',
    key: 'SpoofArchToGame',
    type: 'tristate',
    default: '',
    label: '显卡架构改写 SpoofArchToGame',
    help: '只管游戏（和 Streamline）那道「本硬件不支持帧生成」的闸门。不写 = 自动（与写 1 的安装时机相同，只是日志策略不同）；1 = 显式启用；0 = 永不安装。改写只影响游戏侧判断，NVIDIA 自己的组件一律看真实架构。',
    options: [
      { value: '', label: '不写 — 自动（推荐）' },
      { value: '1', label: '1 — 显式启用' },
      { value: '0', label: '0 — 永不安装' }
    ]
  },
  {
    section: 'Compatibility',
    key: 'SpoofArchValue',
    type: 'enum',
    default: 'Auto',
    label: '改写上报的架构',
    help: 'Auto 对 Turing 与 Ampere 都报 Blackwell（0x1b0），游戏的 3X/4X/6X 选项正是按这个架构放开；报 Ada 能过闸门但游戏里只剩 2X，仅作诊断覆盖。',
    options: [
      { value: 'Auto', label: 'Auto — Blackwell（推荐）' },
      { value: 'Ada', label: 'Ada — 诊断对比用' },
      { value: 'Blackwell', label: 'Blackwell — 显式写死' }
    ]
  },
  {
    section: 'FrameGeneration',
    key: 'SkipRepeatedRealCopy',
    type: 'bool',
    default: '0',
    label: '跳过重复的真实帧拷贝',
    help: '跳过运行库在同一组里重复发出的全分辨率 OutputReal 拷贝。离线重放逐位一致，但实际游戏里曾收到闪屏反馈，所以默认关闭、只作为显式选项。',
    risk: 'experimental'
  },
  {
    section: 'FrameGeneration',
    key: 'HardwareBilinear',
    type: 'bool',
    default: '0',
    label: '开放硬件双线性采样',
    help: '1 允许近似硬件双线性采样（仅 SM86；310.9 构建在 SM75 上强制 0）。会改变生成帧像素，属于会降低性能/改变画面的诊断项。',
    risk: 'perf'
  },
  {
    section: 'FrameGeneration',
    key: 'ForceGeneratedFrames',
    type: 'int',
    default: '0',
    min: 0,
    max: 16,
    label: '强制生成帧数（诊断）',
    help: '让帧数 getter 每次都返回这个值，钳到 MaxGeneratedFrames 与后端上限。只有当游戏的 Streamline 插件会读回帧数时才有作用，否则只会让插值相位错乱、画面发抖。用完改回 0。',
    risk: 'experimental'
  },
  {
    section: 'FrameGeneration',
    key: 'ForcePluginFrames',
    type: 'enum',
    default: '0',
    label: '给旧 4X 插件强推 6X（有害）',
    help: '给自带旧版 4X Streamline 插件的游戏打内存补丁跑 6X。上游实测：补丁机制成功，但游戏跑几帧后整个 DLSS-G 硬失败关闭，结论是对 4X 游戏不可用且有害，默认关。',
    options: [
      { value: '0', label: '0 — 关闭（强烈建议）' },
      { value: '2', label: '2' },
      { value: '3', label: '3' },
      { value: '4', label: '4' },
      { value: '5', label: '5' }
    ],
    risk: 'experimental'
  },
  {
    section: 'Logging',
    key: 'File',
    type: 'bool',
    default: '1',
    label: '写日志文件',
    help: '0 = 关闭文件输出（仍受 Level 控制）。',
    risk: 'perf'
  },
  {
    section: 'Logging',
    key: 'DebugOutput',
    type: 'bool',
    default: '0',
    label: '同时输出到调试器',
    help: '1 = 通过 Windows 调试输出发送日志，可由调试器接收；不会显示在游戏画面上。',
    risk: 'perf'
  },
  {
    section: 'Logging',
    key: 'EvaluateEvery',
    type: 'int',
    default: '120',
    min: 1,
    max: 1000000,
    label: 'Evaluate 采样间隔',
    help: '正常 Evaluate / 标记日志的采样间隔（按调用计数）。1 记录每次；0 按 120 处理。',
    risk: 'perf'
  },
  {
    section: 'Debug',
    key: 'MarkGeneratedFrames',
    type: 'bool',
    default: '0',
    label: '在生成帧上画序号',
    help: '在生成输出上绘制 FG 1/3 之类的标记，用来区分毛刺出在生成帧还是真实帧。会改动生成帧像素，做数值比较时要关掉。',
    risk: 'perf'
  },
  {
    section: 'Debug',
    key: 'MarkerX',
    type: 'int',
    default: '8',
    min: 0,
    max: 65535,
    label: '标记 X 坐标',
    help: '标记左上角横坐标（输出纹理像素）。',
    risk: 'perf'
  },
  {
    section: 'Debug',
    key: 'MarkerY',
    type: 'int',
    default: '8',
    min: 0,
    max: 65535,
    label: '标记 Y 坐标',
    help: '标记左上角纵坐标（输出纹理像素）。',
    risk: 'perf'
  },
  {
    section: 'Debug',
    key: 'MarkerScale',
    type: 'int',
    default: '2',
    min: 1,
    max: 8,
    label: '标记缩放',
    help: '标记矩形的缩放倍率（24×scale 宽、9×scale 高）。',
    risk: 'perf'
  },
  {
    section: 'Debug',
    key: 'Capture',
    type: 'int',
    default: '0',
    min: 0,
    max: 100000,
    label: '抓取 Evaluate（离线重放）',
    help: '录多少次 Evaluate 的参数、输入和输出，供离线重放。0 = 不装任何钩子；1080p RGBA8 约 48 MB/次。其余的 Capture* 细项可以用「自定义键」添加。',
    risk: 'perf'
  },
  {
    section: 'Debug',
    key: 'CaptureDirectory',
    type: 'string',
    default: 'dlssg_sm86\\capture',
    label: '抓取目录',
    help: '相对游戏 EXE 目录。',
    risk: 'perf'
  },
  {
    section: 'Debug',
    key: 'MfgProbe',
    type: 'bool',
    default: '0',
    label: 'MFG 探针',
    help: '记录每一次对帧数参数的 set 与 get，用来判断「生成几帧」是谁决定的。Capture=0 时也能单独工作。',
    risk: 'perf'
  }
]

export const INI_ALL_SPECS: IniKeySpec[] = [...INI_CORE_SPECS, ...INI_OPTIONAL_SPECS]

export function findSpec(section: string, key: string): IniKeySpec | undefined {
  const s = section.trim().toLowerCase()
  const k = key.trim().toLowerCase()
  return INI_ALL_SPECS.find((spec) => spec.section.toLowerCase() === s && spec.key.toLowerCase() === k)
}

export function optionValues(spec: IniKeySpec): string[] {
  return (spec.options ?? []).map((option) => option.value)
}

/** 上游 0.3.1 起出厂默认是 3（4X）；6X 需要显式改成 5 */
export const DEFAULT_MAX_GENERATED_FRAMES = 3

export function defaultIniConfig(): IniConfig {
  return {
    enabled: true,
    optimized: 1,
    maxGeneratedFrames: DEFAULT_MAX_GENERATED_FRAMES,
    preset: 'Auto',
    logLevel: 1,
    logDirectory: 'dlssg_sm86\\logs',
    runtimeMode: 'Bundled',
    cacheDirectory: '',
    extra: []
  }
}

function boolToIni(value: boolean): string {
  return value ? '1' : '0'
}

export function iniConfigToMap(config: IniConfig, runtimeMaxMultiplier = 6): Map<string, Map<string, string>> {
  const maxFrames = runtimeMaxMultiplier >= 6 ? 5 : 3
  const frames = Math.min(Math.max(1, Math.trunc(config.maxGeneratedFrames) || DEFAULT_MAX_GENERATED_FRAMES), maxFrames)
  const tier = Math.min(3, Math.max(0, Math.trunc(config.optimized)))
  const map = new Map<string, Map<string, string>>()
  const put = (section: string, key: string, value: string): void => {
    if (!map.has(section)) map.set(section, new Map())
    map.get(section)!.set(key, value)
  }
  put('General', 'Enabled', boolToIni(config.enabled))
  put('FrameGeneration', 'Optimized', String(tier))
  put('FrameGeneration', 'MaxGeneratedFrames', String(frames))
  put('Compatibility', 'Preset', config.preset)
  put('Logging', 'Level', String(config.logLevel))
  put('Logging', 'Directory', config.logDirectory)
  put('Runtime', 'Mode', config.runtimeMode)
  put('Runtime', 'CacheDirectory', config.cacheDirectory)
  for (const entry of config.extra) {
    const section = entry.section.trim()
    const key = entry.key.trim()
    if (!section || !key) continue
    // 三态键的空值表示「不写这一行」
    if (entry.value === '' && findSpec(section, key)?.type === 'tristate') continue
    put(section, key, entry.value)
  }
  return map
}

export interface SerializeOptions {
  runtimeMaxMultiplier?: number
  runtimeVersion?: string
  /** 生成文件的来源标注，写进头部注释 */
  generator?: string
}

/** 生成带注释的 dlssg_sm86.ini（注释语义跟随上游 0.3.4） */
export function serializeIniConfig(config: IniConfig, options: SerializeOptions = {}): string {
  const maxMultiplier = options.runtimeMaxMultiplier ?? 6
  const map = iniConfigToMap(config, maxMultiplier)
  const frames = map.get('FrameGeneration')!.get('MaxGeneratedFrames')!
  const multiplierText = { 1: '2X', 2: '3X', 3: '4X', 4: '5X', 5: '6X' }[Number(frames)] ?? `${Number(frames) + 1}X`
  const tier = map.get('FrameGeneration')!.get('Optimized')!

  const lines: string[] = []
  lines.push('; DLSSG SM86 - Ampere（RTX 30 系）与 Turing（RTX 20 系）的 DLSS 帧生成代理配置')
  lines.push('; 本文件由 DLSSG GUI 生成，放在游戏渲染 EXE 旁边，与代理 DLL 同目录。')
  lines.push(`; 运行库：${options.runtimeVersion ?? '未知'}    倍率上限：${multiplierText}    一致性档位：${tier}`)
  lines.push('; 改动本文件后需要重启游戏才会生效。RTX 20 系用这份文件即可，内核族按物理显卡自动选到 SM75。')
  lines.push('; 完整的高级 / 诊断键见上游 docs\\INSTALL.md（本工具在「高级键」里也能加）。')
  lines.push('')
  lines.push('[General]')
  lines.push('; 1 = 启用帧生成（使用代理内嵌的运行库）。0 = 关闭：游戏自带的 DLSS-G 原样加载，Ampere/Turing 上等于没有帧生成。')
  lines.push('; 两种情况下代理都会把调用转发给系统真实 DLL。')
  lines.push(`Enabled=${map.get('General')!.get('Enabled')}`)
  lines.push('')
  lines.push('[FrameGeneration]')
  lines.push('; 一致性档位：允许生成的画面偏离官方运行库多远。数字越大越快、离官方画面越远。')
  lines.push('; 0 = 原厂内核，不做任何加速；1 = 全部逐位一致的加速（推荐，出厂默认）；')
  lines.push('; 2 = 档位 1 再加有损图像内核（对官方输出 PSNR 仍在 ~50 dB 以上，仅 310.9 构建）；')
  lines.push('; 3 = 全部有损加速（画质代价最大、最快，仅 310.9 构建）。310.1 构建上 2/3 等同于 1。')
  lines.push(`Optimized=${tier}`)
  lines.push('; 帧生成倍率上限：3 = 最高 4X（出厂默认），5 = 最高 6X（仅 310.9 构建）。')
  lines.push('; 实际倍率由游戏请求，并钳到这个上限与运行库上限的较小者；自带 4X 插件的游戏仍是 4X。')
  lines.push(`MaxGeneratedFrames=${frames}`)
  lines.push('')
  lines.push('[Compatibility]')
  lines.push('; DLSS-G 渲染预设（UI 重组），仅 310.9 构建有效。Auto = 不干预；A = 强制关闭；')
  lines.push('; B = 强制开启（需要游戏同时提供 HUD-less 与 UI 平面，多数游戏下等于没开）。310.1 上会被拒。')
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

  const core = new Set(INI_CORE_SPECS.map((spec) => `${spec.section}\u0000${spec.key}`))
  const extrasBySection = new Map<string, ExtraIniKey[]>()
  for (const entry of config.extra) {
    const section = entry.section.trim()
    const key = entry.key.trim()
    if (!section || !key) continue
    if (core.has(`${section}\u0000${key}`)) continue
    if (entry.value === '' && findSpec(section, key)?.type === 'tristate') continue
    const list = extrasBySection.get(section) ?? []
    list.push({ section, key, value: entry.value })
    extrasBySection.set(section, list)
  }
  for (const [section, items] of extrasBySection) {
    lines.push('')
    lines.push(`[${section}]`)
    for (const item of items) {
      const spec = findSpec(section, item.key)
      if (spec) lines.push(`; ${spec.label}：${spec.help}`)
      lines.push(`${item.key}=${item.value}`)
    }
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

function parseIntInRange(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * 把磁盘上的 ini 解析成界面配置；缺键用默认值补齐。
 * 兼容 0.3.2 之前的布尔写法（那时 Optimized=0/1 分别就是现在的档位 0/1）。
 */
export function parseIniConfig(text: string): IniConfig {
  const base = defaultIniConfig()
  const map = parseIniText(text)
  const enabled = pick(map, 'General', 'Enabled')
  if (enabled !== undefined) base.enabled = enabled !== '0'
  const optimized = pick(map, 'FrameGeneration', 'Optimized') ?? pick(map, 'Compatibility', 'OptimizedKernels')
  if (optimized !== undefined) base.optimized = parseIntInRange(optimized, 1, 0, 3)
  const frames = pick(map, 'FrameGeneration', 'MaxGeneratedFrames')
  if (frames !== undefined) base.maxGeneratedFrames = parseIntInRange(frames, DEFAULT_MAX_GENERATED_FRAMES, 1, 5)
  const preset = pick(map, 'Compatibility', 'Preset')
  if (preset === 'A' || preset === 'B' || preset === 'Auto') base.preset = preset
  const level = pick(map, 'Logging', 'Level')
  if (level !== undefined) base.logLevel = parseIntInRange(level, 1, 0, 3) as LogLevel
  const dir = pick(map, 'Logging', 'Directory')
  if (dir !== undefined) base.logDirectory = dir
  const mode = pick(map, 'Runtime', 'Mode')
  if (mode !== undefined) base.runtimeMode = mode
  const cache = pick(map, 'Runtime', 'CacheDirectory')
  if (cache !== undefined) base.cacheDirectory = cache

  const core = new Set(INI_CORE_SPECS.map((spec) => `${spec.section}\u0000${spec.key}`))
  const extra: ExtraIniKey[] = []
  for (const [section, kv] of map) {
    for (const [key, value] of kv) {
      if (core.has(`${section}\u0000${key}`)) continue
      extra.push({ section, key, value })
    }
  }
  base.extra = extra
  return base
}

/** 归一化：把倍率与档位钳到运行库支持的范围，清理非法 extra。 */
export function normalizeIniConfig(config: IniConfig, runtimeMaxMultiplier = 6, runtimeSupportsTiers = true): IniConfig {
  const maxFrames = runtimeMaxMultiplier >= 6 ? 5 : 3
  const tierLimit = runtimeSupportsTiers ? 3 : 1
  return {
    ...config,
    optimized: Math.min(tierLimit, Math.max(0, Math.trunc(config.optimized))),
    maxGeneratedFrames: Math.min(Math.max(1, Math.trunc(config.maxGeneratedFrames) || DEFAULT_MAX_GENERATED_FRAMES), maxFrames),
    preset: runtimeSupportsTiers ? config.preset : 'Auto',
    logLevel: Math.min(3, Math.max(0, Math.trunc(config.logLevel))) as LogLevel,
    logDirectory: config.logDirectory.trim() || 'dlssg_sm86\\logs',
    runtimeMode: config.runtimeMode.trim() || 'Bundled',
    extra: config.extra.filter((entry) => entry.section.trim() && entry.key.trim())
  }
}

export function maxMultiplierForFrames(frames: number): string {
  return `${Math.min(5, Math.max(1, Math.trunc(frames))) + 1}X`
}
