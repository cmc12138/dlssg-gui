import { readFileSync } from 'node:fs'

const pick = (file) => new Set([...readFileSync(file, 'utf8').matchAll(/IPC\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))
// api.ts 里频道名是对象的键，单独抓
const apiSource = readFileSync('src/shared/api.ts', 'utf8')
const block = apiSource.slice(apiSource.indexOf('export const IPC'))
const shared = new Set([...block.matchAll(/^\s{2}([A-Za-z0-9_]+):/gm)].map((m) => m[1]))
const preload = pick('src/preload/index.ts')
const ipcFile = pick('src/main/ipc.ts')

const diff = (a, b) => [...a].filter((item) => !b.has(item))
console.log('shared:', shared.size, 'preload:', preload.size, 'ipc handlers:', ipcFile.size)
console.log('shared 里定义了但 preload 没用:', diff(shared, preload))
console.log('preload 用了但 shared 没定义:', diff(preload, shared))
console.log('preload 用了但主进程没注册:', diff(preload, ipcFile))
console.log('主进程注册了但 preload 没用:', diff(ipcFile, preload))
console.log('主进程注册了但 shared 没定义:', diff(ipcFile, shared))
