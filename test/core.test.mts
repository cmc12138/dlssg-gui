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
const { gitBlobSha, packagesFromTree } = await import('../src/main/upstream')
const { sameGame, findExactDuplicateGroups, findDuplicateGroups, listDuplicateGames, mergeDuplicateGames } = await import('../src/main/games')

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
