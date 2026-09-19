import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

// 让核心模块把数据写到临时目录，避免碰到真实 AppData
const workRoot = mkdtempSync(join(tmpdir(), 'dlssg-gui-test-'))
process.env.DLSSG_GUI_DATA_DIR = join(workRoot, 'data')

const { defaultIniConfig, parseIniConfig, serializeIniConfig, normalizeIniConfig } = await import('../src/shared/ini-schema')
const { detectPackages, importFromFolder, importFromZip, downloadSources } = await import('../src/main/library')
const { applyInstall, getGameStatus, planInstall, restoreGame, updateIniOnly } = await import('../src/main/inject')
const { getPackage, listPackages, saveGame, listGames } = await import('../src/main/db')
const { findCandidates, detectGameFolder } = await import('../src/main/scan')
const { ensureDataDirs } = await import('../src/main/paths')
const { gitBlobSha, packagesFromTree } = await import('../src/main/upstream')
const { sameGame, findExactDuplicateGroups, findDuplicateGroups, listDuplicateGames, mergeDuplicateGames } = await import('../src/main/games')
const { getRefStatus, installReframework, uninstallReframework } = await import('../src/main/reframework')
const { scanCleanup, runCleanup, removeSupersededPackages, packageGroupKey } = await import('../src/main/cleanup')
const { packagesDir } = await import('../src/main/paths')
const AdmZipCtor = (await import('adm-zip')).default

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
      { ...defaultIniConfig(), maxGeneratedFrames: 3, preset: 'B', logLevel: 2, optimized: 0, enabled: true },
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
    assert.equal(parsed.optimized, 0)
    assert.equal(parsed.maxGeneratedFrames, 3)
    assert.equal(parsed.preset, 'B')
    assert.equal(parsed.logLevel, 2)
  })

  it('出厂默认是档位 1 与 4X（上游 0.3.1 起）', () => {
    const config = defaultIniConfig()
    assert.equal(config.optimized, 1)
    assert.equal(config.maxGeneratedFrames, 3)
  })

  it('档位 2 / 3 能写进去也能读回来', () => {
    for (const tier of [2, 3]) {
      const text = serializeIniConfig(normalizeIniConfig({ ...defaultIniConfig(), optimized: tier }, 6), { runtimeMaxMultiplier: 6 })
      assert.match(text, new RegExp(`Optimized=${tier}`))
      assert.equal(parseIniConfig(text).optimized, tier)
    }
  })

  it('兼容 0.3.2 之前的布尔写法与 310.1 的档位上限', () => {
    assert.equal(parseIniConfig('[FrameGeneration]\nOptimized=1\n').optimized, 1)
    assert.equal(parseIniConfig('[Compatibility]\nOptimizedKernels=1\n').optimized, 1)
    // 310.1 构建没有有损图像内核，档位被钳到 1
    assert.equal(normalizeIniConfig({ ...defaultIniConfig(), optimized: 3 }, 4, false).optimized, 1)
  })

  it('三态键留空时不写进文件', () => {
    const config = normalizeIniConfig(
      {
        ...defaultIniConfig(),
        extra: [
          { section: 'Compatibility', key: 'SpoofArchToGame', value: '' },
          { section: 'Compatibility', key: 'Router', value: 'SM75' }
        ]
      },
      6
    )
    const text = serializeIniConfig(config)
    assert.doesNotMatch(text, /SpoofArchToGame/)
    assert.match(text, /Router=SM75/)
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

describe('重复条目与合并', () => {
  const root = join(workRoot, 'dup-game')
  let packageId = ''

  before(async () => {
    ensureDataDirs()
    await importFromFolder(join(workRoot, 'release'))
    packageId = (await listPackages())[0].id
  })

  it('同目录判定：严格只认完全相同的目录，宽松还认父子目录', () => {
    const make = (id: string, exeDir: string, installDir?: string): GameEntry => ({
      ...gameEntry(id, exeDir),
      installDir
    })
    const a = make('a', join(root, 'b1', 'Binaries', 'Win64'), root)
    const b = make('b', join(root, 'b1', 'Binaries', 'Win64'))
    const child = make('c', join(root, 'b1', 'Binaries', 'Win64', 'sub'))
    const other = make('d', join(workRoot, 'another-game'))

    assert.equal(sameGame(a, b, true), true, '渲染目录相同算重复')
    assert.equal(sameGame(a, b, false), true)
    assert.equal(sameGame(b, child, true), false, '父子目录在严格模式下不算重复')
    assert.equal(sameGame(b, child, false), true)
    assert.equal(sameGame(b, other, false), false)

    assert.equal(findExactDuplicateGroups([a, b, other]).length, 1)
    assert.equal(findDuplicateGroups([b, child]).length, 1)
  })

  it('合并后只留一条，注入记录和备份都跟着走，还能正常还原', async () => {
    const { exeDir } = makeGame(root)
    const keeper = gameEntry('dup-keeper', exeDir)
    keeper.installDir = root
    await saveGame(keeper)

    const installed = await applyInstall({
      gameId: keeper.id,
      packageId,
      proxyName: 'version.dll',
      config: keeper.config
    })
    assert.equal(installed.ok, true, installed.message)

    // 模拟旧版本留下的重复条目：同一个游戏目录又加了一条，配置还不一样
    const duplicate = gameEntry('dup-second', exeDir)
    duplicate.installDir = root
    duplicate.config = { ...duplicate.config, optimized: 3, maxGeneratedFrames: 5 }
    duplicate.dlssgCapable = false
    await saveGame(duplicate)

    const report = await listDuplicateGames()
    assert.equal(report.groups.length, 1)
    assert.equal(report.entries, 2)

    const merged = await mergeDuplicateGames()
    assert.equal(merged.mergedGroups, 1)
    assert.equal(merged.removedEntries, 1)

    const remaining = (await listGames()).filter((game) => game.installDir === root)
    assert.equal(remaining.length, 1, '合并后同一个游戏只剩一条')
    const survivor = remaining[0]
    assert.ok(survivor.install, '注入记录要保留下来')
    assert.equal(survivor.install?.proxyName, 'version.dll')
    assert.ok(
      survivor.history.some((entry) => entry.message.includes('合并')),
      '历史里应该有合并记录'
    )
    assert.equal(await listDuplicateGames().then((item) => item.entries), 0)

    // 备份目录被搬到了保留条目下，仍然可以还原成注入前的样子
    const restored = await restoreGame(survivor.id)
    assert.equal(restored.ok, true, restored.message)
    assert.equal(readFileSync(join(exeDir, 'version.dll'), 'utf8'), '原始的游戏自带 version.dll')
    assert.equal(existsSync(join(exeDir, 'dlssg_sm86.ini')), false)
  })
})

describe('REFramework（卡普空 RE Engine）', () => {
  const root = join(workRoot, 'capcom-game')
  const refZip = join(workRoot, 'ref-fake.zip')

  before(() => {
    // 假一个 RE Engine 游戏：re_chunk_000.pak + 一个已经存在的 dinput8.dll（会被覆盖，需备份）
    mkdirSync(join(root, 'dlc'), { recursive: true })
    writeFileSync(join(root, 'PRAGMATA.exe'), 'game exe')
    writeFileSync(join(root, 're_chunk_000.pak'), Buffer.alloc(1024, 9))
    writeFileSync(join(root, 'dlc', 're_dlc_stm_123.pak'), Buffer.alloc(128, 8))
    writeFileSync(join(root, 'dinput8.dll'), '别人装过的 dinput8')

    // 假一个 REFramework 压缩包：dinput8.dll + reframework\plugins\...
    const AdmZip = AdmZipCtor
    const zip = new AdmZip()
    zip.addFile('dinput8.dll', Buffer.from('REFramework loader'))
    zip.addFile('reframework/plugins/example.txt', Buffer.from('plugin placeholder'))
    zip.addFile('reframework/data/version.txt', Buffer.from('nightly-fake'))
    zip.writeZip(refZip)
  })

  it('能认出 RE Engine 游戏（re_chunk/re_dlc 特征文件）', async () => {
    const game: GameEntry = { ...gameEntry('capcom', root), installDir: root, exeName: 'PRAGMATA.exe' }
    await saveGame(game)
    const status = await getRefStatus(game.id)
    assert.equal(status.reEngine, true)
    assert.match(status.engineEvidence ?? '', /^re_chunk_000\.pak$/)
    assert.equal(status.installed, false)
    assert.equal(status.hasRefFiles, true, 'dinput8.dll 已经存在，应该能看出来')
  })

  it('普通游戏不会被当成 RE Engine', async () => {
    const other = join(workRoot, 'normal-game')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'Game.exe'), 'x')
    await saveGame({ ...gameEntry('normal', other), installDir: other })
    const status = await getRefStatus('normal')
    assert.equal(status.reEngine, false)
  })

  it('安装会把压缩包内容写进游戏目录，覆盖的文件先备份', async () => {
    const result = await installReframework('capcom', { zipPath: refZip })
    assert.equal(result.ok, true, result.message)
    assert.equal(readFileSync(join(root, 'dinput8.dll'), 'utf8'), 'REFramework loader', 'dinput8.dll 应该被换成 REF 的')
    assert.equal(existsSync(join(root, 'reframework', 'plugins', 'example.txt')), true)
    assert.equal(existsSync(join(root, 'reframework', 'data', 'version.txt')), true)
    assert.equal(result.record?.files.length, 3)
    const replaced = result.record?.files.find((file) => file.path.endsWith('dinput8.dll'))
    assert.equal(replaced?.action, 'replaced')
    assert.ok(replaced?.backupPath && existsSync(replaced.backupPath), '原来的 dinput8.dll 要备份下来')
    assert.equal(readFileSync(replaced!.backupPath!, 'utf8'), '别人装过的 dinput8')

    const status = await getRefStatus('capcom')
    assert.equal(status.installed, true)
    assert.equal(status.record?.tag, '本地包')
  })

  it('卸载会删掉新建的文件、还原被覆盖的文件，并清掉空的 reframework 目录', async () => {
    const result = await uninstallReframework('capcom')
    assert.equal(result.ok, true, result.message)
    assert.equal(readFileSync(join(root, 'dinput8.dll'), 'utf8'), '别人装过的 dinput8', 'dinput8.dll 要还原成原来的')
    assert.equal(existsSync(join(root, 'reframework')), false, '空的 reframework 目录要清掉')
    const status = await getRefStatus('capcom')
    assert.equal(status.installed, false)
  })
})

describe('下载进度', () => {
  it('按字节持续上报进度，并带上总体比例与结束标记', async () => {
    const { createServer } = await import('node:http')
    const total = 8 * 1024 * 1024
    const chunk = Buffer.alloc(128 * 1024, 7)
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(total) })
      let sent = 0
      const timer = setInterval(() => {
        if (sent >= total) {
          clearInterval(timer)
          response.end()
          return
        }
        response.write(chunk)
        sent += chunk.length
      }, 25)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as { port: number }).port
    const dest = join(workRoot, 'progress-test.bin')
    const events: { received?: number; totalBytes?: number; overall?: number; finished?: boolean }[] = []
    try {
      await downloadSources(
        [{ kind: 'raw', url: `http://127.0.0.1:${port}/big.bin` }],
        dest,
        '测试下载',
        (event) => events.push(event),
        0,
        1,
        total
      )
    } finally {
      server.close()
    }

    assert.ok(events.length >= 3, `应该多次上报进度，实际只上报 ${events.length} 次`)
    const bytes = events.map((event) => event.received).filter((value): value is number => typeof value === 'number')
    assert.ok(bytes.length >= 3, '每次上报都应该带字节数')
    assert.ok(bytes[bytes.length - 1] >= total * 0.99, `最后一次应接近总大小，实际 ${bytes[bytes.length - 1]}`)
    for (let index = 1; index < bytes.length; index += 1) {
      assert.ok(bytes[index] >= bytes[index - 1], '字节数应该单调递增')
    }
    assert.ok(
      events.some((event) => (event.overall ?? 0) > 0.3 && (event.overall ?? 0) < 0.95),
      '中途应该有 0–1 之间的总体比例，界面才能显示真实百分比'
    )
    assert.equal(events[events.length - 1].finished, true, '最后一个事件应带结束标记')
    assert.equal(statSync(dest).size, total, '文件应该完整落盘')
  })
})

describe('数据目录清理', () => {
  it('找出孤立目录与被取代的旧包，但不碰有游戏在用的包', async () => {
    ensureDataDirs()
    // 造两个同名的包：先 A 再 B（内容不同 → 不同 id）
    const release = join(workRoot, 'cleanup-release')
    makeRelease(release)
    const pkgA = (await importFromFolder(release)).packages[0]
    writeFileSync(join(release, 'version.dll'), fakePe(99, 4096))
    const pkgB = (await importFromFolder(release)).packages[0]
    assert.notEqual(pkgA.id, pkgB.id, '内容不同应该是两个包')
    assert.equal(packageGroupKey(pkgA), packageGroupKey(pkgB), '同来源应该分到同一组')

    // 孤立目录（有文件夹但没登记）
    const orphan = join(packagesDir(), 'orphan-folder')
    mkdirSync(orphan, { recursive: true })
    writeFileSync(join(orphan, 'leftover.dll'), Buffer.alloc(2048, 3))

    const report = await scanCleanup()
    const superseded = report.items.find((item) => item.kind === 'superseded' && item.packageId === pkgA.id)
    assert.ok(superseded, '旧的那个包应该被列出来')
    assert.ok(
      report.items.some((item) => item.kind === 'orphan' && item.path === orphan),
      '孤立目录应该被列出来'
    )
    assert.ok(!report.items.some((item) => item.packageId === pkgB.id), '最新的包不该被列出来')
    assert.ok(report.totalSize > 0)

    // 让一个游戏用上旧的包 → 就不该再列出来了
    const now = new Date().toISOString()
    const gameDir = join(workRoot, 'cleanup-game')
    mkdirSync(gameDir, { recursive: true })
    await saveGame({
      ...gameEntry('cleanup-game', gameDir),
      install: {
        installedAt: now,
        packageId: pkgA.id,
        packageName: pkgA.name,
        runtimeVersion: '310.9',
        proxyName: 'version.dll',
        backupDir: join(workRoot, 'fake-backup'),
        files: [],
        config: defaultIniConfig(),
        appVersion: 'test'
      }
    })
    const second = await scanCleanup()
    assert.ok(
      !second.items.some((item) => item.packageId === pkgA.id),
      '有游戏在用的包不能被列进清理清单'
    )
    assert.ok(second.items.some((item) => item.kind === 'orphan' && item.path === orphan))

    // 执行清理：只删清单里的
    const result = await runCleanup(second.items.map((item) => item.path))
    assert.ok(result.removed >= 1)
    assert.equal(existsSync(orphan), false, '孤立目录应该被删掉')
    assert.ok(existsSync(pkgA.rootPath), '正在用的包必须还在')
    assert.ok((await listPackages()).some((pkg) => pkg.id === pkgA.id))
  })

  it('更新时自动替换：删掉同来源的旧包，有游戏在用就保留', async () => {
    // 用不同的版本目录，避免和上一个用例的包名混在同一组
    const base = join(workRoot, 'cleanup-release2')
    const release = join(base, '310.7')
    makeRelease(release)
    const oldPkg = (await importFromFolder(base)).packages[0]
    writeFileSync(join(release, 'version.dll'), fakePe(123, 4096))
    const newPkg = (await importFromFolder(base)).packages[0]
    assert.notEqual(oldPkg.id, newPkg.id)

    const removed = await removeSupersededPackages(newPkg)
    assert.deepEqual(removed, [oldPkg.name], `应该删掉旧包，实际 ${JSON.stringify(removed)}`)
    assert.ok(!(await listPackages()).some((pkg) => pkg.id === oldPkg.id), '旧包记录也要没了')

    // 有游戏在用时不删
    const third = (await importFromFolder(base)).packages[0]
    writeFileSync(join(release, 'version.dll'), fakePe(200, 4096))
    const fourth = (await importFromFolder(base)).packages[0]
    const game = (await listGames()).find((item) => item.id === 'cleanup-game')!
    game.install = { ...game.install!, packageId: third.id }
    await saveGame(game)
    const kept = await removeSupersededPackages(fourth)
    assert.deepEqual(kept, [], '有游戏在用的包不能被自动删掉')
    assert.ok((await listPackages()).some((pkg) => pkg.id === third.id))
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
    const result = await updateIniOnly(gameId, { ...game.config, optimized: 2, maxGeneratedFrames: 3 })
    assert.equal(result.ok, true, result.message)
    assert.match(readFileSync(join(exeDir, 'dlssg_sm86.ini'), 'utf8'), /Optimized=2/)
    const after = (await listGames()).find((item) => item.id === gameId)!
    assert.equal(after.install?.config.optimized, 2)
    const status = await getGameStatus(after)
    assert.equal(status.state, 'installed', status.message)
  })

  it('同目录有别的代理只提示、不再阻塞（上游 0.3.x 行为）', async () => {
    writeFileSync(join(exeDir, 'winmm.dll'), fakePe(7, 2048))
    const game = (await listGames()).find((item) => item.id === gameId)!
    const plan = await planInstall({ gameId, packageId, proxyName: 'version.dll', config: game.config })
    assert.deepEqual(plan.blockers, [])
    assert.ok(
      plan.warnings.some((item) => item.includes('winmm.dll')),
      '应该提示目录里还有其它代理'
    )
    rmSync(join(exeDir, 'winmm.dll'), { force: true })
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

  // 《光与影：33 号远征队》这类 UE 游戏：DLSS 整套在 Plugins 深处的 ThirdParty 目录（8 层），
  // 渲染 EXE 却在 <项目>\Binaries\Win64。旧版只扫 4 层，会把这种游戏判成"不支持帧生成"。
  it('UE 布局：DLSS 在 8 层深的 Plugins 里，也要认出游戏支持帧生成并选对渲染目录', async () => {
    const root = join(workRoot, 'ue-game')
    const win64 = join(root, 'Sandfall', 'Binaries', 'Win64')
    const streamline = join(root, 'Sandfall', 'Plugins', 'NVIDIA', 'StreamlineCore', 'Binaries', 'ThirdParty', 'Win64')
    const dlssPlugin = join(root, 'Sandfall', 'Plugins', 'NVIDIA', 'DLSS', 'Binaries', 'ThirdParty', 'Win64')
    mkdirSync(win64, { recursive: true })
    mkdirSync(streamline, { recursive: true })
    mkdirSync(dlssPlugin, { recursive: true })
    writeFileSync(join(root, 'Expedition33_Steam.exe'), 'launcher')
    writeFileSync(join(win64, 'SandFall-Win64-Shipping.exe'), Buffer.alloc(4096, 7))
    writeFileSync(join(win64, 'amd_fidelityfx_framegeneration_dx12.dll'), 'fsr fg')
    writeFileSync(join(streamline, 'nvngx_dlssg.dll'), fakePe(21, 2048))
    writeFileSync(join(streamline, 'sl.dlss_g.dll'), 'streamline fg plugin')
    writeFileSync(join(streamline, 'sl.common.dll'), 'streamline common')
    writeFileSync(join(dlssPlugin, 'nvngx_dlss.dll'), fakePe(22, 2048))

    const detection = await detectGameFolder(root)
    assert.equal(detection.dlssgCapable, true, '深度 8 的 nvngx_dlssg.dll 也要被认出来')
    assert.equal(detection.exeDir, win64, '部署目标是渲染 EXE 目录，不是插件目录')
    assert.equal(detection.exeName, 'SandFall-Win64-Shipping.exe')
    assert.equal(detection.candidates[0].recommended, true)
    assert.equal(detection.candidates[0].hasFsrFrameGen, true)
  })

  it('Unity 布局：根目录有 nvngx_dlss.dll 时，不会被更大的 Launcher 子目录抢走', async () => {
    const root = join(workRoot, 'unity-game')
    mkdirSync(join(root, 'Launcher'), { recursive: true })
    writeFileSync(join(root, 'Cities2.exe'), Buffer.alloc(512, 1))
    writeFileSync(join(root, 'UnityCrashHandler64.exe'), 'crash handler')
    writeFileSync(join(root, 'nvngx_dlss.dll'), fakePe(31, 2048))
    writeFileSync(join(root, 'Launcher', 'dowser.exe'), Buffer.alloc(200000, 3))
    writeFileSync(join(root, 'Launcher', 'launcher-installer-windows.exe'), Buffer.alloc(400000, 4))

    const detection = await detectGameFolder(root)
    assert.equal(detection.exeDir, root)
    assert.equal(detection.exeName, 'Cities2.exe')
    assert.equal(detection.dlssgCapable, false)
    assert.equal(detection.candidates[0].hasDlss, true)
  })
})

describe('上游发现', () => {
  it('gitBlobSha 与 git 的 blob 哈希一致', () => {
    assert.equal(gitBlobSha(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a')
  })

  it('能从仓库树里找出所有发布包并推断版本与代理', () => {
    const blob = (path: string, size: number): { path: string; type: 'blob'; size: number; sha: string } => ({
      path,
      type: 'blob',
      size,
      sha: `sha-${path}`
    })
    const tree = [
      blob('version.dll', 30_011_168),
      blob('dlssg_sm86.ini', 3166),
      blob('README.md', 7293),
      blob('alternatives/winmm.dll', 30_022_432),
      blob('alternatives/d3d12.dll', 30_011_168),
      blob('alternatives/README.md', 2351),
      blob('310.1/version.dll', 27_986_208),
      blob('310.1/alternatives/winmm.dll', 27_997_472),
      blob('archive/0.2.4/version.dll', 15_667_520),
      blob('archive/0.2.4/altnative/winmm.dll', 15_678_272),
      blob('archive/0.2.4/dlssg_sm86.ini', 581)
    ]

    const packages = packagesFromTree(tree, '0.3.4')
    assert.deepEqual(
      packages.map((item) => item.path),
      ['', '310.1', 'archive/0.2.4']
    )

    const root = packages[0]
    assert.equal(root.runtimeVersion, '310.9')
    assert.equal(root.maxMultiplier, 6)
    assert.equal(root.versionSize, 30_011_168)
    assert.equal(root.proxies.length, 3)
    assert.equal(root.iniPath, 'dlssg_sm86.ini')
    assert.match(root.label, /0\.3\.4/)

    const legacy = packages[1]
    assert.equal(legacy.runtimeVersion, '310.1')
    assert.equal(legacy.maxMultiplier, 4)
    // 310.1 目录里没有 ini，回退到仓库根目录那份
    assert.equal(legacy.iniPath, 'dlssg_sm86.ini')

    const archived = packages[2]
    assert.equal(archived.runtimeVersion, '0.2.4')
    assert.equal(archived.proxies.length, 2)
    assert.equal(archived.iniPath, 'archive/0.2.4/dlssg_sm86.ini')
  })
})
