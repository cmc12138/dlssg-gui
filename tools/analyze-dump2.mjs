/**
 * minidump 深挖：异常线程寄存器 + 异常地址处的机器码字节（判断"非法指令"是不是真的取到了非法代码段）
 * 用法：node tools/analyze-dump2.mjs <MiniDump.dmp>
 */
import { readFileSync } from 'node:fs'

const buf = readFileSync(process.argv[2])
if (buf.toString('latin1', 0, 4) !== 'MDMP') throw new Error('不是 minidump')
const numberOfStreams = buf.readUInt32LE(8)
const streamDirRva = buf.readUInt32LE(12)
const streams = new Map()
for (let i = 0; i < numberOfStreams; i += 1) {
  const off = streamDirRva + i * 12
  streams.set(buf.readUInt32LE(off), { size: buf.readUInt32LE(off + 4), rva: buf.readUInt32LE(off + 8) })
}

// 模块表
const modules = []
const moduleStream = streams.get(4)
const moduleCount = buf.readUInt32LE(moduleStream.rva)
for (let i = 0; i < moduleCount; i += 1) {
  const off = moduleStream.rva + 4 + i * 108
  const nameRva = buf.readUInt32LE(off + 20)
  const nameLength = buf.readUInt32LE(nameRva)
  modules.push({
    base: buf.readBigUInt64LE(off),
    size: buf.readUInt32LE(off + 8),
    name: buf.toString('utf16le', nameRva + 4, nameRva + 4 + nameLength).split(/[\\/]/).pop()
  })
}
const moduleFor = (value) => {
  for (const module of modules) {
    if (value >= module.base && value < module.base + BigInt(module.size)) {
      return `${module.name} + 0x${(value - module.base).toString(16)}`
    }
  }
  return undefined
}

// 内存范围（普通 MemoryList + 64 位 Memory64List）
const ranges = []
const memoryList = streams.get(5)
if (memoryList) {
  const count = buf.readUInt32LE(memoryList.rva)
  for (let i = 0; i < count; i += 1) {
    const off = memoryList.rva + 4 + i * 16
    ranges.push({ start: buf.readBigUInt64LE(off), size: buf.readUInt32LE(off + 8), rva: buf.readUInt32LE(off + 12) })
  }
}
const memory64 = streams.get(9)
if (memory64) {
  const count = buf.readBigUInt64LE(memory64.rva)
  let cursor = memory64.rva + 16
  let dataRva = Number(buf.readBigUInt64LE(memory64.rva + 8))
  for (let i = 0; i < Number(count); i += 1) {
    const start = buf.readBigUInt64LE(cursor)
    const size = Number(buf.readBigUInt64LE(cursor + 8))
    ranges.push({ start, size, rva: dataRva })
    cursor += 16
    dataRva += size
  }
}

const exceptionStream = streams.get(6)
const rva = exceptionStream.rva
const threadId = buf.readUInt32LE(rva)
const code = buf.readUInt32LE(rva + 8)
const address = buf.readBigUInt64LE(rva + 24)
// MINIDUMP_EXCEPTION_STREAM: ThreadId(4) alignment(4) Exception(152) then ThreadContext DESCRIPTOR(DataSize,Rva)
const contextRva = buf.readUInt32LE(rva + 8 + 152 + 4)

console.log(`异常 线程=${threadId} code=0x${code.toString(16)}（C000001D = 非法指令）address=0x${address.toString(16)} → ${moduleFor(address)}`)
if (contextRva) {
  const read = (offset) => buf.readBigUInt64LE(contextRva + offset)
  console.log(`  Rip=0x${read(0xf8).toString(16)} → ${moduleFor(read(0xf8))}`)
  console.log(`  Rsp=0x${read(0x98).toString(16)}  Rbp=0x${read(0xa0).toString(16)} → ${moduleFor(read(0xa0))}`)
  console.log(`  Rax=0x${read(0x78).toString(16)} Rbx=0x${read(0x90).toString(16)} Rcx=0x${read(0x80).toString(16)} Rdx=0x${read(0x88).toString(16)}`)
  console.log(`  R8 =0x${read(0xb8).toString(16)} R9 =0x${read(0xc0).toString(16)} R10=0x${read(0xc8).toString(16)} R11=0x${read(0xd0).toString(16)}`)
  console.log(`  ContextFlags=0x${buf.readUInt32LE(contextRva + 0x30).toString(16)}  EFlags=0x${buf.readUInt32LE(contextRva + 0x44).toString(16)}`)
}

// 异常地址处的机器码
const range = ranges.find((item) => address >= item.start && address < item.start + BigInt(item.size))
if (!range) {
  console.log(`\n异常地址所在内存页不在 dump 里（minidump 通常只带栈和少数页）`)
} else {
  const offset = Number(address - range.start)
  const start = Math.max(0, offset - 16)
  const bytes = buf.subarray(range.rva + start, range.rva + Math.min(range.size, offset + 32))
  console.log(`\n异常地址附近的机器码（前 16 字节是指令之前的上下文）：`)
  console.log('  ' + bytes.toString('hex').replace(/(..)/g, '$1 ').trim())
}
