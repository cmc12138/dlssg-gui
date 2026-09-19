/**
 * REFramework 链路自检：查最新 nightly → 真下载（走 GitHub API 资产接口）→ 解压安装 → 卸载还原。
 * 用法：node --import ./test/loader.mjs tools/check-reframework.mts
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const workRoot = join(process.cwd(), '.check-ref')
process.env.DLSSG_GUI_DATA_DIR = join(workRoot, 'data')

const { fetchLatestRefRelease, installReframework, getRefStatus, uninstallReframework } = await import('../src/main/reframework')
const { saveGame, getGame } = await import('../src/main/db')
const { ensureDataDirs } = await import('../src/main/paths')
const { defaultIniConfig } = await import('../src/shared/ini-schema')

rmSync(workRoot, { recursive: true, force: true })
ensureDataDirs()

// 造一个假的 RE Engine 游戏目录（有 re_chunk_000.pak 特征）
const gameDir = join(workRoot, 'game')
mkdirSync(join(gameDir, 'dlc'), { recursive: true })
writeFileSync(join(gameDir, 'PRAGMATA.exe'), 'fake exe')
writeFileSync(join(gameDir, 're_chunk_000.pak'), Buffer.alloc(4096, 9))
writeFileSync(join(gameDir, 'dlc', 're_dlc_stm_1.pak'), Buffer.alloc(256, 8))

const now = new Date().toISOString()
await saveGame({
  id: 'check-ref',
  name: 'PRAGMATA（自检）',
  source: 'manual',
  installDir: gameDir,
  exeDir: gameDir,
  exeName: 'PRAGMATA.exe',
  candidates: [],
  dlssgCapable: true,
  config: defaultIniConfig(),
  history: [],
  createdAt: now,
  updatedAt: now
})

console.log('== 查最新 REFramework ==')
const release = await fetchLatestRefRelease(await getGame('check-ref'))
console.log(`  ${release.repo}  ${release.tag}  ${release.assetName}  ${(release.size / 1024 / 1024).toFixed(1)}MB  assetId=${release.assetId}`)
console.log(`  发布时间 ${release.publishedAt}\n  ${release.url}`)

console.log('\n== 检测 ==')
const before = await getRefStatus('check-ref')
console.log(`  reEngine=${before.reEngine}（依据 ${before.engineEvidence}）已安装=${before.installed} 目标=${before.targetDir}`)

console.log('\n== 下载并安装 ==')
const started = Date.now()
const installed = await installReframework('check-ref', {
  onProgress: (event) => console.log(`  [${event.done}/${event.total}] ${event.label}`)
})
console.log(`  ok=${installed.ok}  ${installed.message.split('\n')[0]}`)
console.log(`  耗时 ${((Date.now() - started) / 1000).toFixed(1)}s  写入 ${installed.record?.files.length} 个文件`)
console.log('  顶层文件：' + readdirSync(gameDir).filter((name) => !name.startsWith('re_') && name !== 'dlc').join('、'))
if (existsSync(join(gameDir, 'reframework'))) {
  console.log('  reframework 目录：' + readdirSync(join(gameDir, 'reframework')).join('、'))
} else {
  console.log('  reframework 目录：不存在')
}
console.log(`  dinput8.dll 存在=${existsSync(join(gameDir, 'dinput8.dll'))}`)

console.log('\n== 卸载 ==')
const removed = await uninstallReframework('check-ref')
console.log(`  ok=${removed.ok}  ${removed.message.split('\n')[0]}`)
console.log(`  卸载后 dinput8.dll 存在=${existsSync(join(gameDir, 'dinput8.dll'))}  reframework 目录存在=${existsSync(join(gameDir, 'reframework'))}`)

const ok = installed.ok && removed.ok && !existsSync(join(gameDir, 'dinput8.dll'))
console.log(ok ? '\n自检通过' : '\n自检失败')
if (ok && process.env.DLSSG_KEEP_CHECK !== '1') rmSync(workRoot, { recursive: true, force: true })
process.exitCode = ok ? 0 : 1
