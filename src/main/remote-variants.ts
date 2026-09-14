import type { RemoteVariant } from '@shared/types'
import { RAW_BASE } from './repo'

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
  proxies: { name: string }[]
}

export const REMOTE_VARIANTS: RemoteVariantSeed[] = [
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

let cache: { at: number; variants: RemoteVariant[] } | null = null

async function headSize(url: string): Promise<{ size: number; ok: boolean }> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12000)
    const response = await fetch(url, { method: 'HEAD', signal: controller.signal })
    clearTimeout(timer)
    const size = Number(response.headers.get('content-length') ?? 0)
    return { size: Number.isFinite(size) ? size : 0, ok: response.ok }
  } catch {
    return { size: 0, ok: false }
  }
}

/**
 * 列出可以一键下载的运行库变体。默认只做轻量的 HEAD 探测，
 * 结果缓存 10 分钟，避免每次打开界面都打网络。
 */
export async function listRemoteVariants(probe = true): Promise<RemoteVariant[]> {
  if (cache && Date.now() - cache.at < 10 * 60 * 1000) return cache.variants
  const variants: RemoteVariant[] = []
  for (const seed of REMOTE_VARIANTS) {
    const prefix = seed.prefix ? `${seed.prefix}/` : ''
    const iniPrefix = (seed.iniPrefix ?? seed.prefix) ? `${seed.iniPrefix ?? seed.prefix}/` : ''
    const proxies = seed.proxies.map((proxy) => ({
      name: proxy.name,
      url: proxy.name === 'version.dll' ? `${RAW_BASE}/${prefix}version.dll` : `${RAW_BASE}/${prefix}alternatives/${proxy.name}`,
      size: 0
    }))
    const iniUrl = `${RAW_BASE}/${iniPrefix}dlssg_sm86.ini`
    const variant: RemoteVariant = {
      id: seed.id,
      name: seed.name,
      runtimeVersion: seed.runtimeVersion,
      maxMultiplier: seed.maxMultiplier,
      prefix: seed.prefix,
      repoPath: prefix || '/',
      proxies,
      iniUrl
    }
    if (probe) {
      const checks = await Promise.all([
        headSize(proxies[0].url),
        ...proxies.slice(1).map((proxy) => headSize(proxy.url)),
        headSize(iniUrl)
      ])
      proxies.forEach((proxy, index) => {
        proxy.size = checks[index]?.size ?? 0
      })
      variant.available = (checks[0]?.ok ?? false) && (checks[checks.length - 1]?.ok ?? false)
      if (!variant.available) variant.error = '主 DLL 或配置模板不可访问（网络/代理问题）'
    }
    variants.push(variant)
  }
  cache = { at: Date.now(), variants }
  return variants
}

export function invalidateRemoteCache(): void {
  cache = null
}
