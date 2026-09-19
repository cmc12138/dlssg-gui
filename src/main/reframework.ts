import { readdir, stat } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import type { GameEntry, RefReleaseInfo, RefStatus, ReframeworkRecord } from '@shared/types'
import { getGame, saveGame } from './db'
import { backupsDir, downloadsDir } from './paths'
import { atomicCopyFile, ensureDir, pathExists, removeIfExists } from './fsutil'
import { downloadSources, extractZip, type FetchSource, type ProgressCallback } from './library'

/** 卡普空 RE Engine 的特征文件：re_chunk_000.pak / re_dlc_xxx.pak（含 .sub_000.pak、.patch_00N.pak 变体） */
const RE_ENGINE_PAK = /^re_(chunk|dlc)_.*\.pak$/i

/** REFramework 官方仓库：nightly 是给新游戏用的通用包，稳定版按游戏分资产 */
const REF_NIGHTLY = 'praydog/REFramework-nightly'
const REF_STABLE = 'praydog/REFramework'

/**
 * 发布资产（release-assets.githubusercontent.com）在国内网络经常连不上，
 * 这两个反代实测可用；只在官方两条通道都失败后才走，并且单独限时，避免干等。
 */
const REF_ASSET_MIRRORS = ['https://gh-proxy.com/', 'https://ghfast.top/']
/** 官方两条通道快速失败（国内经常不通），镜像给足时间 */
const REF_ASSET_TIMEOUT_MS = 25000
const REF_MIRROR_TIMEOUT_MS = 60000

/** 稳定版里按游戏分的资产名（exe / 目录名关键字 → 资产名） */
const STABLE_ASSET_HINTS: { pattern: RegExp; asset: string }[] = [
  { pattern: /monsterhunterwilds|mhwilds|mhwilds/i, asset: 'MHWILDS.zip' },
  { pattern: /dragons?dogma|dd2/i, asset: 'DD2.zip' },
  { pattern: /devilmaycry5|dmc5/i, asset: 'DMC5.zip' },
  { pattern: /mhrise|monsterhunterrise/i, asset: 'MHRISE.zip' },
  { pattern: /streetfighter6|sf6/i, asset: 'SF6.zip' },
  { pattern: /re2|residentevil2|biohazard2/i, asset: 'RE2.zip' },
  { pattern: /re3|residentevil3|biohazard3/i, asset: 'RE3.zip' },
  { pattern: /re4|residentevil4|biohazard4/i, asset: 'RE4.zip' },
  { pattern: /re7|residentevil7|biohazard7/i, asset: 'RE7.zip' },
  { pattern: /re8|village|residentevil8|biohazard8/i, asset: 'RE8.zip' }
]

const HEADERS = { 'user-agent': 'DLSSG-GUI', accept: 'application/vnd.github+json' }

async function apiGet<T>(url: string): Promise<T> {
  let lastError: Error = new Error('请求失败')
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: HEADERS })
      if (response.status === 403 || response.status === 429) {
        throw new Error('GitHub API 速率限制（未登录每小时 60 次），过一会儿再试')
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return (await response.json()) as T
    } catch (error) {
      lastError = error as Error
      await new Promise((resolve) => setTimeout(resolve, 700 * attempt))
    }
  }
  throw lastError
}

interface GithubAsset {
  id: number
  name: string
  size: number
  browser_download_url: string
}
interface GithubRelease {
  tag_name: string
  published_at: string
  prerelease: boolean
  assets: GithubAsset[]
}

function toReleaseInfo(repo: string, release: GithubRelease, asset: GithubAsset): RefReleaseInfo {
  return {
    tag: release.tag_name,
    assetName: asset.name,
    size: asset.size,
    publishedAt: release.published_at,
    repo,
    url: `https://github.com/${repo}/releases/tag/${release.tag_name}`,
    assetId: asset.id
  }
}

/**
 * 找最新可用的 REFramework 包：
 * 先看 nightly 的通用包 REFramework.zip（新游戏只有这里有），
 * 拿不到再退到稳定版里跟这个游戏对得上的专用包。
 */
export async function fetchLatestRefRelease(game?: GameEntry): Promise<RefReleaseInfo> {
  const hint = `${game?.exeName ?? ''} ${basename(game?.installDir ?? '')} ${game?.name ?? ''}`
  try {
    const release = await apiGet<GithubRelease>(`https://api.github.com/repos/${REF_NIGHTLY}/releases/latest`)
    const asset = release.assets.find((item) => item.name.toLowerCase() === 'reframework.zip')
    if (asset) return toReleaseInfo(REF_NIGHTLY, release, asset)
  } catch {
    /* 落到稳定版 */
  }
  const stable = await apiGet<GithubRelease[]>(`https://api.github.com/repos/${REF_STABLE}/releases?per_page=5`)
  const matched = STABLE_ASSET_HINTS.find((item) => item.pattern.test(hint))
  for (const release of stable) {
    const candidates = matched
      ? release.assets.filter((asset) => asset.name.toLowerCase() === matched.asset.toLowerCase())
      : []
    const fallback = release.assets.find((asset) => /\.zip$/i.test(asset.name) && /^(re|dd2|mhwilds|mhrise|sf6|dmc5)/i.test(asset.name))
    const asset = candidates[0] ?? (matched ? undefined : fallback)
    if (asset) return toReleaseInfo(REF_STABLE, release, asset)
  }
  throw new Error('没找到可用的 REFramework 发布包')
}

/** 判定游戏目录是不是卡普空 RE Engine，以及目标目录里有没有 REFramework 的痕迹 */
export async function getRefStatus(gameId: string): Promise<RefStatus> {
  const game = await getGame(gameId)
  if (!game) throw new Error('没有找到该游戏条目')
  const installDir = game.installDir ?? game.exeDir
  const targetDir = installDir
  let entries: import('node:fs').Dirent[] = []
  try {
    entries = await readdir(installDir, { withFileTypes: true })
  } catch {
    return {
      reEngine: false,
      hasRefFiles: false,
      installed: Boolean(game.reframework),
      record: game.reframework,
      targetDir,
      targetExists: false,
      error: '游戏目录不存在'
    }
  }
  const names = entries.map((entry) => entry.name)
  const evidence = names.find((name) => RE_ENGINE_PAK.test(name))
  // dlc 子目录里的 re_dlc_*.pak 也算
  let dlcEvidence: string | undefined
  if (names.includes('dlc')) {
    const dlcFiles = await readdir(join(installDir, 'dlc')).catch(() => [] as string[])
    dlcEvidence = dlcFiles.find((name) => RE_ENGINE_PAK.test(name))
  }
  const hasRefFiles =
    names.some((name) => name.toLowerCase() === 'dinput8.dll') || names.some((name) => name.toLowerCase() === 'reframework')
  return {
    reEngine: Boolean(evidence ?? dlcEvidence),
    engineEvidence: evidence ?? dlcEvidence,
    hasRefFiles,
    installed: Boolean(game.reframework),
    record: game.reframework,
    targetDir,
    targetExists: true
  }
}

export interface RefInstallResult {
  ok: boolean
  message: string
  record?: ReframeworkRecord
}

/**
 * 把 REFramework 装进游戏根目录（卡普空 RE Engine 游戏不装它，代理 DLL 一加载就直接崩）。
 * zipPath 用于测试或本地包；不传则自己下载最新 nightly。
 */
export async function installReframework(
  gameId: string,
  options: { zipPath?: string; onProgress?: ProgressCallback } = {}
): Promise<RefInstallResult> {
  const game = await getGame(gameId)
  if (!game) return { ok: false, message: '没有找到该游戏条目' }
  const status = await getRefStatus(gameId)
  if (!status.targetExists) return { ok: false, message: '游戏目录不存在' }

  const targetDir = status.targetDir
  const stagingDir = join(downloadsDir(), `ref-${Date.now()}`)
  await ensureDir(stagingDir)

  try {
    let zipPath = options.zipPath
    let tag = '本地包'
    let assetName = options.zipPath ? basename(options.zipPath) : 'REFramework.zip'
    let source = options.zipPath ? '本地文件' : ''

    if (!zipPath) {
      const release = await fetchLatestRefRelease(game)
      tag = release.tag
      assetName = release.assetName
      source = `https://github.com/${release.repo}`
      const zipDest = join(stagingDir, release.assetName)
      // 优先进 GitHub API 的资产接口（Accept: application/octet-stream），github.com 不通时它通常还能用
      const sources: FetchSource[] = []
      if (release.assetId) {
        sources.push({
          kind: 'raw',
          url: `https://api.github.com/repos/${release.repo}/releases/assets/${release.assetId}`,
          headers: { accept: 'application/octet-stream' },
          timeoutMs: REF_ASSET_TIMEOUT_MS
        })
      }
      const direct = releaseAssetBrowserUrl(release.repo, release.tag, release.assetName)
      sources.push({ kind: 'raw', url: direct, timeoutMs: REF_ASSET_TIMEOUT_MS })
      for (const mirror of REF_ASSET_MIRRORS) {
        sources.push({ kind: 'raw', url: `${mirror}${direct}`, timeoutMs: REF_MIRROR_TIMEOUT_MS })
      }
      await downloadSources(
        sources,
        zipDest,
        `下载 ${release.assetName}（${(release.size / 1024 / 1024).toFixed(1)} MB）`,
        options.onProgress,
        0,
        2,
        release.size
      )
      zipPath = zipDest
    }

    const extractDir = join(stagingDir, 'unpacked')
    await extractZip(zipPath, extractDir)
    options.onProgress?.({ scope: 'import', done: 1, total: 2, label: '解压完成，开始写入游戏目录' })

    // 收集解压出来的文件（跳过 macOS 的 __MACOSX 之类）
    const files: string[] = []
    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > 4) return
      const list = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of list) {
        if (entry.name === '__MACOSX' || entry.name.startsWith('.')) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full, depth + 1)
        else if (entry.isFile()) files.push(full)
      }
    }
    await walk(extractDir, 0)
    if (files.length === 0) return { ok: false, message: '压缩包里没有文件，可能下载损坏了' }

    const backupDir = join(backupsDir(), game.id, `ref-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    await ensureDir(backupDir)
    const records: ReframeworkRecord['files'] = []
    const restoredFolders = new Set<string>()

    for (const file of files) {
      const rel = relative(extractDir, file)
      const target = join(targetDir, rel)
      const existed = await pathExists(target)
      let backupPath: string | undefined
      if (existed) {
        backupPath = join(backupDir, rel.split(sep).join('_'))
        await atomicCopyFile(target, backupPath)
      }
      await ensureDir(join(target, '..'))
      await atomicCopyFile(file, target)
      const info = await stat(target)
      records.push({ path: target, action: existed ? 'replaced' : 'created', backupPath, size: info.size })
      if (existed) restoredFolders.add(join(target, '..'))
    }

    const record: ReframeworkRecord = {
      installedAt: new Date().toISOString(),
      tag,
      assetName,
      source: source || '本地包',
      targetDir,
      backupDir,
      files: records
    }
    game.reframework = record
    game.history.unshift({
      at: record.installedAt,
      action: 'repair',
      ok: true,
      message: `安装 REFramework ${tag}（${records.length} 个文件）→ ${targetDir}`
    })
    game.history = game.history.slice(0, 50)
    await saveGame(game)
    options.onProgress?.({ scope: 'import', done: 2, total: 2, label: 'REFramework 安装完成' })
    return {
      ok: true,
      message: `REFramework ${tag} 已装到游戏目录（${records.length} 个文件）。接下来启动一次游戏让它加载，退出后再注入代理 DLL。`,
      record
    }
  } catch (error) {
    const detail = (error as Error).message
    const hint = /下载失败/.test(detail)
      ? '\n\n下载走的是 GitHub 的发布资产（release-assets.githubusercontent.com），这条在部分网络下会连不上。' +
        '可以在能上网的机器/浏览器里下载 REFramework.zip，回到这里点「用本地 ZIP 安装」。'
      : ''
    return { ok: false, message: `安装 REFramework 失败：${detail}${hint}` }
  } finally {
    await removeIfExists(stagingDir)
  }
}

function releaseAssetBrowserUrl(repo: string, tag: string, assetName: string): string {
  return `https://github.com/${repo}/releases/download/${tag}/${assetName}`
}

/** 卸载 REFramework：把覆盖过的文件还原、我们新建的文件删掉 */
export async function uninstallReframework(gameId: string): Promise<RefInstallResult> {
  const game = await getGame(gameId)
  if (!game) return { ok: false, message: '没有找到该游戏条目' }
  const record = game.reframework
  if (!record) return { ok: false, message: '没有本工具安装 REFramework 的记录（如果是手动装的，请手动删 dinput8.dll 和 reframework 文件夹）' }

  const messages: string[] = []
  // 先删文件，再清理可能空掉的 reframework 目录
  for (const file of [...record.files].reverse()) {
    try {
      if (file.action === 'created') {
        await removeIfExists(file.path)
        messages.push(`删除 ${file.path}`)
      } else if (file.backupPath && (await pathExists(file.backupPath))) {
        await atomicCopyFile(file.backupPath, file.path)
        messages.push(`还原 ${file.path}`)
      } else {
        await removeIfExists(file.path)
        messages.push(`删除 ${file.path}`)
      }
    } catch (error) {
      messages.push(`跳过 ${file.path}（${(error as Error).message}）`)
    }
  }
  // 清掉空的 reframework 目录（用户自己放的插件不会受影响，因为有文件就不会被删）
  const refDir = join(record.targetDir, 'reframework')
  await removeEmptyDirs(refDir)

  delete game.reframework
  game.history.unshift({
    at: new Date().toISOString(),
    action: 'restore',
    ok: true,
    message: `卸载 REFramework（${record.files.length} 个文件）`
  })
  game.history = game.history.slice(0, 50)
  await saveGame(game)
  return { ok: true, message: `已卸载 REFramework：\n${messages.slice(0, 20).join('\n')}${messages.length > 20 ? `\n…共 ${messages.length} 项` : ''}` }
}

/** 自底向上删空目录（有内容就保留） */
async function removeEmptyDirs(dir: string, depth = 0): Promise<void> {
  if (depth > 4) return
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirs(join(dir, entry.name), depth + 1)
  }
  const remaining = await readdir(dir).catch(() => null)
  if (remaining && remaining.length === 0) await removeIfExists(dir)
}
