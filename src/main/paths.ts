import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 数据目录解析：主进程启动时注入 Electron 的 userData（或用便携模式），
 * 单元测试直接注入临时目录，核心模块因此不依赖 electron。
 */
let overrideDataDir: string | null = null

export function setDataDir(dir: string): void {
  overrideDataDir = dir
}

export function dataDir(): string {
  const dir = overrideDataDir ?? process.env.DLSSG_GUI_DATA_DIR ?? join(process.cwd(), '.dlssg-gui-data')
  return dir
}

export function packagesDir(): string {
  return join(dataDir(), 'packages')
}

export function backupsDir(): string {
  return join(dataDir(), 'backups')
}

export function appLogsDir(): string {
  return join(dataDir(), 'logs')
}

export function downloadsDir(): string {
  return join(dataDir(), 'downloads')
}

export function settingsFile(): string {
  return join(dataDir(), 'settings.json')
}

export function gamesFile(): string {
  return join(dataDir(), 'games.json')
}

export function packagesFile(): string {
  return join(dataDir(), 'packages.json')
}

export function ensureDataDirs(): void {
  for (const dir of [dataDir(), packagesDir(), backupsDir(), appLogsDir(), downloadsDir()]) {
    mkdirSync(dir, { recursive: true })
  }
}
