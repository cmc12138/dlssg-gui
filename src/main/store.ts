import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicWriteFile, ensureDir, pathExists } from './fsutil'

/** 极简 JSON 持久化：写入走临时文件 + 改名，读失败时回退到默认值。 */
export class JsonStore<T> {
  private readonly file: () => string
  private readonly fallback: () => T
  private cache?: T

  constructor(file: () => string, fallback: () => T) {
    this.file = file
    this.fallback = fallback
  }

  async read(): Promise<T> {
    if (this.cache) return this.cache
    const path = this.file()
    try {
      if (await pathExists(path)) {
        const text = await readFile(path, 'utf8')
        this.cache = { ...this.fallback(), ...(JSON.parse(text) as object) } as T
        return this.cache
      }
    } catch {
      // 文件损坏时退回默认值，保证界面可用
    }
    this.cache = this.fallback()
    return this.cache
  }

  async write(value: T): Promise<void> {
    this.cache = value
    const path = this.file()
    await ensureDir(dirname(path))
    await atomicWriteFile(path, JSON.stringify(value, null, 2))
  }

  async update(mutator: (value: T) => T | void): Promise<T> {
    const current = await this.read()
    const draft = structuredClone(current)
    const next = mutator(draft) ?? draft
    await this.write(next)
    return next
  }

  invalidate(): void {
    this.cache = undefined
  }
}
