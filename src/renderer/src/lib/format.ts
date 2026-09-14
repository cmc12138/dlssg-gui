export function humanSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '-'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return '-'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function truncateMiddle(text: string, max = 54): string {
  if (text.length <= max) return text
  const half = Math.floor((max - 1) / 2)
  return `${text.slice(0, half)}…${text.slice(text.length - half)}`
}

export const STATE_LABEL: Record<string, string> = {
  'not-installed': '未注入',
  installed: '已注入',
  'installed-external': '已存在（非本工具）',
  outdated: '配置不一致',
  partial: '文件缺失或被改',
  conflict: '冲突',
  'dir-missing': '目录丢失'
}

export const STATE_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'muted'> = {
  'not-installed': 'muted',
  installed: 'ok',
  'installed-external': 'warn',
  outdated: 'warn',
  partial: 'bad',
  conflict: 'bad',
  'dir-missing': 'bad'
}

export function frameRateEstimate(baseFps: number, multiplier: number, frameGenMs: number): number {
  if (!Number.isFinite(baseFps) || baseFps <= 0) return 0
  const baseMs = 1000 / baseFps
  return (1000 * multiplier) / (baseMs + frameGenMs)
}
