import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { GameLogFile, LogReadResult, LogSummary } from '@shared/types'

const MAX_TAIL_BYTES = 256 * 1024

/** 日志目录：ini 里的 Directory 相对路径基于 ini 所在目录（也就是游戏 EXE 目录）。 */
export function resolveLogDir(exeDir: string, logDirectory: string): string {
  const trimmed = (logDirectory || 'dlssg_sm86\\logs').trim()
  if (!trimmed) return join(exeDir, 'dlssg_sm86', 'logs')
  return resolve(exeDir, trimmed)
}

export async function listGameLogs(exeDir: string, logDirectory: string): Promise<GameLogFile[]> {
  const dir = resolveLogDir(exeDir, logDirectory)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const files: GameLogFile[] = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.jsonl') && !name.toLowerCase().endsWith('.log')) continue
    const path = join(dir, name)
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) continue
    const lower = name.toLowerCase()
    files.push({
      name,
      path,
      size: info.size,
      mtime: info.mtime.toISOString(),
      kind: lower.startsWith('loader') ? 'loader' : lower.startsWith('backend') ? 'backend' : 'other'
    })
  }
  files.sort((a, b) => b.mtime.localeCompare(a.mtime))
  return files
}

async function readTail(path: string, bytes = MAX_TAIL_BYTES): Promise<string> {
  const info = await stat(path)
  const start = Math.max(0, info.size - bytes)
  const { open } = await import('node:fs/promises')
  const handle = await open(path, 'r')
  try {
    const length = info.size - start
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

export async function readLogFile(path: string, maxLines = 500): Promise<LogReadResult> {
  const info = await stat(path)
  const text = await readTail(path)
  const raw = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  const sliced = raw.slice(-maxLines)
  const lines = sliced.map((line) => {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      const level = String(parsed.level ?? parsed.severity ?? parsed.lvl ?? '')
      const message = String(parsed.msg ?? parsed.message ?? parsed.event ?? '')
      const time = String(parsed.time ?? parsed.timestamp ?? parsed.ts ?? '')
      return { raw: line, level: level || undefined, message: message || undefined, time: time || undefined }
    } catch {
      return { raw: line }
    }
  })
  return {
    file: {
      name: basename(path),
      path,
      size: info.size,
      mtime: info.mtime.toISOString(),
      kind: basename(path).toLowerCase().startsWith('loader') ? 'loader' : basename(path).toLowerCase().startsWith('backend') ? 'backend' : 'other'
    },
    lines,
    truncated: text.length >= MAX_TAIL_BYTES
  }
}

/** 汇总日志：是否真的挂上了代理、路由是否激活、有没有错误。 */
export async function summarizeLogs(exeDir: string, logDirectory: string): Promise<LogSummary> {
  const files = await listGameLogs(exeDir, logDirectory)
  const summary: LogSummary = {
    files: files.length,
    proxyRedirect: false,
    routeActive: false,
    errors: []
  }
  if (files.length === 0) return summary
  summary.lastWrite = files[0].mtime
  for (const file of files.slice(0, 4)) {
    let text = ''
    try {
      text = await readTail(file.path, 128 * 1024)
    } catch {
      continue
    }
    if (/runtime_redirect|runtime redirect/i.test(text)) summary.proxyRedirect = true
    if (/"route"\s*:\s*true|route active\s*=?\s*true|"install"\s*:\s*true/i.test(text)) summary.routeActive = true
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      if (/"(level|severity)"\s*:\s*"(error|fatal|err)"/i.test(line) || /\bERROR\b/.test(line)) {
        if (summary.errors.length < 20) summary.errors.push(line.slice(0, 400))
      }
    }
  }
  summary.errors = summary.errors.slice(0, 20)
  return summary
}

/** 读取游戏目录里是否存在本项目在用的 ini（用于和外部注入做对比）。 */
export async function readGameIni(exeDir: string): Promise<string | null> {
  try {
    return await readFile(join(exeDir, 'dlssg_sm86.ini'), 'utf8')
  } catch {
    return null
  }
}
