/**
 * 极简 minidump 分析：列出模块、定位异常地址属于哪个模块、从异常线程栈里找 module+offset 的返回地址。
 * 用法：node tools/analyze-dump.mjs <MiniDump.dmp>
 * （没有 windbg 的环境下够用了：能看出崩在哪个 DLL、栈上出现过谁）
 */
import { readFileSync } from 'node:fs'

const path = process.argv[2]
if (!path) throw new Error('用法：node tools/analyze-dump.mjs <MiniDump.dmp>')
const buf = readFileSync(path)

if (buf.toString('latin1', 0, 4) !== 'MDMP') throw new Error('不是 minidump 文件')
const numberOfStreams = buf.readUInt32LE(8)
const streamDirRva = buf.readUInt32LE(12)
console.log(`minidump: ${numberOfStreams} 个流，时间戳 ${new Date(buf.readUInt32LE(20) * 1000).toLocaleString()}`)

const streams = new Map()
for (let i = 0; i < numberOfStreams; i += 1) {
  const off = streamDirRva + i * 12
  streams.set(buf.readUInt32LE(off), { size: buf.readUInt32LE(off + 4), rva: buf.readUInt32LE(off + 8) })
}

function readString(rva) {
  const length = buf.readUInt32LE(rva)
  return buf.toString('utf16le', rva + 4, rva + 4 + length)
}

// ── 模块表 ──────────────────────────────────────────────
const modules = []
const moduleStream = streams.get(4)
if (moduleStream) {
  const count = buf.readUInt32LE(moduleStream.rva)
  for (let i = 0; i < count; i += 1) {
    const off = moduleStream.rva + 4 + i * 108
    modules.push({
      base: buf.readBigUInt64LE(off),
      size: buf.readUInt32LE(off + 8),
      timestamp: buf.readUInt32LE(off + 16),
      name: readString(buf.readUInt32LE(off + 20))
    })
  }
}
modules.sort((a, b) => (a.base < b.base ? -1 : 1))
const moduleFor = (address) => {
  const value = BigInt(address)
  for (const module of modules) {
    if (value >= module.base && value < module.base + BigInt(module.size)) {
      const offset = value - module.base
      return `${module.name.split(/[\\/]/).pop()} + 0x${offset.toString(16)}`
    }
  }
  return undefined
}
console.log(`\n模块 ${modules.length} 个，重点看这些：`)
for (const module of modules) {
  const short = module.name.split(/[\\/]/).pop()
  if (/version\.dll|dinput8|winmm|nvngx|sl\.|dlssg|sm86|reframework|PRAGMATA\.exe|nvapi|nvcuda|d3d12|dxgi/i.test(short)) {
    console.log(`  ${short.padEnd(26)} base=0x${module.base.toString(16)} size=${(module.size / 1024 / 1024).toFixed(2)}MB`)
  }
}

// ── 异常流 ──────────────────────────────────────────────
const exceptionStream = streams.get(6)
if (exceptionStream) {
  const rva = exceptionStream.rva
  const threadId = buf.readUInt32LE(rva)
  const code = buf.readUInt32LE(rva + 8)
  const address = buf.readBigUInt64LE(rva + 24)
  const contextRva = buf.readUInt32LE(rva + 8 + 152)
  console.log(`\n异常：线程 ${threadId}  code=0x${code.toString(16)}  address=0x${address.toString(16)}`)
  console.log(`  地址所属模块：${moduleFor(address) ?? '（不属于任何模块 → 多半是跳到了坏地址/被改写的内存）'}`)
  if (contextRva) {
    const rip = buf.readBigUInt64LE(contextRva + 0xf8)
    const rsp = buf.readBigUInt64LE(contextRva + 0x98)
    const rbp = buf.readBigUInt64LE(contextRva + 0xa0)
    console.log(`  Rip=0x${rip.toString(16)} → ${moduleFor(rip) ?? '（无模块）'}`)
    console.log(`  Rsp=0x${rsp.toString(16)}  Rbp=0x${rbp.toString(16)} → ${moduleFor(rbp) ?? '（无模块）'}`)
  }
}

// ── 线程栈：找落回某个模块的返回地址 ─────────────────────
const threadStream = streams.get(3)
if (threadStream) {
  const count = buf.readUInt32LE(threadStream.rva)
  const exceptionThread = exceptionStream ? buf.readUInt32LE(exceptionStream.rva) : 0
  console.log(`\n线程 ${count} 个，异常线程的栈顶返回地址：`)
  for (let i = 0; i < count; i += 1) {
    const off = threadStream.rva + 4 + i * 48
    const threadId = buf.readUInt32LE(off)
    if (exceptionThread && threadId !== exceptionThread) continue
    const stackStart = buf.readBigUInt64LE(off + 24)
    const stackSize = buf.readUInt32LE(off + 32)
    const stackRva = buf.readUInt32LE(off + 36)
    console.log(`  线程 ${threadId} 栈 0x${stackStart.toString(16)} 大小 ${(stackSize / 1024).toFixed(0)}KB`)
    const hits = []
    for (let p = 0; p + 8 <= stackSize; p += 8) {
      const value = buf.readBigUInt64LE(stackRva + p)
      if (value < 0x10000n) continue
      const hit = moduleFor(value)
      if (hit) hits.push(`  栈+0x${p.toString(16).padStart(4, '0')}  ${hit}`)
      if (hits.length > 40) break
    }
    console.log(hits.slice(0, 40).join('\n') || '  （栈上没找到有效返回地址）')
  }
}
