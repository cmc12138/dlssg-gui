import { resolve, sep, join } from 'node:path'
import { rename } from 'node:fs/promises'
import type { DuplicateReport, GameEntry, InstallRecord, MergeResult } from '@shared/types'
import { deleteGame, listGames, saveGame } from './db'
import { backupsDir } from './paths'
import { ensureDir, pathExists } from './fsutil'

/** 归一化路径用于比较：绝对路径、小写、去掉结尾分隔符 */
export function normalizedPath(input: string | undefined): string {
  if (!input) return ''
  return resolve(input)
    .replace(/[\\/]+$/, '')
    .toLowerCase()
}

/**
 * 两条记录是不是同一个游戏。
 * strict = true 只比完全相同的渲染目录 / 安装目录（用于「添加」时拦截重复）；
 * strict = false 额外认父子目录关系（用于找出已经存在的重复条目）。
 */
export function sameGame(a: GameEntry, b: GameEntry, strict = false): boolean {
  const pathsA = [normalizedPath(a.exeDir), normalizedPath(a.installDir)].filter(Boolean)
  const pathsB = [normalizedPath(b.exeDir), normalizedPath(b.installDir)].filter(Boolean)
  for (const pathA of pathsA) {
    for (const pathB of pathsB) {
      if (pathA === pathB) return true
      if (strict) continue
      // 父子目录关系（例如一条指向游戏根目录，另一条指向渲染 EXE 目录）
      if (pathA.startsWith(pathB + sep) || pathB.startsWith(pathA + sep)) return true
    }
  }
  return false
}

function groupBy(matches: (a: GameEntry, b: GameEntry) => boolean, games: GameEntry[]): GameEntry[][] {
  const groups: GameEntry[][] = []
  const used = new Set<string>()
  for (const game of games) {
    if (used.has(game.id)) continue
    const group = [game]
    for (const other of games) {
      if (other.id === game.id || used.has(other.id)) continue
      if (matches(game, other)) {
        group.push(other)
        used.add(other.id)
      }
    }
    if (group.length > 1) {
      used.add(game.id)
      groups.push(group)
    }
  }
  return groups
}

/** 严格重复分组：渲染目录或安装目录完全相同 */
export function findExactDuplicateGroups(games: GameEntry[]): GameEntry[][] {
  return groupBy((a, b) => sameGame(a, b, true), games)
}

/** 宽松重复分组：目录相同或互为父子 */
export function findDuplicateGroups(games: GameEntry[]): GameEntry[][] {
  return groupBy((a, b) => sameGame(a, b, false), games)
}

function pickKeeper(group: GameEntry[]): GameEntry {
  const withInstall = group.filter((game) => game.install)
  const pool = withInstall.length > 0 ? withInstall : group
  return [...pool].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
}

/** 把被合并条目的备份目录搬到保留条目下面，并改写记录里的路径 */
async function migrateBackups(fromId: string, toId: string, install: InstallRecord): Promise<InstallRecord> {
  if (fromId === toId) return install
  const fromRoot = join(backupsDir(), fromId)
  if (!(await pathExists(fromRoot))) return install
  await ensureDir(backupsDir())
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const toRoot = join(backupsDir(), toId, `merged-${stamp}`)
  try {
    await rename(fromRoot, toRoot)
  } catch {
    return install
  }
  const replace = (path: string | undefined): string | undefined =>
    path && path.toLowerCase().startsWith(fromRoot.toLowerCase()) ? toRoot + path.slice(fromRoot.length) : path
  return {
    ...install,
    backupDir: replace(install.backupDir) ?? install.backupDir,
    files: install.files.map((file) => ({ ...file, backupPath: replace(file.backupPath) }))
  }
}

function collectGroups(games: GameEntry[]): GameEntry[][] {
  const exact = findExactDuplicateGroups(games)
  const claimed = new Set(exact.flat().map((game) => game.id))
  const loose = findDuplicateGroups(games).filter((group) => group.some((game) => !claimed.has(game.id)))
  return [...exact, ...loose]
}

/** 列出重复分组，供界面提示（不修改任何数据） */
export async function listDuplicateGames(): Promise<DuplicateReport> {
  const groups = collectGroups(await listGames())
  return { groups, entries: groups.reduce((sum, group) => sum + group.length, 0) }
}

/**
 * 合并重复条目：每组保留一条（优先有注入记录的，其次最早创建的），
 * 合并历史、能力标记与注入记录（连备份目录一起搬过去），删掉其余条目。
 */
export async function mergeDuplicateGames(): Promise<MergeResult> {
  const groups = collectGroups(await listGames())
  const result: MergeResult = { mergedGroups: 0, removedEntries: 0, details: [] }

  for (const group of groups) {
    if (group.length < 2) continue
    const keeper = pickKeeper(group)
    const others = group.filter((game) => game.id !== keeper.id)
    const merged: GameEntry = { ...keeper }
    merged.dlssgCapable = group.some((game) => game.dlssgCapable)
    merged.candidates = group
      .flatMap((game) => game.candidates)
      .filter((candidate, index, list) => list.findIndex((item) => item.dir === candidate.dir) === index)
    merged.history = group
      .flatMap((game) => game.history)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 50)
    merged.notes = keeper.notes ?? group.find((game) => game.notes)?.notes

    // 注入记录：保留条目没有就收养别人的，并把备份目录搬过来
    if (!merged.install) {
      const donor = group.find((game) => game.id !== keeper.id && game.install)
      if (donor?.install) {
        merged.install = await migrateBackups(donor.id, keeper.id, donor.install)
        merged.exeDir = donor.exeDir
        merged.exeName = donor.exeName
        merged.config = donor.config
        merged.launchExe = merged.launchExe ?? donor.launchExe
      }
    }

    merged.history.unshift({
      at: new Date().toISOString(),
      action: 'repair',
      ok: true,
      message: `合并了 ${others.length} 条重复条目：${others.map((game) => game.name).join('、')}`
    })
    merged.updatedAt = new Date().toISOString()
    await saveGame(merged)
    for (const other of others) {
      // 备份目录已经搬到保留条目下，这里只删记录
      await deleteGame(other.id)
      result.removedEntries += 1
    }
    result.mergedGroups += 1
    result.details.push(
      `保留「${merged.name}」（${merged.exeDir}），移除 ${others.length} 条：${others.map((game) => game.name).join('、')}`
    )
  }
  return result
}
