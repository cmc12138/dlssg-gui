import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import AdmZip from 'adm-zip'
import type { ImportResult, PackageSource, RuntimePackage, ProxyFile, VerifyResult } from '@shared/types'
import { KNOWN_PROXIES } from '@shared/types'
import { deletePackageRecord, getPackage, listPackages, savePackage } from './db'
import { downloadsDir, ensureDataDirs, packagesDir } from './paths'
import { GITHUB_API, MIRROR_BASE, RAW_BASE, REPO } from './repo'
import { atomicCopyFile, atomicWriteFile, ensureDir, humanSize, isPortableExecutable, pathExists, sha256File } from './fsutil'
import { gitBlobSha } from './upstream'

const ALTERNATIVE_DIR_NAMES = new Set(['alternatives', 'altnative'])

export interface ProgressCallback {
  (event: { scope: 'import' | 'download'; done: number; total: number; label: string }): void
}

import type { RemoteVariantSeed } from './remote-variants'

export interface PackageDetection {
  relRoot: string
  name: string
  runtimeVersion: string
  maxMultiplier: number
  absRoot: string
  proxies: { name: string; absPath: string; relPath: string }[]
  iniPath?: string
  readmePath?: string
}

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/** 从注释 / README 里挑运行库版本号（312.1 这类未来版本也能认出来） */
function parseVersionFromText(text: string): string | undefined {
  const match = /(\d{3}\.\d+(?:\.\d+)?)/.exec(text)
  return match?.[1]
}

async function readSnippet(path: string | undefined, bytes = 4096): Promise<string> {
  if (!path) return ''
  try {
    const buf = await readFile(path)
    return buf.subarray(0, bytes).toString('utf8')
  } catch {
    return ''
  }
}

function metaForRelRoot(relRoot: string, evidence: string): { name: string; runtimeVersion: string; maxMultiplier: number } {
  const found = parseVersionFromText(evidence)
  const mentions6x = /6X|Dynamic MFG|MaxGeneratedFrames\s*=\s*5/i.test(evidence)
  if (relRoot === '') {
    return {
      name: `DLSSG for SM86 ${found ?? '主分支'}（主分支）`,
      runtimeVersion: found ?? '310.9',
      maxMultiplier: 6
    }
  }
  const versionDir = basename(relRoot)
  if (/^\d{3}\.\d/.test(versionDir)) {
    return { name: `DLSSG for SM86 ${versionDir}`, runtimeVersion: versionDir, maxMultiplier: 4 }
  }
  if (relRoot.startsWith('archive')) {
    const parts = relRoot.split(/[\\/]/)
    const ver = parts[parts.length - 1]
    return { name: `DLSSG for SM86 ${ver}（归档 / native）`, runtimeVersion: ver, maxMultiplier: 4 }
  }
  return { name: `DLSSG for SM86 ${versionDir}`, runtimeVersion: versionDir, maxMultiplier: mentions6x ? 6 : 4 }
}

/** 在一个解包/目录树里找出所有"发布包"根目录，并推断元信息。 */
export async function detectPackages(root: string): Promise<PackageDetection[]> {
  const found: PackageDetection[] = []
  const knownLower = new Set(KNOWN_PROXIES.map((p) => p.toLowerCase()))

  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > 3) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const dirName = basename(dir).toLowerCase()
    const files = entries.filter((e) => e.isFile()).map((e) => e.name)
    const isAlternativeDir = ALTERNATIVE_DIR_NAMES.has(dirName)

    if (!isAlternativeDir) {
      const rootProxies = files.filter((f) => knownLower.has(f.toLowerCase()))
      if (rootProxies.length > 0) {
        const relRoot = relative(root, dir).split(sep).join('/')
        const iniPath = files.find((f) => f.toLowerCase() === 'dlssg_sm86.ini')
        const readmePath = files.find((f) => f.toLowerCase() === 'readme.md') ?? files.find((f) => f.toLowerCase() === 'readme.en.md')
        const proxies: PackageDetection['proxies'] = rootProxies.map((name) => ({
          name,
          absPath: join(dir, name),
          relPath: name
        }))
        const altDir = entries.find(
          (e) => e.isDirectory() && ALTERNATIVE_DIR_NAMES.has(e.name.toLowerCase())
        )
        if (altDir) {
          try {
            const altFiles = await readdir(join(dir, altDir.name), { withFileTypes: true })
            for (const altFile of altFiles) {
              if (!altFile.isFile()) continue
              if (!knownLower.has(altFile.name.toLowerCase())) continue
              proxies.push({
                name: altFile.name,
                absPath: join(dir, altDir.name, altFile.name),
                relPath: `${altDir.name}/${altFile.name}`
              })
            }
          } catch {
            /* 忽略 */
          }
        }
        const evidence = [
          await readSnippet(iniPath ? join(dir, iniPath) : undefined, 2048),
          await readSnippet(readmePath ? join(dir, readmePath) : undefined, 4096)
        ].join('\n')
        const meta = metaForRelRoot(relRoot, evidence)
        found.push({
          relRoot,
          name: meta.name,
          runtimeVersion: meta.runtimeVersion,
          maxMultiplier: meta.maxMultiplier,
          absRoot: dir,
          proxies,
          iniPath: iniPath ? join(dir, iniPath) : undefined,
          readmePath: readmePath ? join(dir, readmePath) : undefined
        })
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      await visit(join(dir, entry.name), depth + 1)
    }
  }

  await visit(root, 0)
  return found
}

async function importDetection(detection: PackageDetection, source: PackageSource, sourceDetail: string, onProgress?: ProgressCallback): Promise<RuntimePackage> {
  const versionDll = detection.proxies.find((p) => p.name.toLowerCase() === 'version.dll')
  const mainProxy = versionDll ?? detection.proxies[0]
  const mainHash = await sha256File(mainProxy.absPath)
  const id = `${slug(detection.name)}-${mainHash.slice(0, 8)}`
  const targetRoot = join(packagesDir(), id)

  const total = detection.proxies.length + 1
  let done = 0
  const proxies: ProxyFile[] = []
  for (const proxy of detection.proxies) {
    const dest = join(targetRoot, proxy.relPath.split('/').join(sep))
    await atomicCopyFile(proxy.absPath, dest)
    proxies.push({
      name: proxy.name,
      relPath: proxy.relPath,
      size: (await stat(dest)).size,
      sha256: await sha256File(dest)
    })
    done += 1
    onProgress?.({ scope: 'import', done, total, label: `复制 ${proxy.name}（${humanSize(proxies[proxies.length - 1].size)}）` })
  }

  let iniTemplatePath: string | undefined
  if (detection.iniPath) {
    iniTemplatePath = join(targetRoot, 'dlssg_sm86.ini')
    await atomicCopyFile(detection.iniPath, iniTemplatePath)
  }
  if (detection.readmePath) {
    await atomicCopyFile(detection.readmePath, join(targetRoot, basename(detection.readmePath)))
  }
  done += 1
  onProgress?.({ scope: 'import', done, total, label: '写入配置模板' })

  const pkg: RuntimePackage = {
    id,
    name: detection.name,
    runtimeVersion: detection.runtimeVersion,
    maxMultiplier: detection.maxMultiplier,
    source,
    sourceDetail,
    importedAt: new Date().toISOString(),
    rootPath: targetRoot,
    proxies,
    iniTemplatePath,
    notes: detection.relRoot ? `仓库路径：${detection.relRoot}` : '仓库根目录发布包'
  }
  await atomicWriteFile(join(targetRoot, 'dlssg-gui-package.json'), JSON.stringify(pkg, null, 2))
  await savePackage(pkg)
  return pkg
}

/** 从已解包的发布目录导入（支持一个目录里包含多个版本）。 */
export async function importFromFolder(folder: string, onProgress?: ProgressCallback, source: PackageSource = 'folder'): Promise<ImportResult> {
  ensureDataDirs()
  const folderStat = await stat(folder).catch(() => null)
  if (!folderStat?.isDirectory()) throw new Error(`目录不存在：${folder}`)
  const detections = await detectPackages(folder)
  const warnings: string[] = []
  if (detections.length === 0) {
    throw new Error('没有在所选目录里找到发布包（需要包含 version.dll 或其它代理 DLL）')
  }
  const packages: RuntimePackage[] = []
  for (const detection of detections) {
    const mainProxy = detection.proxies[0]
    if (!(await isPortableExecutable(mainProxy.absPath))) {
      warnings.push(`${detection.name}：${mainProxy.name} 不是有效的 PE 文件，已跳过`)
      continue
    }
    packages.push(await importDetection(detection, source, folder, onProgress))
  }
  return { packages, warnings }
}

async function runCommand(command: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { windowsHide: true })
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => resolvePromise({ code: -1, stderr: String(error) }))
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stderr }))
  })
}

/** 解压 ZIP：优先系统自带 tar，其次 PowerShell，最后纯 JS 的 adm-zip。 */
export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  await ensureDir(destDir)
  const tar = await runCommand('tar.exe', ['-xf', zipPath, '-C', destDir])
  if (tar.code === 0) return
  const ps = await runCommand('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
  ])
  if (ps.code === 0) return
  try {
    const zip = new AdmZip(zipPath)
    const entries = zip.getEntries()
    const destResolved = resolve(destDir)
    for (const entry of entries) {
      const target = resolve(destDir, entry.entryName)
      if (!target.startsWith(destResolved)) continue
      if (entry.isDirectory) {
        await ensureDir(target)
        continue
      }
      await ensureDir(join(target, '..'))
      await atomicWriteFile(target, entry.getData())
    }
  } catch (error) {
    throw new Error(`解压失败：tar(${tar.stderr.trim()}) / powershell(${ps.stderr.trim()}) / adm-zip(${String(error)})`)
  }
}

/** 从 ZIP（例如 GitHub 的 Download ZIP）导入，一个包里可能含多个版本。 */
export async function importFromZip(zipPath: string, onProgress?: ProgressCallback): Promise<ImportResult> {
  ensureDataDirs()
  if (!(await pathExists(zipPath))) throw new Error(`文件不存在：${zipPath}`)
  const tempDir = join(downloadsDir(), `unzip-${createHash('sha1').update(zipPath).digest('hex').slice(0, 8)}-${Date.now()}`)
  try {
    onProgress?.({ scope: 'import', done: 0, total: 1, label: '解压压缩包…' })
    await extractZip(zipPath, tempDir)
    return await importFromFolder(tempDir, onProgress, 'zip')
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export interface DownloadOptions {
  onProgress?: ProgressCallback
  preferMirror?: boolean
  /**
   * 是否连 alternatives 里的其它代理名一起下载。默认 false：
   * 只下 version.dll（30MB 级），全部代理要 180MB，慢线路上代价很大。
   */
  includeAlternatives?: boolean
}

/**
 * 一个文件的下载来源。raw 走 raw.githubusercontent.com / 镜像直链；
 * api-blob 走 GitHub 的 git/blobs 接口（大文件在劣质线路上经常被中途掐断，这条兜底更稳）。
 */
export type FetchSource =
  | { kind: 'raw'; url: string }
  | { kind: 'api-blob'; sha: string; path: string }

async function fetchApiBlob(sha: string, dest: string, errors: string[], attempt: number): Promise<boolean> {
  const response = await fetch(`${GITHUB_API}/git/blobs/${sha}`, {
    headers: { 'user-agent': 'DLSSG-GUI', accept: 'application/vnd.github+json' }
  })
  if (!response.ok) {
    errors.push(`git/blobs ${sha.slice(0, 8)}（第 ${attempt} 次）→ HTTP ${response.status}`)
    return false
  }
  const payload = (await response.json()) as { content?: string; encoding?: string }
  if (!payload.content) {
    errors.push(`git/blobs ${sha.slice(0, 8)}（第 ${attempt} 次）→ 响应里没有内容`)
    return false
  }
  const buffer = Buffer.from(payload.content, payload.encoding === 'base64' ? 'base64' : 'utf8')
  if (gitBlobSha(buffer) !== sha) {
    errors.push(`git/blobs ${sha.slice(0, 8)}（第 ${attempt} 次）→ 校验和不匹配`)
    return false
  }
  await atomicWriteFile(dest, buffer)
  return true
}

async function fetchToFile(sources: FetchSource[], dest: string, label: string, onProgress?: ProgressCallback, done = 0, total = 1): Promise<void> {
  const errors: string[] = []
  for (const source of sources) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const described = source.kind === 'raw' ? source.url : `api-blob ${source.path}`
      try {
        if (source.kind === 'api-blob') {
          if (await fetchApiBlob(source.sha, dest, errors, attempt)) {
            onProgress?.({ scope: 'download', done, total, label })
            return
          }
        } else {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 180000)
          try {
            const response = await fetch(source.url, {
              redirect: 'follow',
              signal: controller.signal,
              headers: { 'user-agent': 'DLSSG-GUI' }
            })
            if (!response.ok || !response.body) {
              errors.push(`${described} → HTTP ${response.status}`)
              break
            }
            const { Readable } = await import('node:stream')
            const { createWriteStream } = await import('node:fs')
            const { pipeline } = await import('node:stream/promises')
            const stream = Readable.fromWeb(response.body as never)
            await pipeline(stream, createWriteStream(dest))
          } finally {
            clearTimeout(timer)
          }
          onProgress?.({ scope: 'download', done, total, label })
          return
        }
      } catch (error) {
        errors.push(`${described}（第 ${attempt} 次）→ ${String(error)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
    }
  }
  throw new Error(`下载失败：${label}\n${errors.join('\n')}`)
}

/**
 * 从 GitHub 下载指定变体。变体可以来自动态发现（relPath 是仓库内真实路径），
 * 也可以来自静态兜底（按 prefix + 约定文件名拼路径）。
 */
export async function downloadVariant(variant: RemoteVariantSeed, options: DownloadOptions = {}): Promise<RuntimePackage> {
  ensureDataDirs()
  const prefix = variant.prefix ? `${variant.prefix}/` : ''
  const iniPrefixValue = variant.iniPrefix !== undefined ? variant.iniPrefix : variant.prefix
  const iniPrefix = iniPrefixValue ? `${iniPrefixValue}/` : ''
  const tempDir = join(downloadsDir(), `variant-${variant.id}-${Date.now()}`)
  await ensureDir(tempDir)

  // 默认只下主代理：上游说一个代理就够用，其余只是"游戏不加载 version.dll"时的备选，
  // 没必要在慢线路上多拖 150MB。
  const wantedProxies =
    options.includeAlternatives === true
      ? variant.proxies
      : variant.proxies.filter((proxy) => proxy.name.toLowerCase() === 'version.dll').slice(0, 1)
  const selectedProxies = wantedProxies.length > 0 ? wantedProxies : variant.proxies.slice(0, 1)

  const total = selectedProxies.length + 1
  let done = 0

  const remote = selectedProxies.map((proxy) => ({
    name: proxy.name,
    rel: proxy.relPath ?? (proxy.name === 'version.dll' ? `${prefix}version.dll` : `${prefix}alternatives/${proxy.name}`),
    blobSha: proxy.blobSha
  }))

  const sourcesFor = (rel: string, blobSha: string | undefined): FetchSource[] => {
    const raw: FetchSource = { kind: 'raw', url: `${RAW_BASE}/${rel}` }
    const mirror: FetchSource = { kind: 'raw', url: `${MIRROR_BASE}/${rel}` }
    // 顺序很讲究：直链最快但在这类线路上容易被中途掐断，所以只给它两次机会，
    // 立刻转用 GitHub API 的 blob 接口（唯一一条顺带校验哈希的可靠通道），镜像放最后。
    const sources: FetchSource[] = options.preferMirror ? [mirror, raw] : [raw, mirror]
    if (blobSha) sources.splice(sources.length - 1, 0, { kind: 'api-blob', sha: blobSha, path: rel })
    return sources
  }

  try {
    for (const item of remote) {
      const dest = item.name === 'version.dll' ? join(tempDir, 'version.dll') : join(tempDir, 'alternatives', item.name)
      await ensureDir(item.name === 'version.dll' ? tempDir : join(tempDir, 'alternatives'))
      await fetchToFile(sourcesFor(item.rel, item.blobSha), dest, `下载 ${item.name}`, options.onProgress, done, total)
      done += 1
    }
    const iniRel = `${iniPrefix}dlssg_sm86.ini`
    await fetchToFile(
      sourcesFor(iniRel, variant.iniBlobSha),
      join(tempDir, 'dlssg_sm86.ini'),
      '下载配置模板',
      options.onProgress,
      done,
      total
    )

    // 记录仓库内每个文件的 git blob sha，之后「检查上游更新」直接比对即可
    const remoteBlobs: Record<string, string> = {}
    for (const item of remote) {
      const file = item.name === 'version.dll' ? join(tempDir, 'version.dll') : join(tempDir, 'alternatives', item.name)
      remoteBlobs[item.rel] = gitBlobSha(await readFile(file))
    }
    remoteBlobs[iniRel] = gitBlobSha(await readFile(join(tempDir, 'dlssg_sm86.ini')))

    const result = await importFromFolder(tempDir, options.onProgress, 'github')
    const pkg = result.packages[0]
    if (!pkg) throw new Error('下载完成但没有识别出发布包')
    pkg.source = 'github'
    pkg.sourceDetail = `https://github.com/${REPO}（${prefix || '根目录'}）`
    pkg.name = variant.name
    pkg.runtimeVersion = variant.runtimeVersion
    pkg.maxMultiplier = variant.maxMultiplier
    pkg.remoteRepo = variant.remoteRepo ?? REPO
    pkg.remotePath = variant.remotePath ?? variant.prefix
    pkg.remoteBlobs = remoteBlobs
    pkg.projectVersion = variant.projectVersion
    await savePackage(pkg)
    return pkg
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * 导入单个自定义 DLL 作为运行库：用户直接指定文件来源，注入时使用目标代理名。
 * 注意：这等于信任用户提供的 DLL，界面里要给出明确提示。
 */
export async function importSingleDll(dllPath: string, targetName = 'version.dll'): Promise<ImportResult> {
  ensureDataDirs()
  if (!(await pathExists(dllPath))) throw new Error(`文件不存在：${dllPath}`)
  if (!(await isPortableExecutable(dllPath))) throw new Error('所选文件不是有效的 PE/DLL 文件')
  const hash = await sha256File(dllPath)
  const id = `custom-${slug(targetName.replace(/\.dll$/i, ''))}-${hash.slice(0, 8)}`
  const targetRoot = join(packagesDir(), id)
  await ensureDir(targetRoot)
  const fileName = basename(dllPath)
  const dest = join(targetRoot, fileName)
  await atomicCopyFile(dllPath, dest)
  const pkg: RuntimePackage = {
    id,
    name: `自定义 DLL：${fileName} → ${targetName}`,
    runtimeVersion: '自定义',
    maxMultiplier: 6,
    source: 'folder',
    sourceDetail: dllPath,
    importedAt: new Date().toISOString(),
    rootPath: targetRoot,
    proxies: [{ name: targetName, relPath: fileName, size: (await stat(dest)).size, sha256: hash }],
    notes: '用户手动指定的 DLL，倍率上限未知（按 6X 处理）。请自行确认来源可信。'
  }
  await atomicWriteFile(join(targetRoot, 'dlssg-gui-package.json'), JSON.stringify(pkg, null, 2))
  await savePackage(pkg)
  return { packages: [pkg], warnings: ['自定义 DLL：请确认来源可信，注入后如果帧生成不生效请还原'] }
}

export async function verifyPackage(id: string, onProgress?: ProgressCallback): Promise<VerifyResult[]> {
  const pkg = await getPackage(id)
  if (!pkg) throw new Error('运行库不存在')
  const results: VerifyResult[] = []
  let done = 0
  for (const proxy of pkg.proxies) {
    const path = join(pkg.rootPath, proxy.relPath.split('/').join(sep))
    const exists = await pathExists(path)
    const actual = exists ? await sha256File(path) : ''
    results.push({
      name: proxy.relPath,
      ok: exists && actual === proxy.sha256,
      expected: proxy.sha256,
      actual,
      size: proxy.size
    })
    done += 1
    onProgress?.({ scope: 'import', done, total: pkg.proxies.length, label: `校验 ${proxy.name}` })
  }
  return results
}

export async function deletePackage(id: string, deleteFiles = true): Promise<void> {
  const pkg = await getPackage(id)
  if (!pkg) return
  await deletePackageRecord(id)
  if (deleteFiles) await rm(pkg.rootPath, { recursive: true, force: true }).catch(() => undefined)
}

/** 应用启动时把 packages.json 与实际目录对齐（目录被手工删掉时清理记录）。 */
export async function reconcilePackages(): Promise<void> {
  const packages = await listPackages()
  for (const pkg of packages) {
    if (!(await pathExists(pkg.rootPath))) {
      await deletePackageRecord(pkg.id)
    }
  }
}
