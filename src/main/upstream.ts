import { createHash } from 'node:crypto'
import type { UpstreamPackage, UpstreamRelease, UpstreamStatus } from '@shared/types'
import { KNOWN_PROXIES } from '@shared/types'
import { listPackages } from './db'
import { REPO, REPO_URL } from './repo'

const API = `https://api.github.com/repos/${REPO}`
const HEADERS = { 'user-agent': 'DLSSG-GUI', accept: 'application/vnd.github+json' }
const ALTERNATIVE_DIRS = new Set(['alternatives', 'altnative'])

/** git 的 blob 哈希（sha1 of "blob <len>\0" + 内容），用来跟远端树比对文件是否变过 */
export function gitBlobSha(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
}

export class UpstreamApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function apiGet<T>(path: string): Promise<T> {
  let lastError: Error = new Error('未知错误')
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${API}${path}`, { headers: HEADERS })
      if (response.status === 403 || response.status === 429) {
        throw new UpstreamApiError(
          'GitHub API 触发了速率限制（未登录状态下每小时 60 次请求）。过一会儿再试，或者直接去仓库下载 ZIP 再「导入 ZIP」。',
          response.status
        )
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return (await response.json()) as T
    } catch (error) {
      if (error instanceof UpstreamApiError) throw error
      lastError = error as Error
      await new Promise((resolve) => setTimeout(resolve, 700 * attempt))
    }
  }
  throw lastError
}

interface TreeBlob {
  path: string
  type: 'blob' | 'tree' | 'commit'
  size?: number
  sha: string
}

interface RepoInfo {
  default_branch: string
  pushed_at: string
  stargazers_count: number
}

const knownProxyNames = new Set(KNOWN_PROXIES.map((name) => name.toLowerCase()))

function splitPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf('/')
  return index < 0 ? { dir: '', name: path } : { dir: path.slice(0, index), name: path.slice(index + 1) }
}

function inferMeta(dir: string, projectVersion: string | undefined): Pick<UpstreamPackage, 'label' | 'runtimeVersion' | 'maxMultiplier' | 'notes'> {
  const dirName = dir ? dir.split('/').pop()! : ''
  if (!dir) {
    return {
      label: `DLSSG for SM86 主分支${projectVersion ? `（项目 ${projectVersion}）` : ''}`,
      runtimeVersion: '310.9',
      maxMultiplier: 6,
      notes: '仓库根目录发布包：内嵌 310.9 运行库，支持 6X。上游 0.3.1 起出厂 MaxGeneratedFrames 是 3（4X）'
    }
  }
  if (/^310\.\d/.test(dirName)) {
    return {
      label: `DLSSG for SM86 ${dirName}${projectVersion ? `（项目 ${projectVersion}）` : ''}`,
      runtimeVersion: dirName,
      maxMultiplier: 4,
      notes: '旧版运行库：最高 4X，没有有损图像内核（Optimized 档位 2/3 等同 1）'
    }
  }
  if (dir.startsWith('archive')) {
    return {
      label: `DLSSG for SM86 ${dirName}（归档）`,
      runtimeVersion: dirName,
      maxMultiplier: 4,
      notes: '历史归档版本，仅供对照；老版本界面与配置语义可能不同'
    }
  }
  return { label: `DLSSG for SM86 ${dirName}`, runtimeVersion: dirName, maxMultiplier: 4 }
}

/** 从仓库树里找出所有「含 version.dll 的目录」，即一个可用的发布包 */
export function packagesFromTree(tree: TreeBlob[], projectVersion: string | undefined): UpstreamPackage[] {
  const blobs = tree.filter((node) => node.type === 'blob')
  const roots = new Set<string>()
  for (const blob of blobs) {
    const { dir, name } = splitPath(blob.path)
    if (!knownProxyNames.has(name.toLowerCase())) continue
    const dirName = dir ? dir.split('/').pop()!.toLowerCase() : ''
    if (ALTERNATIVE_DIRS.has(dirName)) continue
    roots.add(dir)
  }

  const packages: UpstreamPackage[] = []
  for (const root of [...roots].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))) {
    const prefix = root ? `${root}/` : ''
    const proxies: UpstreamPackage['proxies'] = []
    for (const blob of blobs) {
      const { dir, name } = splitPath(blob.path)
      if (!knownProxyNames.has(name.toLowerCase())) continue
      const isRootLevel = dir === root
      const dirName = dir ? dir.split('/').pop()!.toLowerCase() : ''
      const isAlternative = ALTERNATIVE_DIRS.has(dirName) && dir === (root ? `${root}/${dirName}` : dirName)
      if (!isRootLevel && !isAlternative) continue
      proxies.push({ name, path: blob.path, size: blob.size ?? 0, blobSha: blob.sha })
    }
    if (proxies.length === 0) continue
    proxies.sort((a, b) => (a.name === 'version.dll' ? -1 : b.name === 'version.dll' ? 1 : a.name.localeCompare(b.name)))

    const versionEntry = proxies.find((proxy) => proxy.name.toLowerCase() === 'version.dll') ?? proxies[0]
    const iniInDir = blobs.find((blob) => blob.path === `${prefix}dlssg_sm86.ini`)
    const iniFallback = blobs.find((blob) => blob.path === 'dlssg_sm86.ini')
    const ini = iniInDir ?? iniFallback
    const meta = inferMeta(root, projectVersion)
    packages.push({
      path: root,
      ...meta,
      versionBlobSha: versionEntry.blobSha,
      versionSize: versionEntry.size,
      proxies,
      iniPath: ini?.path,
      iniSize: ini?.size,
      iniBlobSha: ini?.sha,
      updateAvailable: false
    })
  }
  return packages
}

export interface CheckOptions {
  /** 忽略 5 分钟缓存 */
  force?: boolean
}

let cache: { at: number; status: UpstreamStatus } | null = null
const CACHE_MS = 5 * 60 * 1000

export function invalidateUpstreamCache(): void {
  cache = null
}

/**
 * 检查上游仓库：拉默认分支、最近提交、发行版与整棵树，
 * 自动发现所有发布包，并与本地已导入的运行库比对是否更新。
 */
export async function checkUpstream(options: CheckOptions = {}): Promise<UpstreamStatus> {
  if (!options.force && cache && Date.now() - cache.at < CACHE_MS) return cache.status

  const base: UpstreamStatus = {
    repo: REPO,
    repoUrl: REPO_URL,
    branch: 'main',
    checkedAt: new Date().toISOString(),
    latestCommit: { sha: '', date: '', message: '' },
    releases: [],
    packages: [],
    managedPackages: 0
  }

  try {
    const repo = await apiGet<RepoInfo>('')
    base.branch = repo.default_branch || 'main'
    const [commits, releases, tree] = await Promise.all([
      apiGet<{ sha: string; commit: { author: { date: string }; message: string } }[]>(`/commits?per_page=1&sha=${base.branch}`),
      apiGet<{ tag_name: string; name: string; published_at: string; assets?: unknown[] }[]>('/releases?per_page=10'),
      apiGet<{ tree: TreeBlob[]; truncated?: boolean }>(`/git/trees/${base.branch}?recursive=1`)
    ])

    const commit = commits[0]
    if (commit) {
      base.latestCommit = {
        sha: commit.sha,
        date: commit.commit.author.date,
        message: (commit.commit.message || '').split('\n')[0].slice(0, 200)
      }
    }
    base.releases = releases.map<UpstreamRelease>((item) => ({
      tag: item.tag_name,
      name: item.name || item.tag_name,
      publishedAt: item.published_at,
      assetCount: item.assets?.length ?? 0
    }))
    base.projectVersion = base.releases[0]?.tag ?? undefined

    const packages = packagesFromTree(tree.tree ?? [], base.projectVersion)
    const local = await listPackages()
    base.managedPackages = local.filter((pkg) => pkg.remoteRepo === REPO).length

    for (const item of packages) {
      const prefix = item.path ? `${item.path}/` : ''
      const localPkg = local.find((pkg) => pkg.remoteRepo === REPO && (pkg.remotePath ?? '') === item.path)
      if (!localPkg) continue
      item.localPackageId = localPkg.id
      item.localPackageName = localPkg.name
      const knownBlob = localPkg.remoteBlobs?.[`${prefix}version.dll`]
      if (knownBlob) item.updateAvailable = knownBlob !== item.versionBlobSha
      else item.updateAvailable = false
    }

    base.packages = packages
    cache = { at: Date.now(), status: base }
    return base
  } catch (error) {
    return { ...base, error: (error as Error).message }
  }
}
