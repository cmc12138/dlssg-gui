import { useCallback, useEffect, useState, type JSX } from 'react'
import type { CleanupReport, RemoteVariant, RuntimePackage, UpstreamStatus } from '@shared/types'
import { Alert, Badge, Button, Card, EmptyState, Modal, Spinner, Toggle } from '../components/ui'
import { useApp } from '../state'
import { formatTime, humanSize } from '../lib/format'

export function Library(): JSX.Element {
  const app = useApp()
  const [busy, setBusy] = useState<string>()
  const [remote, setRemote] = useState<RemoteVariant[]>()
  const [remoteOpen, setRemoteOpen] = useState(false)
  const [remoteBusy, setRemoteBusy] = useState(false)
  const [verifyResult, setVerifyResult] = useState<{ id: string; rows: { name: string; ok: boolean; expected: string; actual: string }[] }>()
  const [targetName, setTargetName] = useState('version.dll')
  const [upstream, setUpstream] = useState<UpstreamStatus>()
  const [upstreamBusy, setUpstreamBusy] = useState(false)
  const [cleanup, setCleanup] = useState<CleanupReport>()
  const [cleanupBusy, setCleanupBusy] = useState(false)
  const [cleanupPick, setCleanupPick] = useState<string[]>([])

  const scanCleanupNow = useCallback(async (): Promise<void> => {
    setCleanupBusy(true)
    try {
      const report = await window.api.scanCleanup()
      setCleanup(report)
      setCleanupPick(report.items.map((item) => item.path))
    } catch (error) {
      app.notify(`检查失败：${(error as Error).message}`, 'bad')
    } finally {
      setCleanupBusy(false)
    }
  }, [app])

  const checkUpstreamNow = useCallback(
    async (force: boolean): Promise<void> => {
      setUpstreamBusy(true)
      try {
        setUpstream(await window.api.checkUpstream(force))
      } catch (error) {
        app.notify(`检查上游失败：${(error as Error).message}`, 'bad')
      } finally {
        setUpstreamBusy(false)
      }
    },
    [app]
  )

  const runCleanupNow = useCallback(async (): Promise<void> => {
    if (cleanupPick.length === 0) return
    setCleanupBusy(true)
    try {
      const result = await window.api.runCleanup(cleanupPick)
      app.notify(
        `清理完成：删除 ${result.removed} 项，释放 ${result.freedText}${result.errors.length > 0 ? `\n${result.errors.join('\n')}` : ''}`,
        result.errors.length > 0 ? 'info' : 'ok'
      )
      await app.refreshPackages()
      await checkUpstreamNow(true)
      await scanCleanupNow()
    } catch (error) {
      app.notify(`清理失败：${(error as Error).message}`, 'bad')
    } finally {
      setCleanupBusy(false)
    }
  }, [app, checkUpstreamNow, cleanupPick, scanCleanupNow])

  useEffect(() => {
    void checkUpstreamNow(false)
    // 只在进入页面时跑一次（缓存 5 分钟）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const afterImport = async (): Promise<void> => {
    await app.refreshPackages()
    await checkUpstreamNow(true)
    app.notify('导入完成', 'ok')
  }

  const downloadFromUpstream = async (path: string): Promise<void> => {
    setBusy(`upstream:${path}`)
    try {
      let list = remote
      if (!list) {
        list = await window.api.listRemoteVariants()
        setRemote(list)
      }
      const variant = list.find((item) => item.prefix === path)
      if (!variant) throw new Error('下载列表里没有这个发布包，请点「立即检查」后重试')
      const pkg = await window.api.downloadVariant(variant.id)
      await app.refreshPackages()
      await checkUpstreamNow(true)
      app.notify(`已下载并导入：${pkg.name}`, 'ok')
    } catch (error) {
      app.notify(`下载失败：${(error as Error).message}`, 'bad')
    } finally {
      setBusy(undefined)
    }
  }

  const importFolder = async (): Promise<void> => {
    setBusy('folder')
    try {
      const result = await window.api.importPackageFromFolder()
      if (result) {
        await afterImport()
        if (result.warnings.length > 0) app.notify(result.warnings.join('\n'), 'info')
      }
    } catch (error) {
      app.notify(`导入失败：${(error as Error).message}`, 'bad')
    } finally {
      setBusy(undefined)
    }
  }

  const importZip = async (): Promise<void> => {
    setBusy('zip')
    try {
      const result = await window.api.importPackageFromZip()
      if (result) {
        await afterImport()
        if (result.warnings.length > 0) app.notify(result.warnings.join('\n'), 'info')
      }
    } catch (error) {
      app.notify(`导入失败：${(error as Error).message}`, 'bad')
    } finally {
      setBusy(undefined)
    }
  }

  const importDll = async (): Promise<void> => {
    const file = await window.api.pickFile({ name: 'DLL 文件', extensions: ['dll'] })
    if (!file) return
    setBusy('dll')
    try {
      const result = await window.api.importPackageFromPath(file, targetName)
      await afterImport()
      if (result.warnings.length > 0) app.notify(result.warnings.join('\n'), 'info')
    } catch (error) {
      app.notify(`导入失败：${(error as Error).message}`, 'bad')
    } finally {
      setBusy(undefined)
    }
  }

  const openRemote = async (): Promise<void> => {
    setRemoteOpen(true)
    if (remote) return
    setRemoteBusy(true)
    try {
      setRemote(await window.api.listRemoteVariants())
    } catch (error) {
      app.notify(`获取下载列表失败：${(error as Error).message}`, 'bad')
    } finally {
      setRemoteBusy(false)
    }
  }

  const download = async (variant: RemoteVariant): Promise<void> => {
    setRemoteBusy(true)
    setBusy(variant.id)
    try {
      const pkg = await window.api.downloadVariant(variant.id)
      await app.refreshPackages()
      app.notify(`已下载并导入：${pkg.name}`, 'ok')
      setRemoteOpen(false)
    } catch (error) {
      app.notify(`下载失败：${(error as Error).message}`, 'bad')
    } finally {
      setRemoteBusy(false)
      setBusy(undefined)
    }
  }

  const remove = async (pkg: RuntimePackage): Promise<void> => {
    const used = app.games.filter((game) => game.install?.packageId === pkg.id)
    if (used.length > 0) {
      app.notify(`「${pkg.name}」正在被 ${used.length} 个游戏使用，请先还原这些游戏`, 'bad')
      return
    }
    setBusy(pkg.id)
    try {
      await window.api.removePackage(pkg.id)
      await app.refreshPackages()
      app.notify('已删除运行库', 'ok')
    } finally {
      setBusy(undefined)
    }
  }

  const verify = async (pkg: RuntimePackage): Promise<void> => {
    setBusy(pkg.id)
    try {
      const rows = await window.api.verifyPackage(pkg.id)
      setVerifyResult({ id: pkg.id, rows })
    } catch (error) {
      app.notify(`校验失败：${(error as Error).message}`, 'bad')
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h2>运行库</h2>
          <p className="muted small">
            上游项目 dlssg_for_sm86 的发布包：里面是代理 DLL 与内嵌的 DLSS-G 运行库。已导入 {app.packages.length} 个。
          </p>
        </div>
        <div className="row">
          <Button variant="primary" onClick={() => void openRemote()}>
            从 GitHub 下载
          </Button>
          <Button onClick={() => void importZip()} disabled={busy === 'zip'}>
            导入 ZIP
          </Button>
          <Button onClick={() => void importFolder()} disabled={busy === 'folder'}>
            导入文件夹
          </Button>
        </div>
      </header>

      <Alert tone="info" title="怎么获得发布包">
        <ul className="list">
          <li>最省事：看下面的「上游状态」，点对应发布包的「下载 / 更新」，直接拉最新版</li>
          <li>
            也可以自己去上游仓库下载 ZIP（Code → Download ZIP）后用「导入 ZIP」；一个包里含多个版本时会一起导入
          </li>
          <li>已经有单独的 DLL 文件？用下面的「指定单个 DLL」把它当作运行库导入，注入时使用你选的代理名</li>
        </ul>
        <div className="row" style={{ marginTop: 10 }}>
          <Button size="sm" onClick={() => void window.api.openExternal('https://github.com/sdli1995/dlssg_for_sm86')}>
            打开上游仓库
          </Button>
        </div>
      </Alert>

      <Card
        title="上游状态"
        subtitle="用 GitHub API 读仓库，自动发现所有发布包目录并比对本地已导入的版本"
        actions={
          <div className="row">
            <Button size="sm" variant="ghost" onClick={() => void checkUpstreamNow(true)} disabled={upstreamBusy}>
              {upstreamBusy ? '检查中…' : '立即检查'}
            </Button>
            {upstream && (
              <Button size="sm" variant="ghost" onClick={() => void window.api.openExternal(upstream.repoUrl)}>
                打开仓库
              </Button>
            )}
          </div>
        }
      >
        {upstreamBusy && !upstream ? (
          <Spinner label="正在读取上游仓库…" />
        ) : !upstream ? (
          <p className="muted small">还没有检查过。</p>
        ) : upstream.error ? (
          <Alert tone="warn" title="读取上游失败">
            {upstream.error}
            <div className="muted small" style={{ marginTop: 6 }}>
              不影响使用：可以直接去仓库下载 ZIP 再用「导入 ZIP」，或在下载列表里用内置的兜底地址。
            </div>
          </Alert>
        ) : (
          <div className="stack">
            <div className="kv">
              <span className="muted small">项目版本</span>
              <span>
                {upstream.projectVersion ? <Badge tone="ok">{upstream.projectVersion}</Badge> : <span className="muted small">未知</span>}
                {upstream.releases.length > 1 && (
                  <span className="muted small">（历史：{upstream.releases.slice(1, 5).map((item) => item.tag).join('、')}）</span>
                )}
              </span>
            </div>
            <div className="kv">
              <span className="muted small">最新提交</span>
              <span className="small">
                <span className="mono">{upstream.latestCommit.sha.slice(0, 7)}</span> · {formatTime(upstream.latestCommit.date)} ·{' '}
                {upstream.latestCommit.message}
              </span>
            </div>
            <div className="kv">
              <span className="muted small">检查时间</span>
              <span className="muted small">
                {formatTime(upstream.checkedAt)} · 本地已纳管 {upstream.managedPackages} 个上游运行库
              </span>
            </div>

            <table className="table">
              <thead>
                <tr>
                  <th>发布包</th>
                  <th>运行库</th>
                  <th>主 DLL</th>
                  <th>状态</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {upstream.packages.map((pkg) => {
                  const rowBusy = busy === `upstream:${pkg.path}`
                  return (
                    <tr key={pkg.path || 'root'}>
                      <td>
                        <div>{pkg.label}</div>
                        <div className="muted small mono">{pkg.path || '/'}</div>
                        {pkg.notes && <div className="muted small">{pkg.notes}</div>}
                      </td>
                      <td className="small">
                        {pkg.runtimeVersion}
                        <div className="muted small">最高 {pkg.maxMultiplier}X</div>
                      </td>
                      <td className="small">
                        {humanSize(pkg.versionSize)}
                        <div className="muted small">{pkg.proxies.length} 个代理</div>
                      </td>
                      <td>
                        {pkg.localPackageId ? (
                          pkg.updateAvailable ? (
                            <Badge tone="warn">有更新</Badge>
                          ) : (
                            <Badge tone="ok">已是最新</Badge>
                          )
                        ) : (
                          <Badge tone="muted">未导入</Badge>
                        )}
                        {pkg.localPackageName && <div className="muted small">{pkg.localPackageName}</div>}
                      </td>
                      <td>
                        <Button
                          size="sm"
                          variant={pkg.updateAvailable ? 'primary' : 'default'}
                          disabled={rowBusy}
                          onClick={() => void downloadFromUpstream(pkg.path)}
                        >
                          {rowBusy
                            ? `下载中 ${Math.round((app.progress?.overall ?? 0) * 100)}%`
                            : pkg.localPackageId
                              ? pkg.updateAvailable
                                ? '更新'
                                : '重新下载'
                              : '下载'}
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <p className="muted small">
              更新会下载到新的运行库目录，旧版本保留在原处（可以在下面删掉，或用来回滚）。已注入的游戏需要重新注入才会用上新版本。
            </p>
            <Toggle
              checked={app.settings?.downloadAllProxies ?? false}
              onChange={(value) => void app.updateSettings({ downloadAllProxies: value })}
              label="连其它代理名一起下载"
              hint="关闭（推荐）只下 version.dll 约 30MB；打开会额外下 5 个备选代理，约 180MB。只有游戏不加载 version.dll 时才需要"
            />
          </div>
        )}
      </Card>

      <Card title="指定单个 DLL" subtitle="高级用法：把任意一个代理 DLL 作为来源导入（等于信任该文件）">
        <div className="row">
          <select className="input input-number" value={targetName} onChange={(event) => setTargetName(event.target.value)}>
            {['version.dll', 'winmm.dll', 'dbghelp.dll', 'dinput8.dll', 'dxgi.dll', 'd3d12.dll'].map((name) => (
              <option key={name} value={name}>
                注入为 {name}
              </option>
            ))}
          </select>
          <Button onClick={() => void importDll()} disabled={busy === 'dll'}>
            选择 DLL 文件
          </Button>
        </div>
      </Card>

      {app.packages.length === 0 ? (
        <EmptyState title="还没有运行库" hint="从 GitHub 下载，或导入本地的发布包 / ZIP。" />
      ) : (
        <div className="grid">
          {app.packages.map((pkg) => {
            const totalSize = pkg.proxies.reduce((sum, proxy) => sum + proxy.size, 0)
            const upstreamPkg = upstream?.packages.find(
              (item) => item.localPackageId === pkg.id || (pkg.remotePath !== undefined && item.path === pkg.remotePath)
            )
            return (
              <article className="game-card" key={pkg.id}>
                <header>
                  <div className="game-title">
                    <h3>{pkg.name}</h3>
                    <div className="row wrap">
                      <Badge tone="info">运行库 {pkg.runtimeVersion}</Badge>
                      <Badge tone={pkg.maxMultiplier >= 6 ? 'ok' : 'muted'}>最高 {pkg.maxMultiplier}X</Badge>
                      <Badge tone="muted">{pkg.source}</Badge>
                      {pkg.projectVersion && <Badge tone="muted">项目 {pkg.projectVersion}</Badge>}
                      {upstreamPkg?.updateAvailable && <Badge tone="warn">上游有更新</Badge>}
                      {app.settings?.defaultPackageId === pkg.id && <Badge tone="ok">默认</Badge>}
                    </div>
                  </div>
                </header>
                <p className="muted small">
                  导入于 {formatTime(pkg.importedAt)} · 代理 {pkg.proxies.length} 个 · 共 {humanSize(totalSize)}
                  {pkg.remotePath !== undefined && ` · 仓库路径 ${pkg.remotePath || '/'}`}
                </p>
                <p className="muted small mono">{pkg.proxies.map((proxy) => proxy.name).join('、')}</p>
                <p className="path-line" title={pkg.rootPath} onClick={() => void window.api.openPath(pkg.rootPath)}>
                  {pkg.rootPath}
                </p>
                {pkg.notes && <p className="muted small">{pkg.notes}</p>}
                <footer className="row">
                  {upstreamPkg?.updateAvailable && pkg.remotePath !== undefined && (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => void downloadFromUpstream(pkg.remotePath!)}
                      disabled={busy === `upstream:${pkg.remotePath}`}
                    >
                      更新到最新
                    </Button>
                  )}
                  <Button size="sm" onClick={() => void verify(pkg)} disabled={busy === pkg.id}>
                    校验文件
                  </Button>
                  {app.settings?.defaultPackageId !== pkg.id && (
                    <Button size="sm" onClick={() => void app.updateSettings({ defaultPackageId: pkg.id })}>
                      设为默认
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => void remove(pkg)} disabled={busy === pkg.id}>
                    删除
                  </Button>
                </footer>
              </article>
            )
          })}
        </div>
      )}

      <Modal open={remoteOpen} title="从 GitHub 下载运行库" onClose={() => setRemoteOpen(false)} width={680}>
        {remoteBusy && !remote ? (
          <Spinner label="正在探测上游文件…" />
        ) : (
          <div className="stack">
            <p className="muted small">
              直接拉取上游仓库（dlssg_for_sm86，GPLv3）里的发布文件。文件较大（每个代理约 17 MB），只下载你需要的那个版本。
            </p>
            {(remote ?? []).map((variant) => (
              <div className="remote-row" key={variant.id}>
                <div>
                  <div className="row wrap">
                    <strong>{variant.name}</strong>
                    <Badge tone={variant.maxMultiplier >= 6 ? 'ok' : 'muted'}>最高 {variant.maxMultiplier}X</Badge>
                    {variant.available === false && <Badge tone="bad">不可访问</Badge>}
                  </div>
                  <div className="muted small">
                    仓库路径 {variant.repoPath} · 主 DLL {humanSize(variant.proxies[0]?.size ?? 0)} · 共 {variant.proxies.length} 个代理
                  </div>
                  {variant.error && <div className="muted small">{variant.error}</div>}
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={remoteBusy}
                  onClick={() => void download(variant)}
                >
                  {busy === variant.id ? `下载中 ${Math.round((app.progress?.overall ?? 0) * 100)}%` : '下载'}
                </Button>
              </div>
            ))}
            <p className="muted small">
              下载走 raw.githubusercontent.com；如果失败，可以在「设置」里打开镜像加速再试。
            </p>
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(verifyResult)}
        title="文件校验"
        onClose={() => setVerifyResult(undefined)}
        footer={<Button onClick={() => setVerifyResult(undefined)}>关闭</Button>}
      >
        <table className="table">
          <thead>
            <tr>
              <th>文件</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            {(verifyResult?.rows ?? []).map((row) => (
              <tr key={row.name}>
                <td className="mono small">{row.name}</td>
                <td>{row.ok ? <Badge tone="ok">一致</Badge> : <Badge tone="bad">不一致</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Modal>

      <Card
        title="数据目录清理"
        subtitle="只清理本工具自己的数据目录（%APPDATA%\dlssg-gui）；游戏目录一律不碰"
        actions={
          <div className="row">
            <Button size="sm" onClick={() => void scanCleanupNow()} disabled={cleanupBusy}>
              {cleanupBusy ? '处理中…' : '检查可清理项'}
            </Button>
            {cleanup && cleanup.items.length > 0 && (
              <Button size="sm" variant="primary" onClick={() => void runCleanupNow()} disabled={cleanupBusy || cleanupPick.length === 0}>
                清理选中 {cleanupPick.length} 项
              </Button>
            )}
          </div>
        }
      >
        {!cleanup ? (
          <p className="muted small">
            旧版本的运行库、导入中断留下的孤立目录、当前注入记录已经不引用的旧备份、下载临时目录，都可以一键清掉。
          </p>
        ) : cleanup.items.length === 0 ? (
          <Alert tone="ok" title="没有可清理的东西">
            数据目录很干净：{cleanup.dataDir}
          </Alert>
        ) : (
          <div className="stack">
            <p className="muted small">
              共 {cleanup.items.length} 项，合计 {humanSize(cleanup.totalSize)}。取消勾选可以保留；运行库目录：
              <span className="mono">{cleanup.packagesDir}</span>
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 36 }} />
                  <th>内容</th>
                  <th>大小</th>
                  <th>为什么可以删</th>
                </tr>
              </thead>
              <tbody>
                {cleanup.items.map((item) => (
                  <tr key={item.path}>
                    <td>
                      <input
                        type="checkbox"
                        checked={cleanupPick.includes(item.path)}
                        onChange={(event) =>
                          setCleanupPick((current) =>
                            event.target.checked ? [...current, item.path] : current.filter((path) => path !== item.path)
                          )
                        }
                      />
                    </td>
                    <td>
                      <div className="small">{item.label ?? item.kind}</div>
                      <div className="muted small mono">{item.path}</div>
                    </td>
                    <td className="small">{humanSize(item.size)}</td>
                    <td className="muted small">{item.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">
              有游戏正在用的运行库不会被列出来；备份目录里当前注入记录引用的那一份也不会删（还原要用它）。
            </p>
          </div>
        )}
      </Card>
    </div>
  )
}
