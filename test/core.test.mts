import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

// 让核心模块把数据写到临时目录，避免碰到真实 AppData
const workRoot = mkdtempSync(join(tmpdir(), 'dlssg-gui-test-'))
process.env.DLSSG_GUI_DATA_DIR = join(workRoot, 'data')

const { defaultIniConfig, parseIniConfig, serializeIniConfig, normalizeIniConfig } = await import('../src/shared/ini-schema')
const { detectPackages, importFromFolder, importFromZip } = await import('../src/main/library')
const { applyInstall, getGameStatus, planInstall, restoreGame, updateIniOnly } = await import('../src/main/inject')
const { getPackage, listPackages, saveGame, listGames } = await import('../src/main/db')
const { findCandidates } = await import('../src/main/scan')
const { ensureDataDirs } = await import('../src/main/paths')

import type { GameEntry } from '../src/shared/types'

/** 造一个最小合法 PE 文件（MZ + e_lfanew + PE 签名），内容可控以便哈希不同。 */
function fakePe(seed: number, size = 2048): Buffer {
  const buffer = Buffer.alloc(size)
  buffer[0] = 0x4d
  buffer[1] = 0x5a
  buffer.writeUInt32LE(0x40, 0x3c)
  buffer.write('PE\0\0', 0x40, 'latin1')
  for (let i = 0x44; i < size; i += 1) buffer[i] = (i * 31 + seed) % 251
  return buffer
}

function makeRelease(root: string): void {
  mkdirSync(join(root, 'alternatives'), { recursive: true })
  writeFileSync(join(root, 'version.dll'), fakePe(1, 4096))
  writeFileSync(join(root, 'alternatives', 'winmm.dll'), fakePe(2, 4096))
  writeFileSync(
    join(root, 'dlssg_sm86.ini'),
    '[General]\r\nEnabled=1\r\n\r\n[FrameGeneration]\r\nOptimized=1\r\nMaxGeneratedFrames=5\r\n'
  )
  writeFileSync(join(root, 'README.md'), '# DLSSG for SM86\n内嵌运行库 310.9，支持 6X。\n')
}

function makeGame(dir: string): { exeDir: string } {
  const exeDir = join(dir, 'b1', 'Binaries', 'Win64')
  mkdirSync(exeDir, { recursive: true })
  writeFileSync(join(exeDir, 'Game.exe'), 'fake exe')
  writeFileSync(join(exeDir, 'nvngx_dlssg.dll'), fakePe(9, 1024))
  writeFileSync(join(exeDir, 'version.dll'), Buffer.from('原始的游戏自带 version.dll'))
  return { exeDir }
}

function gameEntry(id: string, exeDir: string): GameEntry {
  const now = new Date().toISOString()
  return {
    id,
    name: '测试游戏',
    source: 'manual',
    exeDir,
    exeName: 'Game.exe',
    candidates: [],
    dlssgCapable: true,
    config: defaultIniConfig(),
    history: [],
    createdAt: now,
    updatedAt: now
  }
}

describe('ini 读写', () => {
  it('序列化后再解析回来保持一致', () => {
    const config = normalizeIniConfig(
      { ...defaultIniConfig(), maxGeneratedFrames: 3, preset: 'B', logLevel: 2, optimized: false, enabled: true },
      6
    )
    const text = serializeIniConfig(config, { runtimeMaxMultiplier: 6, runtimeVersion: '310.9' })
    assert.match(text, /Enabled=1/)
    assert.match(text, /Optimized=0/)
    assert.match(text, /MaxGeneratedFrames=3/)
    assert.match(text, /Preset=B/)
    assert.match(text, /Level=2/)
    const parsed = parseIniConfig(text)
    assert.equal(parsed.enabled, true)
    assert.equal(parsed.optimized, false)
    assert.equal(parsed.maxGeneratedFrames, 3)
    assert.equal(parsed.preset, 'B')
    assert.equal(parsed.logLevel, 2)
  })

  it('倍率会被运行库上限钳制', () => {
    const normalized = normalizeIniConfig({ ...defaultIniConfig(), maxGeneratedFrames: 5 }, 4)
    assert.equal(normalized.maxGeneratedFrames, 3)
  })

  it('自定义键会被透传并可以回读', () => {
    const config = normalizeIniConfig(
      { ...defaultIniConfig(), extra: [{ section: 'Diagnostics', key: 'Performance', value: '1' }] },
      6
    )
    const text = serializeIniConfig(config)
    assert.match(text, /\[Diagnostics\]/)
    assert.match(text, /Performance=1/)
    const parsed = parseIniConfig(text)
    assert.deepEqual(parsed.extra, [{ section: 'Diagnostics', key: 'Performance', value: '1' }])
  })
})

describe('运行库导入', () => {
  it('能从发布目录识别出版本与代理', async () => {
    const release = join(workRoot, 'release')
    makeRelease(release)
    const detections = await detectPackages(release)
    assert.equal(detections.length, 1)
    assert.equal(detections[0].runtimeVersion, '310.9')
    assert.equal(detections[0].proxies.length, 2)
  })

  it('导入后落盘并登记', async () => {
    ensureDataDirs()
    const release = join(workRoot, 'release')
    const result = await importFromFolder(release)
    assert.equal(result.packages.length, 1)
    const pkg = result.packages[0]
    assert.ok(existsSync(join(pkg.rootPath, 'version.dll')))
    const list = await listPackages()
    assert.ok(list.some((item) => item.id === pkg.id))
  })

  it('能从 ZIP 导入，一个包里的多个版本会各自成为运行库', async () => {
    const AdmZip = (await import('adm-zip')).default
    const repoRoot = join(workRoot, 'repo')
    makeRelease(repoRoot)
    makeRelease(join(repoRoot, '310.1'))
    const zip = new AdmZip()
    zip.addLocalFolder(repoRoot, '')
    const zipPath = join(workRoot, 'repo.zip')
    zip.writeZip(zipPath)

    const result = await importFromZip(zipPath)
    assert.equal(result.packages.length, 2)
    const legacy = result.packages.find((pkg) => pkg.name.includes('310.1'))
    assert.ok(legacy, '应该识别出 310.1 目录')
    assert.equal(legacy?.maxMultiplier, 4)
  })
})

describe('注入与还原', () => {
  let exeDir = ''
  let packageId = ''
  let gameId = 'test-game'

  before(async () => {
    const release = join(workRoot, 'release')
    makeRelease(release)
    ensureDataDirs()
    await importFromFolder(release)
    packageId = (await listPackages())[0].id
    const game = makeGame(join(workRoot, 'game'))
    exeDir = game.exeDir
    await saveGame(gameEntry(gameId, exeDir))
  })

  after(() => {
    rmSync(workRoot, { recursive: true, force: true })
  })

  it('预检查不报阻塞项', async () => {
    const game = (await listGames()).find((item) => item.id === gameId)!
    const plan = await planInstall({ gameId, packageId, proxyName: 'version.dll', config: game.config })
    assert.deepEqual(plan.blockers, [])
    assert.ok(plan.actions.some((action) => action.kind === 'copy-proxy'))
  })

  it('注入会备份原文件并写入 ini', async () => {
    const game = (await listGames()).find((item) => item.id === gameId)!
    const result = await applyInstall({
      gameId,
      packageId,
      proxyName: 'version.dll',
      config: { ...game.config, maxGeneratedFrames: 5, optimized: true }
    })
    assert.equal(result.ok, true, result.message)
    assert.ok(existsSync(join(exeDir, 'dlssg_sm86.ini')))
    assert.match(readFileSync(join(exeDir, 'dlssg_sm86.ini'), 'utf8'), /MaxGeneratedFrames=5/)
    const updated = (await listGames()).find((item) => item.id === gameId)!
    assert.ok(updated.install)
    assert.equal(updated.install?.proxyName, 'version.dll')
    const backup = updated.install?.files.find((file) => file.path.endsWith('version.dll'))
    assert.ok(backup?.backupPath && existsSync(backup.backupPath), '原 DLL 应该被备份')
    assert.equal(readFileSync(backup!.backupPath!, 'utf8'), '原始的游戏自带 version.dll')
  })

  it('状态识别为已注入', async () => {
    const game = (await listGames()).find((item) => item.id === gameId)!
    const status = await getGameStatus(game)
    assert.equal(status.state, 'installed')
    assert.equal(status.proxyName, 'version.dll')
  })

  it('只同步配置会更新 ini 与记录', async () => {
    const game = (await listGames()).find((item) => item.id === gameId)!
    const result = await updateIniOnly(gameId, { ...game.config, optimized: false, maxGeneratedFrames: 3 })
    assert.equal(result.ok, true, result.message)
    assert.match(readFileSync(join(exeDir, 'dlssg_sm86.ini'), 'utf8'), /Optimized=0/)
    const after = (await listGames()).find((item) => item.id === gameId)!
    assert.equal(after.install?.config.optimized, false)
    const status = await getGameStatus(after)
    assert.equal(status.state, 'installed', status.message)
  })

  it('文件被改动后拒绝还原，强制可以还原', async () => {
    writeFileSync(join(exeDir, 'version.dll'), '被手改过的 DLL')
    const game = (await listGames()).find((item) => item.id === gameId)!
    const denied = await restoreGame(gameId)
    assert.equal(denied.ok, false)
    const forced = await restoreGame(gameId, { force: true })
    assert.equal(forced.ok, true, forced.message)
    assert.equal(readFileSync(join(exeDir, 'version.dll'), 'utf8'), '原始的游戏自带 version.dll')
    assert.equal(existsSync(join(exeDir, 'dlssg_sm86.ini')), false)
    const after = (await listGames()).find((item) => item.id === gameId)!
    assert.equal(after.install, undefined)
  })
})

describe('游戏目录探测', () => {
  it('能按 nvngx_dlssg.dll 找到渲染目录', async () => {
    const { exeDir } = makeGame(join(workRoot, 'game2'))
    const candidates = await findCandidates(join(workRoot, 'game2'))
    assert.ok(candidates.length >= 1)
    assert.equal(candidates[0].hasDlssg, true)
    assert.equal(candidates[0].dir, exeDir)
    assert.equal(candidates[0].exeName, 'Game.exe')
  })
})
