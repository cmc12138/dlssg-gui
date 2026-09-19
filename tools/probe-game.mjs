/** 查一个游戏目录里跟 DLSS / 帧生成有关的文件都在哪一层，用来解释"扫描说没有、游戏里却有帧生成选项" */
import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

const roots = ['H:\\SteamLibrary\\steamapps', 'D:\\SteamLibrary\\steamapps', 'F:\\SteamLibrary\\steamapps', 'C:\\Program Files (x86)\\Steam\\steamapps']
const needle = /expedition/i

async function findInstallDir() {
  for (const root of roots) {
    let files = []
    try {
      files = await readdir(root)
    } catch {
      continue
    }
    for (const file of files) {
      if (!/^appmanifest_\d+\.acf$/i.test(file)) continue
      const text = await (await import('node:fs/promises')).readFile(join(root, file), 'utf8')
      const name = /"name"\s*"([^"]*)"/.exec(text)?.[1] ?? ''
      const installdir = /"installdir"\s*"([^"]*)"/.exec(text)?.[1] ?? ''
      if (needle.test(name)) {
        console.log(`appmanifest: ${file}`)
        console.log(`  name       = ${name}`)
        console.log(`  installdir = ${installdir}`)
        console.log(`  完整路径   = ${join(root, 'common', installdir)}`)
        return join(root, 'common', installdir)
      }
    }
  }
  return null
}

const installDir = await findInstallDir()
if (!installDir) {
  console.log('没找到《Clair Obscur: Expedition 33》的安装目录')
  process.exit(0)
}

const hits = []
const SKIP = new Set(['redist', '_commonredist', 'redistributable', 'directx', 'vcredist', 'installer', '__installer'])

async function walk(dir, depth, maxDepth) {
  if (depth > maxDepth) return
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isFile()) {
      if (/dlss|nvngx|sl\.|streamline|fsr|frame.?gen|amdxcffx/i.test(entry.name)) {
        const info = await stat(full).catch(() => null)
        hits.push({ rel: relative(installDir, full), size: info?.size ?? 0 })
      }
    } else if (entry.isDirectory() && !SKIP.has(entry.name.toLowerCase())) {
      await walk(full, depth + 1, maxDepth)
    }
  }
}

await walk(installDir, 1, 8)
hits.sort((a, b) => a.rel.localeCompare(b.rel))
console.log(`\n安装目录：${installDir}`)
console.log(`共找到 ${hits.length} 个相关文件（递归深度 8）：`)
for (const hit of hits) {
  const depth = hit.rel.split('\\').length
  console.log(`  深度${depth}  ${(hit.size / 1024).toFixed(0).padStart(6)} KB  ${hit.rel}`)
}

console.log('\n按"我工具当前的判定规则"（深度 4 内找 nvngx_dlssg.dll / nvngx_dlss.dll）会怎样：')
const within4 = hits.filter((hit) => hit.rel.split('\\').length <= 4)
console.log('  深度 ≤4 的相关文件：', within4.length ? within4.map((hit) => hit.rel).join(' | ') : '（一个都没有 → 会被判成"未检测到 DLSS-G"）')
const dlssg = hits.filter((hit) => /nvngx_dlssg\.dll$/i.test(hit.rel))
console.log('  任意深度的 nvngx_dlssg.dll：', dlssg.length ? dlssg.map((hit) => `${hit.rel}（深度 ${hit.rel.split('\\').length}）`).join(' | ') : '无')
