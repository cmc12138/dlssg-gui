import { useState, type JSX } from 'react'
import type { RemoteVariant, RuntimePackage } from '@shared/types'
import { Alert, Badge, Button, Card, EmptyState, Modal, Spinner } from '../components/ui'
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

  const afterImport = async (): Promise<void> => {
    await app.refreshPackages()
    app.notify('导入完成', 'ok')
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
          <li>最省事：点「从 GitHub 下载」，直接拉取 310.9（支持 6X）或 310.1（最高 4X）</li>
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
            return (
              <article className="game-card" key={pkg.id}>
                <header>
                  <div className="game-title">
                    <h3>{pkg.name}</h3>
                    <div className="row wrap">
                      <Badge tone="info">运行库 {pkg.runtimeVersion}</Badge>
                      <Badge tone={pkg.maxMultiplier >= 6 ? 'ok' : 'muted'}>最高 {pkg.maxMultiplier}X</Badge>
                      <Badge tone="muted">{pkg.source}</Badge>
                      {app.settings?.defaultPackageId === pkg.id && <Badge tone="ok">默认</Badge>}
                    </div>
                  </div>
                </header>
                <p className="muted small">
                  导入于 {formatTime(pkg.importedAt)} · 代理 {pkg.proxies.length} 个 · 共 {humanSize(totalSize)}
                </p>
                <p className="muted small mono">{pkg.proxies.map((proxy) => proxy.name).join('、')}</p>
                <p className="path-line" title={pkg.rootPath} onClick={() => void window.api.openPath(pkg.rootPath)}>
                  {pkg.rootPath}
                </p>
                {pkg.notes && <p className="muted small">{pkg.notes}</p>}
                <footer className="row">
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
                  {busy === variant.id ? '下载中…' : '下载'}
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
    </div>
  )
}
