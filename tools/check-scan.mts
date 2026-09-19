/**
 * 扫描自检：在本机真实环境里跑一遍 Steam / Epic / GOG 扫描 + DLSS-G 能力探测。
 * 用法：node --import ./test/loader.mjs tools/check-scan.mts
 * 只读，不写入任何游戏目录。
 */
import { findSteamRoot, scanLibraries } from '../src/main/scan'

const started = Date.now()
console.log('Steam 根目录:', (await findSteamRoot()) ?? '未找到')

let lastLine = ''
const result = await scanLibraries({
  onProgress: (progress) => {
    const line = `[${progress.done}/${progress.total}] ${progress.label}`
    if (line !== lastLine) {
      lastLine = line
      if (progress.done === progress.total || progress.done % 10 === 0) console.log(line)
    }
  }
})

console.log(`\n发现 ${result.games.length} 个游戏，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
for (const warning of result.warnings) console.log('提示:', warning)

const capable = result.games.filter((game) => game.dlssgCapable)
console.log(`\n其中 ${capable.length} 个检测到 nvngx_dlssg.dll（可以开帧生成）：`)
for (const game of capable.slice(0, 25)) {
  console.log(`  ${game.source.toUpperCase().padEnd(5)} ${game.name}`)
  console.log(`        渲染目录 ${game.exeDir}`)
  console.log(
    `        EXE ${game.exeName} · 候选目录 ${game.candidates.length} 个` +
      (game.candidates[0]?.hasFsrFrameGen ? ' · 旁边有 FSR 帧生成' : '')
  )
}

const upscalingOnly = result.games.filter(
  (game) => !game.dlssgCapable && game.candidates.some((candidate) => candidate.hasDlss)
)
console.log(`\n只有 DLSS 超分（无帧生成）的游戏 ${upscalingOnly.length} 个，例如：`)
for (const game of upscalingOnly.slice(0, 8)) console.log(`  ${game.name} → ${game.exeDir}`)

const neither = result.games.filter((game) => !game.dlssgCapable && !game.candidates.some((candidate) => candidate.hasDlss))
console.log(`\n没有 NVIDIA DLSS 的游戏 ${neither.length} 个（渲染目录仍然会猜出来，但注入没有意义）`)
for (const game of neither.slice(0, 5)) console.log(`  ${game.name} → ${game.exeDir || '（没找到 EXE 目录）'}`)
