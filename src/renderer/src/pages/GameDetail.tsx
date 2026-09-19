import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { RISKY_PROXIES, type GameLogFile, type IniConfig, type InstallPlan, type LogReadResult, type RefReleaseInfo, type RefStatus } from '@shared/types'
import {
  INI_OPTIONAL_SPECS,
  OPTIMIZED_TIERS,
  defaultIniConfig,
  findSpec,
  maxMultiplierForFrames,
  normalizeIniConfig,
  serializeIniConfig
} from '@shared/ini-schema'
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Modal,
  NumberInput,
  ProgressBar,
  Select,
  Spinner,
  Tabs,
  TextInput,
  Toggle
} from '../components/ui'
import { useApp } from '../state'
import { STATE_LABEL, STATE_TONE, formatTime, humanSize, truncateMiddle } from '../lib/format'

type Tab = 'config' | 'files' | 'logs' | 'advanced'

export function GameDetail({ gameId, onBack, onGoLibrary }: { gameId: string; onBack: () => void; onGoLibrary: () => void }): JSX.Element {
  const app = useApp()
  const game = app.games.find((item) => item.id === gameId)
  const [tab, setTab] = useState<Tab>('config')
  const [packageId, setPackageId] = useState<string>('')
  const [proxyName, setProxyName] = useState<string>('version.dll')
  const [config, setConfig] = useState<IniConfig>(defaultIniConfig())
  const [advanced, setAdvanced] = useState(false)
  const [plan, setPlan] = useState<InstallPlan>()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(app.statuses[gameId])
  const [backups, setBackups] = useState<{ dir: string; createdAt: string; files: { name: string; size: number }[] }[]>([])
  const [logs, setLogs] = useState<GameLogFile[]>([])
  const [logView, setLogView] = useState<LogReadResult>()
  const [confirmForce, setConfirmForce] = useState(false)
  const [confirmRestore, setConfirmRestore] = useState(false)
  const [restoreForce, setRestoreForce] = useState(false)
  const [removeLogs, setRemoveLogs] = useState(true)
  const [dirDraft, setDirDraft] = useState('')
  const [catalogPick, setCatalogPick] = useState('')
  const [refStatus, setRefStatus] = useState<RefStatus>()
  const [refLatest, setRefLatest] = useState<RefReleaseInfo>()
  const [refBusy, setRefBusy] = useState(false)

  const refreshRef = useCallback(async (): Promise<void> => {
    try {
      const status = await window.api.refStatus(gameId)
      setRefStatus(status)
      if (status.reEngine) {
        void window.api.refLatest(gameId).then((latest) => setRefLatest(latest ?? undefined))
      }
    } catch {
      /* 忽略 */
    }
  }, [gameId])

  useEffect(() => {
    void refreshRef()
  }, [refreshRef])

  const installRef = useCallback(
    async (zipPath?: string): Promise<void> => {
      setRefBusy(true)
      try {
        const result = await window.api.refInstall(gameId, zipPath)
        app.notify(result.message, result.ok ? 'ok' : 'bad')
        await refreshRef()
      } catch (error) {
        app.notify(`安装失败：${(error as Error).message}`, 'bad')
      } finally {
        setRefBusy(false)
      }
    },
    [app, gameId, refreshRef]
  )

  const selectedPackage = app.packages.find((item) => item.id === packageId)

  const catalogOptions = useMemo(
    () =>
      INI_OPTIONAL_SPECS.filter(
        (spec) => !config.extra.some((item) => item.section === spec.section && item.key === spec.key)
      ),
    [config.extra]
  )

  const addCatalogKey = useCallback(() => {
    if (!catalogPick) return
    const spec = INI_OPTIONAL_SPECS.find((item) => `${item.section}\u0000${item.key}` === catalogPick)
    if (!spec) return
    // 三态键显式添加时默认写 1（要「不写」就把它设成「不写」或移除）
    const value = spec.type === 'tristate' ? '1' : spec.default
    setConfig((current) => ({ ...current, extra: [...current.extra, { section: spec.section, key: spec.key, value }] }))
    setCatalogPick('')
  }, [catalogPick])

  useEffect(() => {
    if (!game) return
    setPackageId(game.install?.packageId ?? app.settings?.defaultPackageId ?? app.packages[0]?.id ?? '')
    setProxyName(game.install?.proxyName ?? app.settings?.defaultProxy ?? 'version.dll')
    setConfig(game.install?.config ?? game.config ?? defaultIniConfig())
    setDirDraft(game.exeDir)
  }, [gameId, game, app.settings?.defaultPackageId, app.settings?.defaultProxy, app.packages])

  const refreshStatus = useCallback(async () => {
    if (!game) return
    try {
      const next = await window.api.gameStatus(gameId, true)
      setStatus(next)
    } catch {
      /* 忽略 */
    }
  }, [game, gameId])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    if (tab !== 'files') return
    void window.api.listBackups(gameId).then(setBackups).catch(() => setBackups([]))
  }, [tab, gameId, status?.state])

  useEffect(() => {
    if (tab !== 'logs') return
    void window.api.listGameLogs(gameId).then(setLogs).catch(() => setLogs([]))
  }, [tab, gameId])

  const normalized = useMemo(
    () => normalizeIniConfig(config, selectedPackage?.maxMultiplier ?? 6),
    [config, selectedPackage?.maxMultiplier]
  )

  const preview = useMemo(
    () =>
      serializeIniConfig(normalized, {
        runtimeMaxMultiplier: selectedPackage?.maxMultiplier ?? 6,
        runtimeVersion: selectedPackage?.runtimeVersion ?? '未知',
        generator: '由 DLSSG GUI 生成（预览）'
      }),
    [normalized, selectedPackage?.maxMultiplier, selectedPackage?.runtimeVersion]
  )

  const payload = useMemo(
    () => ({
      gameId,
      packageId,
      proxyName,
      config: normalized,
      exeDir: game?.exeDir,
      exeName: game?.exeName,
      launchExe: game?.launchExe
    }),
    [gameId, packageId, proxyName, normalized, game?.exeDir, game?.exeName, game?.launchExe]
  )

  const doPlan = useCallback(async () => {
    if (!packageId) return
    try {
      setPlan(await window.api.planInstall(payload))
    } catch (error) {
      app.notify(`预检查失败：${(error as Error).message}`, 'bad')
    }
  }, [app, packageId, payload])

  useEffect(() => {
    if (tab !== 'config' || !packageId) return
    void doPlan()
  }, [tab, packageId, proxyName, normalized, doPlan])

  if (!game) {
    return (
      <div className="page">
        <Button onClick={onBack}>返回</Button>
        <EmptyState title="没有找到这个游戏条目" />
      </div>
    )
  }

  const state = status?.state ?? 'not-installed'
  const installed = Boolean(game.install)

  const runInstall = async (force: boolean): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.api.applyInstall({ ...payload, force })
      if (result.ok) {
        app.notify(result.message, 'ok')
        await app.refreshGames()
        await app.refreshStatuses([gameId])
        await refreshStatus()
      } else {
        app.notify(result.message, 'bad')
      }
    } catch (error) {
      app.notify(`注入失败：${(error as Error).message}`, 'bad')
    } finally {
      setBusy(false)
      setConfirmForce(false)
      void doPlan()
    }
  }

  const runSyncIni = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.api.updateGameIni(gameId, normalized)
      app.notify(result.message, result.ok ? 'ok' : 'bad')
      await refreshStatus()
    } finally {
      setBusy(false)
    }
  }

  const runRestore = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.api.restoreGame(gameId, { force: restoreForce, removeLogs })
      app.notify(result.ok ? `还原完成：\n${result.message}` : result.message, result.ok ? 'ok' : 'bad')
      await app.refreshGames()
      await app.refreshStatuses([gameId])
      await refreshStatus()
    } finally {
      setBusy(false)
      setConfirmRestore(false)
      setRestoreForce(false)
    }
  }

  const updateConfig = (patch: Partial<IniConfig>): void => setConfig((current) => ({ ...current, ...patch }))

  const saveGameField = async (patch: Parameters<typeof window.api.updateGame>[1]): Promise<void> => {
    const next = await window.api.updateGame(gameId, patch)
    await app.refreshGames()
    setStatus(await window.api.gameStatus(next.id, true))
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <Button variant="ghost" size="sm" onClick={onBack}>
            ← 返回列表
          </Button>
          <h2>{game.name}</h2>
          <div className="row wrap">
            <Badge tone={STATE_TONE[state] ?? 'muted'}>{STATE_LABEL[state] ?? state}</Badge>
            {game.install && <Badge tone="info">{game.install.packageName}</Badge>}
            {status?.running && <Badge tone="warn">游戏正在运行</Badge>}
            {game.dlssgCapable ? <Badge tone="ok">支持 DLSS 帧生成</Badge> : <Badge tone="muted">未检测到 DLSS-G</Badge>}
          </div>
        </div>
        <div className="row">
          <Button onClick={() => void window.api.openPath(game.exeDir)}>打开目录</Button>
          <Button onClick={() => void window.api.launchGame(gameId)} disabled={!game.exeName}>
            启动游戏
          </Button>
          <Button variant="ghost" onClick={() => void refreshStatus()}>
            刷新状态
          </Button>
        </div>
      </header>

      {status?.message && <Alert tone={state === 'conflict' || state === 'partial' ? 'warn' : 'info'}>{status.message}</Alert>}
      {status?.logSummary && installed && (
        <Alert tone={status.logSummary.proxyRedirect ? 'ok' : 'info'} title="上次运行日志摘要">
          日志文件 {status.logSummary.files} 个 · 最后写入 {formatTime(status.logSummary.lastWrite)} · 代理重定向{' '}
          {status.logSummary.proxyRedirect ? '已生效' : '未发现'} · 路由 {status.logSummary.routeActive ? 'active' : '未发现'}
          {status.logSummary.errors.length > 0 && ` · 错误 ${status.logSummary.errors.length} 条（见「日志」页）`}
        </Alert>
      )}
      {!game.exeName && <Alert tone="warn">还没有确定渲染 EXE，注入前请在下方指定渲染 EXE 目录与文件名。</Alert>}

      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: 'config', label: '注入配置' },
          { value: 'files', label: '文件与备份' },
          { value: 'logs', label: '日志' },
          { value: 'advanced', label: '高级' }
        ]}
      />

      {tab === 'config' && (
        <div className="stack">
          <Card title="注入目标" subtitle="把代理 DLL 与 dlssg_sm86.ini 放进渲染 EXE 所在目录">
            <div className="stack">
              <Field label="渲染 EXE 目录" hint="例如《黑神话：悟空》是 …\b1\Binaries\Win64">
                <div className="row">
                  <TextInput value={dirDraft} onChange={setDirDraft} />
                  <Button
                    onClick={async () => {
                      const folder = await window.api.pickFolder('选择渲染 EXE 目录')
                      if (folder) setDirDraft(folder)
                    }}
                  >
                    浏览
                  </Button>
                  <Button disabled={dirDraft === game.exeDir || !dirDraft} onClick={() => void saveGameField({ exeDir: dirDraft })}>
                    保存
                  </Button>
                </div>
              </Field>
              {game.candidates.length > 1 && (
                <Field label="检测到的候选目录">
                  <Select
                    value={game.exeDir}
                    onChange={(value) => {
                      const candidate = game.candidates.find((item) => item.dir === value)
                      void saveGameField({ exeDir: value, exeName: candidate?.exeName ?? game.exeName })
                      setDirDraft(value)
                    }}
                    options={game.candidates.map((candidate) => ({
                      value: candidate.dir,
                      label: `${candidate.recommended ? '★ ' : ''}${truncateMiddle(candidate.dir, 60)}${
                        candidate.exeName ? ` (${candidate.exeName})` : ''
                      }${candidate.hasFsrFrameGen ? ' · 含 FSR 帧生成' : ''}`
                    }))}
                  />
                </Field>
              )}
              <Field label="渲染 EXE 文件名" hint="用来判断游戏是否在运行">
                <div className="row">
                  <TextInput value={game.exeName} onChange={(value) => void saveGameField({ exeName: value })} />
                  <Button
                    onClick={async () => {
                      const file = await window.api.pickFile({ name: '可执行文件', extensions: ['exe'] })
                      if (file) await saveGameField({ exeName: file.split('\\').pop() ?? '' })
                    }}
                  >
                    选择 EXE
                  </Button>
                </div>
              </Field>
            </div>
          </Card>

          {(refStatus?.reEngine || refStatus?.installed || refStatus?.hasRefFiles) && (
            <Card
              title="卡普空 RE Engine：先装 REFramework"
              tone={refStatus?.reEngine && !refStatus?.installed ? 'warn' : 'default'}
              subtitle={
                refStatus?.reEngine
                  ? `检测到 RE Engine 特征文件（${refStatus.engineEvidence ?? 're_*.pak'}）：不装 REFramework 的话，代理 DLL 一加载游戏就直接崩在启动`
                  : '这个目录里有 REFramework 的痕迹'
              }
              actions={
                <Button size="sm" variant="ghost" onClick={() => void window.api.openExternal('https://github.com/praydog/REFramework-nightly/releases')}>
                  打开 REFramework 下载页
                </Button>
              }
            >
              <div className="stack">
                {refStatus?.installed && refStatus.record ? (
                  <Alert tone="ok" title={`已安装：${refStatus.record.tag}`}>
                    <div className="small">
                      安装于 {formatTime(refStatus.record.installedAt)} · {refStatus.record.files.length} 个文件 · 目标{' '}
                      <span className="mono">{refStatus.record.targetDir}</span>
                    </div>
                    <div className="row" style={{ marginTop: 8 }}>
                      <Button size="sm" onClick={() => void installRef()} disabled={refBusy}>
                        {refBusy ? '处理中…' : '重新下载安装最新版'}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={async () => {
                          setRefBusy(true)
                          try {
                            const result = await window.api.refRemove(gameId)
                            app.notify(result.message, result.ok ? 'ok' : 'bad')
                            await refreshRef()
                          } finally {
                            setRefBusy(false)
                          }
                        }}
                        disabled={refBusy}
                      >
                        卸载 REFramework
                      </Button>
                    </div>
                  </Alert>
                ) : (
                  <>
                    <Alert tone="warn" title="为什么必须装">
                      新一代卡普空游戏（RE Engine）会拒绝加载游戏目录里它不认识的 DLL，只放 <span className="mono">version.dll</span>{' '}
                      会直接报错/崩在启动，而且换 <span className="mono">dxgi.dll</span>/<span className="mono">winmm.dll</span> 也一样。
                      REFramework 是这些游戏放行的加载入口。上游 issue #77 / #40 / #560 都是这个问题，社区确认的做法就是先装它。
                    </Alert>
                    <ol className="list ordered">
                      <li>点下面的按钮，把最新 REFramework 装到游戏根目录（约 13MB；装进去的是 dinput8.dll 和一个版本说明文件）</li>
                      <li>启动一次游戏让它加载框架（这时游戏目录里会生成 reframework\ 文件夹），然后完全退出</li>
                      <li>回到上面的「执行」重新注入代理 DLL，之后游戏里就能开 DLSS 帧生成</li>
                    </ol>
                    <p className="muted small">
                      官方下载通道（github.com / release-assets.githubusercontent.com）在部分网络下连不上，本工具会自动换镜像重试；
                      都不行时请在能上网的机器上下载 REFramework.zip，再用「用本地 ZIP 安装」。
                    </p>
                    <div className="row">
                      <Button variant="primary" onClick={() => void installRef()} disabled={refBusy}>
                        {refBusy ? '下载安装中…' : '下载并安装 REFramework'}
                      </Button>
                      <Button
                        onClick={async () => {
                          const file = await window.api.pickFile({ name: 'REFramework 压缩包', extensions: ['zip'] })
                          if (file) void installRef(file)
                        }}
                        disabled={refBusy}
                      >
                        用本地 ZIP 安装
                      </Button>
                      {refLatest && !refBusy && (
                        <span className="muted small">
                          最新：{refLatest.tag}（{(refLatest.size / 1024 / 1024).toFixed(1)} MB，{formatTime(refLatest.publishedAt)}）
                        </span>
                      )}
                    </div>
                    {refBusy && app.progress && (app.progress.scope === 'download' || app.progress.scope === 'import') && (
                      <div className="stack">
                        <ProgressBar
                          done={app.progress.done}
                          total={app.progress.total}
                          label={`${app.progress.label}${
                            app.progress.received !== undefined && app.progress.totalBytes
                              ? ` · ${humanSize(app.progress.received)} / ${humanSize(app.progress.totalBytes)}`
                              : ''
                          }`}
                        />
                      </div>
                    )}
                  </>
                )}
              </div>
            </Card>
          )}

          <Card
            title="运行库与代理"
            subtitle="运行库决定能开多大倍率；代理是进入游戏进程的方式，同一目录只能放一个"
            actions={
              <Button size="sm" variant="ghost" onClick={onGoLibrary}>
                管理运行库
              </Button>
            }
          >
            {app.packages.length === 0 ? (
              <Alert tone="warn" title="还没有运行库">
                先到「运行库」页从 GitHub 下载，或导入你下载好的发布包。
                <div className="row" style={{ marginTop: 8 }}>
                  <Button variant="primary" size="sm" onClick={onGoLibrary}>
                    去导入运行库
                  </Button>
                </div>
              </Alert>
            ) : (
              <div className="stack">
                <Field label="运行库">
                  <Select
                    value={packageId}
                    onChange={setPackageId}
                    options={app.packages.map((item) => ({
                      value: item.id,
                      label: `${item.name} · 最高 ${item.maxMultiplier}X`
                    }))}
                  />
                </Field>
                <Field label="代理 DLL" hint={proxyName && RISKY_PROXIES.includes(proxyName.toLowerCase()) ? '渲染路径代理，风险更高' : '优先用 version.dll，不行再换 winmm.dll'}>
                  <Select
                    value={proxyName}
                    onChange={setProxyName}
                    options={(selectedPackage?.proxies ?? []).map((proxy) => ({
                      value: proxy.name,
                      label: `${proxy.name} · ${humanSize(proxy.size)}${RISKY_PROXIES.includes(proxy.name.toLowerCase()) ? '（渲染路径，谨慎）' : ''}`
                    }))}
                  />
                </Field>
                {selectedPackage?.notes && <p className="muted small">{selectedPackage.notes}</p>}
                {selectedPackage && (
                  <p className="muted small">
                    来源：{selectedPackage.source} · {selectedPackage.sourceDetail}
                  </p>
                )}
              </div>
            )}
          </Card>

          <Card title="帧生成配置（dlssg_sm86.ini）">
            <div className="stack">
              <Toggle
                checked={config.enabled}
                onChange={(value) => updateConfig({ enabled: value })}
                label="启用帧生成"
                hint="关闭时代理仍然转发系统 DLL，但不会在 Ampere 上提供帧生成"
              />
              <Field
                label="优化内核档位 Optimized"
                hint={OPTIMIZED_TIERS.find((tier) => tier.value === normalized.optimized)?.help}
              >
                <Select
                  value={normalized.optimized}
                  onChange={(value) => updateConfig({ optimized: Number(value) })}
                  options={OPTIMIZED_TIERS.map((tier) => ({ value: tier.value, label: tier.label }))}
                />
              </Field>
              {selectedPackage?.maxMultiplier === 4 && normalized.optimized > 1 && (
                <Alert tone="warn">
                  当前选择的运行库最高 4X（没有有损图像内核），档位 2/3 在它上面等同于档位 1。
                </Alert>
              )}
              <Field label="倍率上限" hint={`当前 = ${maxMultiplierForFrames(normalized.maxGeneratedFrames)}；实际倍率由游戏请求并钳到运行库上限`}>
                <Select
                  value={normalized.maxGeneratedFrames}
                  onChange={(value) => updateConfig({ maxGeneratedFrames: Number(value) })}
                  options={(selectedPackage?.maxMultiplier === 4 ? [1, 2, 3] : [1, 2, 3, 4, 5]).map((frames) => ({
                    value: frames,
                    label: `${maxMultiplierForFrames(frames)}（MaxGeneratedFrames=${frames}）`
                  }))}
                />
              </Field>
              <Field label="渲染预设 Preset" hint="仅 310.9 版有效；Auto = 交给游戏/驱动决定">
                <Select
                  value={normalized.preset}
                  onChange={(value) => updateConfig({ preset: value })}
                  options={[
                    { value: 'Auto', label: 'Auto（默认）' },
                    { value: 'A', label: 'A — 强制关闭 UI 重组' },
                    { value: 'B', label: 'B — 强制开启（多数游戏无效）' }
                  ]}
                />
              </Field>
              <Field label="日志等级" hint="排查问题用 2 或 3，平时 1">
                <Select
                  value={normalized.logLevel}
                  onChange={(value) => updateConfig({ logLevel: Number(value) as IniConfig['logLevel'] })}
                  options={[
                    { value: 0, label: '0 — 关闭' },
                    { value: 1, label: '1 — 仅错误（默认）' },
                    { value: 2, label: '2 — 配置与能力' },
                    { value: 3, label: '3 — 内核与求值轨迹' }
                  ]}
                />
              </Field>
              <Button size="sm" variant="ghost" onClick={() => setAdvanced((value) => !value)}>
                {advanced ? '收起高级键' : '展开高级键（可选键目录 / Runtime / 自定义）'}
              </Button>
              {advanced && (
                <div className="stack">
                  <Field label="日志目录 Logging.Directory" hint="相对 ini 所在目录">
                    <TextInput value={normalized.logDirectory} onChange={(value) => updateConfig({ logDirectory: value })} />
                  </Field>
                  <Field label="运行库模式 Runtime.Mode" hint="Bundled = 使用内嵌运行库（正常用法）">
                    <TextInput value={normalized.runtimeMode} onChange={(value) => updateConfig({ runtimeMode: value })} />
                  </Field>
                  <Field label="内核缓存目录 Runtime.CacheDirectory" hint="留空使用 %LOCALAPPDATA%\DlssgSm86\bundles">
                    <TextInput value={normalized.cacheDirectory} onChange={(value) => updateConfig({ cacheDirectory: value })} />
                  </Field>

                  <div className="extra-keys">
                    <p className="muted small">
                      可选高级键（上游 docs/INSTALL.md 收录的键。默认不写，缺失时上游会取安全默认值；写上会覆盖默认行为）
                    </p>
                    <div className="row">
                      <Select
                        value={catalogPick}
                        onChange={setCatalogPick}
                        options={[
                          { value: '', label: '选择一个键…' },
                          ...catalogOptions.map((spec) => ({
                            value: `${spec.section}\u0000${spec.key}`,
                            label: `[${spec.section}] ${spec.key} — ${spec.label}`
                          }))
                        ]}
                      />
                      <Button size="sm" disabled={!catalogPick} onClick={addCatalogKey}>
                        添加
                      </Button>
                    </div>

                    {config.extra.filter((item) => findSpec(item.section, item.key)).length > 0 && (
                      <div className="catalog-rows">
                        {config.extra.map((item, index) => {
                          const spec = findSpec(item.section, item.key)
                          if (!spec) return null
                          const setValue = (value: string): void => {
                            const next = [...config.extra]
                            next[index] = { ...item, value }
                            updateConfig({ extra: next })
                          }
                          return (
                            <div className="catalog-row" key={`${item.section}-${item.key}`}>
                              <div className="row wrap">
                                <strong>{spec.label}</strong>
                                <span className="mono small muted">
                                  [{spec.section}] {spec.key}
                                </span>
                                {spec.risk && (
                                  <Badge tone={spec.risk === 'experimental' ? 'bad' : 'warn'}>
                                    {spec.risk === 'experimental' ? '实验性' : spec.risk === 'lossy' ? '有损' : '可能降性能'}
                                  </Badge>
                                )}
                              </div>
                              <p className="muted small">{spec.help}</p>
                              <div className="row">
                                {(spec.type === 'bool' || spec.type === 'enum' || spec.type === 'tristate') && (
                                  <Select
                                    value={item.value}
                                    onChange={setValue}
                                    options={
                                      spec.type === 'bool'
                                        ? [
                                            { value: '1', label: '1 — 开启' },
                                            { value: '0', label: '0 — 关闭' }
                                          ]
                                        : (spec.options ?? []).map((option) => ({ value: option.value, label: option.label }))
                                    }
                                  />
                                )}
                                {spec.type === 'int' && (
                                  <NumberInput
                                    value={Number(item.value) || 0}
                                    min={spec.min}
                                    max={spec.max}
                                    onChange={(value) => setValue(String(value))}
                                  />
                                )}
                                {spec.type === 'string' && <TextInput value={item.value} onChange={setValue} />}
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => updateConfig({ extra: config.extra.filter((_, i) => i !== index) })}
                                >
                                  移除
                                </Button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    <p className="muted small" style={{ marginTop: 6 }}>
                      自定义键（上游文档里的其它键可以自己填：段名 / 键名 / 值）
                    </p>
                    {config.extra
                      .map((item, index) => ({ item, index }))
                      .filter(({ item }) => !findSpec(item.section, item.key))
                      .map(({ item, index }) => (
                        <div className="row" key={`custom-${index}`}>
                          <TextInput
                            value={item.section}
                            onChange={(value) => {
                              const next = [...config.extra]
                              next[index] = { ...item, section: value }
                              updateConfig({ extra: next })
                            }}
                          />
                          <TextInput
                            value={item.key}
                            onChange={(value) => {
                              const next = [...config.extra]
                              next[index] = { ...item, key: value }
                              updateConfig({ extra: next })
                            }}
                          />
                          <TextInput
                            value={item.value}
                            onChange={(value) => {
                              const next = [...config.extra]
                              next[index] = { ...item, value }
                              updateConfig({ extra: next })
                            }}
                          />
                          <Button size="sm" variant="ghost" onClick={() => updateConfig({ extra: config.extra.filter((_, i) => i !== index) })}>
                            删除
                          </Button>
                        </div>
                      ))}
                    <Button size="sm" onClick={() => updateConfig({ extra: [...config.extra, { section: 'Debug', key: '', value: '' }] })}>
                      添加自定义键
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </Card>

          <Card
            title="执行"
            subtitle="先看预检查结果，再注入"
            actions={
              <div className="row">
                <Button size="sm" variant="ghost" onClick={() => void doPlan()} disabled={!packageId}>
                  重新预检查
                </Button>
                {installed && (
                  <Button size="sm" onClick={() => void runSyncIni()} disabled={busy}>
                    只同步配置
                  </Button>
                )}
                {plan && plan.blockers.length > 0 ? (
                  <Button size="sm" variant="danger" onClick={() => setConfirmForce(true)} disabled={busy}>
                    仍然注入
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void runInstall(false)}
                    disabled={busy || !packageId || !proxyName}
                  >
                    {installed ? '重新注入 / 升级' : '开始注入'}
                  </Button>
                )}
              </div>
            }
          >
            {busy ? (
              <Spinner label="处理中…" />
            ) : plan ? (
              <div className="stack">
                {plan.blockers.length > 0 && (
                  <Alert tone="bad" title="预检查发现阻塞项">
                    <ul className="list">
                      {plan.blockers.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </Alert>
                )}
                {plan.warnings.length > 0 && (
                  <Alert tone="warn" title="提示">
                    <ul className="list">
                      {plan.warnings.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </Alert>
                )}
                <ul className="plan-list">
                  {plan.actions.map((action, index) => (
                    <li key={`${action.kind}-${index}`} className={`plan-item plan-${action.level}`}>
                      <Badge tone={action.level === 'warn' ? 'warn' : action.level === 'error' ? 'bad' : 'muted'}>{action.kind}</Badge>
                      <div>
                        <div className="mono small">{action.target}</div>
                        <div className="muted small">{action.detail}</div>
                      </div>
                    </li>
                  ))}
                </ul>
                <details>
                  <summary className="muted small">预览将写入的 dlssg_sm86.ini</summary>
                  <pre className="code">{preview}</pre>
                </details>
              </div>
            ) : (
              <p className="muted small">选择运行库后会自动预检查</p>
            )}
          </Card>

          <Card title="使用流程" subtitle="注入之后要做的事">
            <ol className="list ordered">
              <li>完全退出游戏（本工具会检查进程，运行中不允许写入）</li>
              <li>点「开始注入」，成功后启动游戏</li>
              <li>在游戏图形设置里打开 DLSS 帧生成，选 2X/3X/4X（游戏支持且用 310.9 版时可到 6X）</li>
              <li>基础帧率偏低时插帧观感会变差，适当降低画质把基础帧率抬上去</li>
            </ol>
          </Card>
        </div>
      )}

      {tab === 'files' && (
        <div className="stack">
          <Card title="已部署文件" subtitle={installed ? `注入于 ${formatTime(game.install?.installedAt)}` : '当前没有本工具的注入记录'}>
            {status && status.files.length > 0 ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>文件</th>
                    <th>状态</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {status.files.map((file) => (
                    <tr key={file.path}>
                      <td className="mono small">{file.path}</td>
                      <td>{file.exists ? (file.matches ? <Badge tone="ok">一致</Badge> : <Badge tone="warn">被改动</Badge>) : <Badge tone="bad">缺失</Badge>}</td>
                      <td className="muted small">{humanSize(file.size)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted small">没有记录。</p>
            )}
            {installed && (
              <div className="row" style={{ marginTop: 12 }}>
                <Button variant="danger" onClick={() => setConfirmRestore(true)} disabled={busy}>
                  一键还原
                </Button>
              </div>
            )}
          </Card>

          <Card title="备份" subtitle="每次覆盖文件前都会先备份，可以按时间回滚">
            {backups.length === 0 ? (
              <p className="muted small">还没有备份。</p>
            ) : (
              <div className="stack">
                {backups.map((backup) => (
                  <div className="backup-row" key={backup.dir}>
                    <div>
                      <div className="mono small">{backup.dir}</div>
                      <div className="muted small">{backup.files.map((file) => `${file.name} (${humanSize(file.size)})`).join(' · ')}</div>
                    </div>
                    <Button size="sm" onClick={() => void window.api.openPath(backup.dir)}>
                      打开
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === 'logs' && (
        <div className="stack">
          <Card
            title="运行日志"
            subtitle="日志在游戏目录的 dlssg_sm86\logs\ 下，默认只记错误（Level=1）"
            actions={
              <div className="row">
                <Button size="sm" variant="ghost" onClick={() => void window.api.listGameLogs(gameId).then(setLogs)}>
                  刷新
                </Button>
                <Button size="sm" onClick={() => void window.api.openPath(`${game.exeDir}\\dlssg_sm86\\logs`)}>
                  打开日志目录
                </Button>
              </div>
            }
          >
            {logs.length === 0 ? (
              <EmptyState title="还没有日志文件" hint="先进游戏跑一次；如果一直不生成日志，说明代理 DLL 没有被加载，试着换一个代理名。" />
            ) : (
              <div className="log-list">
                {logs.map((file) => (
                  <button
                    type="button"
                    key={file.path}
                    className={`log-item${logView?.file.path === file.path ? ' active' : ''}`}
                    onClick={() => void window.api.readLog(file.path).then(setLogView)}
                  >
                    <span className="mono small">{file.name}</span>
                    <span className="muted small">
                      {file.kind} · {humanSize(file.size)} · {formatTime(file.mtime)}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {logView && (
              <div className="stack" style={{ marginTop: 12 }}>
                <p className="muted small">
                  {logView.file.path}
                  {logView.truncated && '（只显示末尾 256KB）'}
                </p>
                <pre className="code code-tall">
                  {logView.lines
                    .slice(-200)
                    .map((line) => line.raw)
                    .join('\n')}
                </pre>
              </div>
            )}
          </Card>
          {status?.logSummary && status.logSummary.errors.length > 0 && (
            <Card title="错误行" tone="warn">
              <pre className="code">{status.logSummary.errors.join('\n')}</pre>
            </Card>
          )}
        </div>
      )}

      {tab === 'advanced' && (
        <div className="stack">
          <Card title="启动与备注">
            <div className="stack">
              <Field label="启动用可执行文件" hint="可留空，默认用渲染 EXE">
                <div className="row">
                  <TextInput value={game.launchExe ?? ''} onChange={(value) => void saveGameField({ launchExe: value })} />
                  <Button
                    onClick={async () => {
                      const file = await window.api.pickFile({ name: '可执行文件', extensions: ['exe'] })
                      if (file) await saveGameField({ launchExe: file })
                    }}
                  >
                    选择
                  </Button>
                </div>
              </Field>
              <Field label="备注">
                <TextInput value={game.notes ?? ''} onChange={(value) => void saveGameField({ notes: value })} />
              </Field>
            </div>
          </Card>

          <Card title="操作历史">
            {game.history.length === 0 ? (
              <p className="muted small">还没有操作记录。</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>动作</th>
                    <th>结果</th>
                  </tr>
                </thead>
                <tbody>
                  {game.history.map((entry, index) => (
                    <tr key={`${entry.at}-${index}`}>
                      <td className="small">{formatTime(entry.at)}</td>
                      <td className="small">{entry.action}</td>
                      <td className="small">{entry.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="危险操作" tone="bad">
            <div className="stack">
              <p className="muted small">
                移除条目只会删掉本工具的记录与备份，不会碰游戏目录里的文件。如果已经注入，请先还原。
              </p>
              <div className="row">
                <Button
                  variant="danger"
                  onClick={async () => {
                    try {
                      await window.api.removeGame(gameId, true)
                      await app.refreshGames()
                      app.notify('已移除条目与备份', 'ok')
                      onBack()
                    } catch (error) {
                      app.notify(`移除失败：${(error as Error).message}`, 'bad')
                    }
                  }}
                >
                  移除条目并删除备份
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      <Modal
        open={confirmForce}
        title="存在阻塞项，仍然注入？"
        onClose={() => setConfirmForce(false)}
        footer={
          <div className="row">
            <Button onClick={() => setConfirmForce(false)}>取消</Button>
            <Button variant="danger" onClick={() => void runInstall(true)} disabled={busy}>
              我确认，强制写入
            </Button>
          </div>
        }
      >
        <Alert tone="bad" title="请先确认">
          <ul className="list">
            {(plan?.blockers ?? []).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Alert>
        <p className="muted small" style={{ marginTop: 12 }}>
          强制写入会覆盖目标目录里的同名文件（仍然先做备份），并且可能让游戏启动失败。确认游戏已经完全退出、目录选择正确再继续。
        </p>
      </Modal>

      <Modal
        open={confirmRestore}
        title="一键还原"
        onClose={() => setConfirmRestore(false)}
        footer={
          <div className="row">
            <Button onClick={() => setConfirmRestore(false)}>取消</Button>
            <Button variant="primary" onClick={() => void runRestore()} disabled={busy}>
              开始还原
            </Button>
          </div>
        }
      >
        <div className="stack">
          <p>
            会删除本工具新建的文件，并把覆盖过的文件还原成注入前的备份。还原后帧生成会回到游戏的原生状态（Ampere 上就是不可用）。
          </p>
          <Toggle checked={removeLogs} onChange={setRemoveLogs} label="同时删除 dlssg_sm86 日志目录" />
          <Toggle checked={restoreForce} onChange={setRestoreForce} label="即使文件被改动过也强制还原" />
          {!restoreForce && <p className="muted small">如果注入后的文件被手动修改过，还原会被拒绝，需要打开上面的开关。</p>}
        </div>
      </Modal>
    </div>
  )
}
