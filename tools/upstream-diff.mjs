import { mkdirSync, writeFileSync } from 'node:fs'

const API = 'https://api.github.com/repos/sdli1995/dlssg_for_sm86/contents'
const H = { 'user-agent': 'dsh', accept: 'application/vnd.github+json' }

async function getText(path) {
  let last
  for (let i = 1; i <= 5; i += 1) {
    try {
      const r = await fetch(`${API}/${path}?ref=main`, { headers: H })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const j = await r.json()
      return Buffer.from(j.content, 'base64').toString('utf8')
    } catch (e) {
      last = e
      await new Promise((res) => setTimeout(res, 1500 * i))
    }
  }
  throw last
}

mkdirSync('.ref', { recursive: true })
const readme = await getText('README.md')
const install = await getText('docs/INSTALL.md')
writeFileSync('.ref/README-0.3.4.md', readme)
writeFileSync('.ref/INSTALL-0.3.4.md', install)

console.log('README', readme.length, '字节 / INSTALL', install.length, '字节')
console.log('\n=== README 关键行 ===')
for (const line of readme.split('\n')) {
  const t = line.trim()
  if (!t || t.startsWith('|')) continue
  if (/310\.\d|0\.3\.\d|6X|MaxGeneratedFrames|Optimized|Turing|SM75|Vulkan|Spoof/i.test(t)) console.log('  ' + t.slice(0, 175))
}

console.log('\n=== INSTALL.md 段与键 ===')
const sections = new Set()
const keys = new Set()
for (const m of install.matchAll(/^\[([A-Za-z][A-Za-z0-9_]*)\]/gm)) sections.add(m[1])
for (const m of install.matchAll(/^\s{0,6}([A-Z][A-Za-z0-9_]{2,})\s*=/gm)) keys.add(m[1])
console.log('  段:', [...sections].join(', ') || '(无)')
console.log('  键:', [...keys].sort().join(', ') || '(无)')

console.log('\n=== INSTALL.md 标题 ===')
for (const line of install.split('\n')) if (/^#{1,3} /.test(line)) console.log('  ' + line.slice(0, 120))
