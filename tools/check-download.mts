/**
 * 上游链路自检：动态发现 → 下载 → 导入 → 再比对是否还有更新。
 * 用法：node --import ./test/loader.mjs tools/check-download.mts
 * 会真的下载约 180MB（主分支发布包：version.dll + 5 个替代代理 + ini）到 DLSSG_GUI_DATA_DIR。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'

process.env.DLSSG_GUI_DATA_DIR ??= join(process.cwd(), '.check-download')

const { checkUpstream, invalidateUpstreamCache } = await import('../src/main/upstream')
const { listRemoteVariants, getSeed, invalidateRemoteCache } = await import('../src/main/remote-variants')
const { downloadVariant, verifyPackage } = await import('../src/main/library')
const { listPackages } = await import('../src/main/db')

const started = Date.now()
console.log('== 发现上游发布包 ==')
const status = await checkUpstream({ force: true })
if (status.error) {
  console.error('检查上游失败：', status.error)
  process.exit(1)
}
console.log(`仓库 ${status.repo} · 分支 ${status.branch} · 项目版本 ${status.projectVersion}`)
console.log(`最新提交 ${status.latestCommit.sha.slice(0, 7)} ${status.latestCommit.date} ${status.latestCommit.message}`)
for (const pkg of status.packages) {
  console.log(
    `  [${pkg.path || '/'}] ${pkg.runtimeVersion} 最高 ${pkg.maxMultiplier}X · 主DLL ${pkg.versionSize} 字节 · ` +
      `${pkg.proxies.length} 个代理 · ini=${pkg.iniPath ?? '无'} · 本地=${pkg.localPackageId ? '已导入' : '未导入'}`
  )
}

console.log('\n== 下载列表（动态发现优先） ==')
const variants = await listRemoteVariants()
for (const variant of variants) {
  console.log(`  ${variant.id} · ${variant.name} · ${variant.proxies.length} 个文件 · 路径 ${variant.repoPath}`)
}

const rootVariant = variants.find((variant) => variant.prefix === '') ?? variants[0]
const seed = getSeed(rootVariant.id)
if (!seed) throw new Error('下载列表里的 id 没有注册成种子')
console.log(`\n== 下载 ${seed.name} ==`)
let last = ''
const pkg = await downloadVariant(seed, {
  preferMirror: false,
  onProgress: (event) => {
    if (event.label !== last) {
      last = event.label
      console.log(`  [${event.done}/${event.total}] ${event.label}`)
    }
  }
})
console.log(`导入成功：${pkg.name}`)
console.log(`  运行库 ${pkg.runtimeVersion} · 最高 ${pkg.maxMultiplier}X · 项目 ${pkg.projectVersion ?? '未知'}`)
console.log(
  `  remoteRepo=${pkg.remoteRepo} remotePath=${JSON.stringify(pkg.remotePath)} remoteBlobs=${Object.keys(pkg.remoteBlobs ?? {}).length} 个`
)
for (const proxy of pkg.proxies) console.log(`    ${proxy.relPath} ${proxy.size} 字节`)

console.log('\n== 校验落盘文件 ==')
const rows = await verifyPackage(pkg.id)
for (const row of rows) console.log(`  ${row.ok ? 'OK  ' : 'FAIL'} ${row.name}`)
const registered = (await listPackages()).some((item) => item.id === pkg.id)

console.log('\n== 下载后再比对（应为没有更新）==')
invalidateUpstreamCache()
invalidateRemoteCache()
const after = await checkUpstream({ force: true })
for (const item of after.packages) {
  if (item.localPackageId) console.log(`  [${item.path || '/'}] 本地=${item.localPackageName} 有更新=${item.updateAvailable}`)
}
const updated = after.packages.find((item) => item.localPackageId)?.updateAvailable

const failures = rows.filter((row) => !row.ok)
console.log(`\n耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
if (!registered || failures.length > 0 || updated !== false) {
  console.error(`自检失败 registered=${registered} 校验失败=${failures.length} 误报有更新=${updated}`)
  process.exitCode = 1
} else {
  console.log('自检通过：动态发现、下载、哈希校验、更新比对都正确')
  if (process.env.DLSSG_KEEP_CHECK !== '1') rmSync(process.env.DLSSG_GUI_DATA_DIR, { recursive: true, force: true })
}
