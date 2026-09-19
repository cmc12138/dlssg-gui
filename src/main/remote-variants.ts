import type { RemoteVariant, UpstreamPackage } from '@shared/types'
import { RAW_BASE, REPO } from './repo'
import { checkUpstream } from './upstream'

/** 仓库里确实存在 alternatives/ 目录的代理名（winhttp.dll 只在归档版的 altnative 里）。 */
const ALT_PROXIES = ['winmm.dll', 'dbghelp.dll', 'dinput8.dll', 'dxgi.dll', 'd3d12.dll']

export interface RemoteVariantSeed {
  id: string
  name: string
  runtimeVersion: string
  maxMultiplier: number
  /** 仓库内目录前缀，'' = 根目录 */
  prefix: string
  /** 出厂 ini 所在目录前缀；310.1 目录里没有 ini，用仓库根目录那份 */
  iniPrefix?: string
  /** relPath / blobSha / size 给出时按仓库内真实路径下载并启用 API 兜底（动态发现上游时使用） */
  proxies: { name: string; relPath?: string; blobSha?: string; size?: number }[]
  /** 出厂 ini 的 git blob sha，用于 API 兜底与校验 */
  iniBlobSha?: string
  /** 出厂 ini 大小（下载进度用） */
  iniSize?: number
  remoteRepo?: string
  remotePath?: string
  projectVersion?: string
}

/**
 * 静态兜底变体：GitHub API 不可用时（限流 / 离线）仍然能下载已知的两个发布包。
 * 正常情况下走 checkUpstream() 动态发现。
 */
export const FALLBACK_VARIANTS: RemoteVariantSeed[] = [
  {
    id: 'main-3109',
    name: '310.9（主分支最新，最高 6X）',
    runtimeVersion: '310.9',
    maxMultiplier: 6,
    prefix: '',
    proxies: [{ name: 'version.dll' }, ...ALT_PROXIES.map((name) => ({ name }))]
  },
  {
    id: 'dir-3101',
    name: '310.1（旧版目录，最高 4X）',
    runtimeVersion: '310.1',
    maxMultiplier: 4,
    prefix: '310.1',
    iniPrefix: '',
    proxies: [{ name: 'version.dll' }, ...ALT_PROXIES.map((name) => ({ name }))]
  }
]

/** 兼容旧名字 */
export const REMOTE_VARIANTS = FALLBACK_VARIANTS

/** 把一个动态发现的上游发布包转成可下载的种子 */
export function seedFromUpstream(pkg: UpstreamPackage, projectVersion?: string): RemoteVariantSeed {
  const iniPrefix = pkg.iniPath && pkg.iniPath.includes('/') ? pkg.iniPath.slice(0, pkg.iniPath.lastIndexOf('/')) : ''
  return {
    id: `upstream-${pkg.path ? pkg.path.replace(/[^a-z0-9]+/gi, '-') : 'root'}-${pkg.versionBlobSha.slice(0, 8)}`,
    name: pkg.label,
    runtimeVersion: pkg.runtimeVersion,
    maxMultiplier: pkg.maxMultiplier,
    prefix: pkg.path,
    iniPrefix,
    proxies: pkg.proxies.map((proxy) => ({ name: proxy.name, relPath: proxy.path, blobSha: proxy.blobSha, size: proxy.size })),
    iniBlobSha: pkg.iniBlobSha,
    iniSize: pkg.iniSize,
    remoteRepo: REPO,
    remotePath: pkg.path,
    projectVersion
  }
}

const seedRegistry = new Map<string, RemoteVariantSeed>()
for (const seed of FALLBACK_VARIANTS) seedRegistry.set(seed.id, seed)

export function getSeed(id: string): RemoteVariantSeed | undefined {
  return seedRegistry.get(id)
}

function rank(path: string): number {
  if (path === '') return 0
  return path.startsWith('archive') ? 2 : 1
}

function toRemoteVariant(seed: RemoteVariantSeed, upstream: UpstreamPackage | undefined): RemoteVariant {
  const prefix = seed.prefix ? `${seed.prefix}/` : ''
  const proxies = seed.proxies.map((proxy) => {
    const rel = proxy.relPath ?? (proxy.name === 'version.dll' ? `${prefix}version.dll` : `${prefix}alternatives/${proxy.name}`)
    const discovered = upstream?.proxies.find((item) => item.path === rel)
    return { name: proxy.name, url: `${RAW_BASE}/${rel}`, size: discovered?.size ?? 0 }
  })
  const iniPrefix = seed.iniPrefix !== undefined ? seed.iniPrefix : seed.prefix
  const iniRel = `${iniPrefix ? `${iniPrefix}/` : ''}dlssg_sm86.ini`
  return {
    id: seed.id,
    name: seed.name,
    runtimeVersion: seed.runtimeVersion,
    maxMultiplier: seed.maxMultiplier,
    prefix: seed.prefix,
    repoPath: prefix || '/',
    proxies,
    iniUrl: `${RAW_BASE}/${iniRel}`,
    available: upstream ? true : undefined
  }
}

let cache: { at: number; variants: RemoteVariant[] } | null = null
const CACHE_MS = 5 * 60 * 1000

/**
 * 列出可以一键下载的运行库变体：优先动态发现上游所有发布包
 * （新增的版本目录会自动出现），发现失败时退回静态的两个已知路径。
 */
export async function listRemoteVariants(): Promise<RemoteVariant[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.variants

  const status = await checkUpstream()
  let variants: RemoteVariant[]
  for (const seed of FALLBACK_VARIANTS) seedRegistry.set(seed.id, seed)
  if (status.error || status.packages.length === 0) {
    variants = FALLBACK_VARIANTS.map((seed) => toRemoteVariant(seed, undefined))
  } else {
    const entries = status.packages
      .map((pkg) => ({ seed: seedFromUpstream(pkg, status.projectVersion), pkg }))
      .sort((a, b) => rank(a.pkg.path) - rank(b.pkg.path) || a.pkg.path.localeCompare(b.pkg.path))
    for (const entry of entries) seedRegistry.set(entry.seed.id, entry.seed)
    variants = entries.map(({ seed, pkg }) => toRemoteVariant(seed, pkg))
  }
  cache = { at: Date.now(), variants }
  return variants
}

export function invalidateRemoteCache(): void {
  cache = null
}
