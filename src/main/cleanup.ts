import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CleanupItem, CleanupReport, RuntimePackage } from '@shared/types'
import { deletePackageRecord, listGames, listPackages, settingsStore } from './db'
import { backupsDir, dataDir, downloadsDir, packagesDir } from './paths'
import { humanSize, pathExists, removeIfExists } from './fsutil'

/**
 * 只清理**本工具自己数据目录**里的东西：
 * - packages/ 下没登记过的孤立目录（导入中断留下的）
 * - 同一个来源的旧版本（已被新版取代，且没有游戏还在用）
 * - 没游戏在用、也不是默认运行库的包
 * - 备份目录里已不被当前注入记录引用的旧备份
 * - downloads/ 下超过 1 小时的临时目录
 *
 * 游戏目录**一律不碰**（那里同名文件可能是游戏自带或别的 MOD 的，删了就是误伤）。
 */

const TEMP_MAX_AGE_MS = 60 * 60 * 1000

/** 同一个"来源"的分组键：下载的按仓库路径，导入的按包名 */
export function packageGroupKey(pkg: RuntimePackage): string {
  return pkg.remotePath !== undefined ? `remote:${pkg.remoteRepo ?? ''}:${pkg.remotePath}` : `local:${pkg.name}`
}

async function dirSize(path: string): Promise<number> {
  let total = 0
  const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = join(path, entry.name)
    if (entry.isDirectory()) total += await dirSize(full)
    else total += await stat(full).then((info) => info.size).catch(() => 0)
  }
  return total
}

export async function scanCleanup(): Promise<CleanupReport> {
  const [packages, games, settings] = await Promise.all([listPackages(), listGames(), settingsStore.read()])
  const referenced = new Set(games.map((game) => game.install?.packageId).filter((id): id is string => Boolean(id)))
  const items: CleanupItem[] = []

  // 1. packages/ 下没登记过的目录
  const knownIds = new Set(packages.map((pkg) => pkg.id))
  const packageDirs = await readdir(packagesDir(), { withFileTypes: true }).catch(() => [])
  for (const entry of packageDirs) {
    if (!entry.isDirectory() || knownIds.has(entry.name)) continue
    const path = join(packagesDir(), entry.name)
    items.push({
      kind: 'orphan',
      path,
      size: await dirSize(path),
      reason: '运行库目录没有对应的登记记录（多半是导入中断留下的）'
    })
  }

  // 2. 同一个来源的旧版本 + 没人用的包
  const groups = new Map<string, RuntimePackage[]>()
  for (const pkg of packages) {
    const key = packageGroupKey(pkg)
    groups.set(key, [...(groups.get(key) ?? []), pkg])
  }
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => b.importedAt.localeCompare(a.importedAt))
    const [newest, ...older] = sorted
    for (const pkg of older) {
      if (referenced.has(pkg.id)) continue
      items.push({
        kind: 'superseded',
        path: pkg.rootPath,
        size: pkg.proxies.reduce((sum, proxy) => sum + proxy.size, 0),
        reason: `已被同名/同来源的新版本取代（${newest.name}）`,
        packageId: pkg.id,
        label: pkg.name
      })
    }
    if (
      older.length === 0 &&
      !referenced.has(newest.id) &&
      settings.defaultPackageId !== newest.id &&
      packages.length > 1
    ) {
      items.push({
        kind: 'unused',
        path: newest.rootPath,
        size: newest.proxies.reduce((sum, proxy) => sum + proxy.size, 0),
        reason: '没有游戏在用，也不是默认运行库',
        packageId: newest.id,
        label: newest.name
      })
    }
  }

  // 3. 旧备份：只保留当前注入记录引用的那一份
  const keepBackups = Math.max(1, settings.keepBackups ?? 3)
  for (const game of games) {
    const referencedDirs = new Set<string>()
    if (game.install?.backupDir) referencedDirs.add(game.install.backupDir.toLowerCase())
    const root = join(backupsDir(), game.id)
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name)).sort().reverse()
    for (const [index, dir] of dirs.entries()) {
      const isCurrent = referencedDirs.has(dir.toLowerCase())
      if (isCurrent) continue
      // 保留最近 keepBackups 份，其余列出来
      if (index < keepBackups) continue
      items.push({
        kind: 'excess-backup',
        path: dir,
        size: await dirSize(dir),
        reason: `「${game.name}」的旧备份（当前注入记录没有引用它）`
      })
    }
  }

  // 4. downloads/ 里的过期临时目录
  const downloadEntries = await readdir(downloadsDir(), { withFileTypes: true }).catch(() => [])
  for (const entry of downloadEntries) {
    if (!entry.isDirectory()) continue
    const path = join(downloadsDir(), entry.name)
    const info = await stat(path).catch(() => null)
    if (!info || Date.now() - info.mtimeMs < TEMP_MAX_AGE_MS) continue
    items.push({ kind: 'temp', path, size: await dirSize(path), reason: '下载/解压的临时目录（超过 1 小时）' })
  }

  items.sort((a, b) => b.size - a.size)
  return {
    items,
    totalSize: items.reduce((sum, item) => sum + item.size, 0),
    dataDir: dataDir(),
    packagesDir: packagesDir(),
    backupsDir: backupsDir()
  }
}

export interface CleanupRunResult {
  removed: number
  freed: number
  freedText: string
  errors: string[]
}

/** 执行清理（只删 scanCleanup 列出的路径；有登记记录的包会同时删掉记录） */
export async function runCleanup(paths: string[]): Promise<CleanupRunResult> {
  const report = await scanCleanup()
  const allowed = new Map(report.items.map((item) => [item.path, item]))
  const result: CleanupRunResult = { removed: 0, freed: 0, freedText: '', errors: [] }
  for (const path of paths) {
    const item = allowed.get(path)
    if (!item) {
      result.errors.push(`跳过未在清单里的路径：${path}`)
      continue
    }
    try {
      if (item.packageId) { await deletePackageRecord(item.packageId); await removeIfExists(item.path) }
      else await removeIfExists(item.path)
      result.removed += 1
      result.freed += item.size
    } catch (error) {
      result.errors.push(`${path} → ${(error as Error).message}`)
    }
  }
  result.freedText = humanSize(result.freed)
  return result
}

/**
 * 更新/重新导入之后，把同来源的旧包删掉（有游戏还在用就保留）。
 * 这样“重新装一次”不会在 packages 里越堆越多。
 */
export async function removeSupersededPackages(current: RuntimePackage): Promise<string[]> {
  const settings = await settingsStore.read()
  if (settings.autoReplacePackages === false) return []
  const [packages, games] = await Promise.all([listPackages(), listGames()])
  const referenced = new Set(games.map((game) => game.install?.packageId).filter((id): id is string => Boolean(id)))
  const key = packageGroupKey(current)
  const removed: string[] = []
  for (const pkg of packages) {
    if (pkg.id === current.id) continue
    if (packageGroupKey(pkg) !== key) continue
    if (referenced.has(pkg.id)) continue
    if (!(await pathExists(pkg.rootPath))) {
      await deletePackageRecord(pkg.id).catch(() => undefined)
      continue
    }
    await deletePackageRecord(pkg.id)
    await removeIfExists(pkg.rootPath)
    removed.push(pkg.name)
  }
  return removed
}
