/**
 * 网络自检：验证「从 GitHub 下载运行库」这条链路（探测 + 下载 + 导入 + 登记）。
 * 用法：node --import ./test/loader.mjs tools/check-download.mts
 * 会真的下载约 110MB 到 DLSSG_GUI_DATA_DIR 指向的数据目录（默认 .check-download）。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'

process.env.DLSSG_GUI_DATA_DIR ??= join(process.cwd(), '.check-download')

const { listRemoteVariants, REMOTE_VARIANTS, invalidateRemoteCache } = await import('../src/main/remote-variants')
const { downloadVariant, verifyPackage } = await import('../src/main/library')
const { listPackages } = await import('../src/main/db')

const started = Date.now()
console.log('== 探测上游文件 ==')
const variants = await listRemoteVariants(true)
for (const variant of variants) {
  console.log(
    `${variant.id} ${variant.name} available=${variant.available} 主DLL=${variant.proxies[0]?.size} 字节` +
      ` 代理=${variant.proxies.length} 路径=${variant.repoPath}${variant.error ? ` 错误=${variant.error}` : ''}`
  )
}
const target = variants.find((variant) => variant.available) ?? invalidateRemoteCache() ?? REMOTE_VARIANTS[0]
const seed = REMOTE_VARIANTS.find((variant) => variant.id === (target as { id: string }).id) ?? REMOTE_VARIANTS[0]

console.log(`\n== 下载并导入 ${seed.id} ==`)
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
console.log(`导入成功：${pkg.name} · 运行库 ${pkg.runtimeVersion} · 最高 ${pkg.maxMultiplier}X`)
console.log(`  root=${pkg.rootPath}`)
for (const proxy of pkg.proxies) console.log(`  ${proxy.relPath} ${proxy.size} 字节 sha256=${proxy.sha256.slice(0, 12)}…`)

console.log('\n== 校验落盘文件 ==')
const rows = await verifyPackage(pkg.id)
for (const row of rows) console.log(`  ${row.ok ? 'OK  ' : 'FAIL'} ${row.name}`)
const registered = (await listPackages()).some((item) => item.id === pkg.id)
console.log(`已登记到运行库列表：${registered}`)
console.log(`耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`)

const failures = rows.filter((row) => !row.ok)
if (!registered || failures.length > 0) {
  console.error('自检失败')
  process.exitCode = 1
} else {
  console.log('自检通过')
  if (process.env.DLSSG_KEEP_CHECK !== '1') rmSync(process.env.DLSSG_GUI_DATA_DIR, { recursive: true, force: true })
}
