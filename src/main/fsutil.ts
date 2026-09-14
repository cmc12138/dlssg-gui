import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes)) return '-'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/** 先写临时文件再改名，避免半截文件留在游戏目录里。 */
export async function atomicWriteFile(path: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.dlssg-tmp`
  await writeFile(tmp, data)
  await rename(tmp, path)
}

/** 复制文件（同样走临时文件 + 改名）。 */
export async function atomicCopyFile(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  const tmp = `${dest}.dlssg-tmp`
  await copyFile(src, tmp)
  await rename(tmp, dest)
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

/** 判断文件是否是合法的 PE（MZ 头 + PE 签名），用来挡掉下载坏掉的文件。 */
export async function isPortableExecutable(path: string): Promise<boolean> {
  try {
    const handle = await open(path, 'r')
    try {
      const dos = Buffer.alloc(0x40)
      await handle.read(dos, 0, dos.length, 0)
      if (dos[0] !== 0x4d || dos[1] !== 0x5a) return false
      const peOffset = dos.readUInt32LE(0x3c)
      if (peOffset <= 0 || peOffset > 0x10000000) return false
      const pe = Buffer.alloc(4)
      await handle.read(pe, 0, pe.length, peOffset)
      return pe[0] === 0x50 && pe[1] === 0x45 && pe[2] === 0x00 && pe[3] === 0x00
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}

export interface WalkOptions {
  maxDepth: number
  /** 命中后不再深入该目录 */
  stopWhen?: (dir: string, files: string[]) => boolean
  skipDirNames?: Set<string>
}

/** 广度优先遍历目录，返回每个目录里的文件名列表。 */
export async function walkDirs(root: string, options: WalkOptions): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  const skip = options.skipDirNames ?? new Set<string>()
  let frontier: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  while (frontier.length > 0) {
    const next: { dir: string; depth: number }[] = []
    for (const item of frontier) {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await readdir(item.dir, { withFileTypes: true })
      } catch {
        continue
      }
      const files: string[] = []
      for (const entry of entries) {
        if (entry.isFile()) files.push(entry.name)
        else if (entry.isDirectory() && item.depth < options.maxDepth && !skip.has(entry.name.toLowerCase())) {
          next.push({ dir: join(item.dir, entry.name), depth: item.depth + 1 })
        }
      }
      result.set(item.dir, files)
      if (options.stopWhen?.(item.dir, files)) continue
    }
    frontier = next
  }
  return result
}
