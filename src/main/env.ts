import { spawn } from 'node:child_process'
import type { EnvironmentInfo, GpuInfo } from '@shared/types'
import { dataDir } from './paths'

interface SmiResult {
  gpus: GpuInfo[]
  error?: string
}

function run(command: string, args: string[], timeoutMs = 8000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      resolvePromise({ code: -1, stdout, stderr: 'timeout' })
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ code: -1, stdout, stderr: String(error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code: code ?? -1, stdout, stderr })
    })
  })
}

async function queryNvidiaSmi(): Promise<SmiResult> {
  const result = await run('nvidia-smi.exe', ['--query-gpu=name,driver_version', '--format=csv,noheader'])
  if (result.code !== 0) return { gpus: [], error: result.stderr || 'nvidia-smi 调用失败' }
  const gpus: GpuInfo[] = []
  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [name, driver] = trimmed.split(',').map((part) => part.trim())
    if (name) gpus.push({ name, driver: driver ?? '' })
  }
  return { gpus }
}

async function queryWmic(): Promise<GpuInfo[]> {
  const result = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "(Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'NVIDIA' } | Select-Object -ExpandProperty Name) -join \"`n\""
  ], 15000)
  if (result.code !== 0) return []
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => ({ name, driver: '' }))
}

function classify(name: string): EnvironmentInfo['smKind'] {
  if (/RTX\s*50|RTX\s*40|Blackwell|Ada/i.test(name)) return 'ada+'
  if (/RTX\s*30|A\d{4}|Ampere/i.test(name)) return 'sm86'
  if (/RTX\s*20|TITAN\s*RTX|Quadro\s*RTX\s*(5000|6000|8000)/i.test(name)) return 'sm75'
  return 'unknown'
}

export async function detectEnvironment(electronVersion: string, chromeVersion: string): Promise<EnvironmentInfo> {
  const smi = await queryNvidiaSmi()
  let gpus = smi.gpus
  const warnings: string[] = []
  const notes: string[] = []
  if (gpus.length === 0) {
    gpus = await queryWmic()
    if (gpus.length === 0) {
      warnings.push('没有检测到 NVIDIA 显卡或驱动（nvidia-smi 不可用）。本工具需要带 NGX/NVAPI 的 NVIDIA 驱动。')
    }
  }
  const primary = gpus[0]
  const driverMajor = primary?.driver ? Number(/^\d+/.exec(primary.driver)?.[0] ?? NaN) : null
  const smKind = primary ? classify(primary.name) : 'unknown'

  if (primary) {
    if (smKind === 'ada+') {
      warnings.push(`${primary.name} 属于 RTX 40/50 系，原生就支持帧生成，通常不需要本项目`)
    } else if (smKind === 'sm75') {
      notes.push(
        'RTX 20 系（Turing / SM75）：上游 0.3.1 起已修复，出厂 ini 直接用即可，内核族会按物理显卡自动选到 SM75；0.3.3 起还会在游戏启动前改写架构闸门，让游戏放出 3X/4X/6X 选项。真机实测输出与 3080 Ti 逐位一致，但 Turing 上的性能上游尚未测量。'
      )
    } else if (smKind === 'unknown') {
      notes.push(`无法从「${primary.name}」判断架构，请确认是 RTX 20/30 系（其它架构不保证可用）`)
    }
    if (driverMajor !== null && Number.isFinite(driverMajor)) {
      if (driverMajor < 580) notes.push(`驱动 ${primary.driver} 较旧：cubin 不可用，会回退 PTX，首帧多一次 JIT（可正常用）`)
      if (driverMajor < 530) warnings.push(`驱动 ${primary.driver} 过旧，可能缺少 NGX/NVAPI 接口，建议升级到 591.86 或更新`)
    }
  }

  return {
    appVersion: '',
    electron: electronVersion,
    node: process.versions.node,
    chrome: chromeVersion,
    platform: process.platform,
    arch: process.arch,
    dataDir: dataDir(),
    gpus,
    driverMajor: driverMajor !== null && Number.isFinite(driverMajor) ? driverMajor : null,
    smKind,
    warnings,
    notes
  }
}
