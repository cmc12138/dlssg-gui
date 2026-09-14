import type { JSX } from 'react'
import { Alert, Badge, Button, Card } from '../components/ui'
import { useApp } from '../state'
import { STATE_LABEL } from '../lib/format'

export function Dashboard({ onGoGames, onGoLibrary, onOpenGame }: { onGoGames: () => void; onGoLibrary: () => void; onOpenGame: (id: string) => void }): JSX.Element {
  const app = useApp()
  const env = app.env
  const installedGames = app.games.filter((game) => {
    const state = app.statuses[game.id]?.state
    return state === 'installed' || state === 'outdated'
  })
  const capable = app.games.filter((game) => game.dlssgCapable)
  const packageUsage = new Map<string, number>()
  for (const game of app.games) {
    if (!game.install) continue
    packageUsage.set(game.install.packageName, (packageUsage.get(game.install.packageName) ?? 0) + 1)
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h2>概览</h2>
          <p className="muted small">
            给 RTX 20/30 系（SM86/SM75）显卡补上 DLSS 帧生成：把上游 dlssg_for_sm86 的代理 DLL 注入游戏目录，并管理配置与还原。
          </p>
        </div>
        <div className="row">
          <Button onClick={onGoGames}>游戏列表</Button>
          <Button variant="primary" onClick={() => void app.runScan()} disabled={app.scan.running}>
            {app.scan.running ? '扫描中…' : '扫描本机游戏'}
          </Button>
        </div>
      </header>

      {env?.warnings.map((warning) => (
        <Alert key={warning} tone="warn">
          {warning}
        </Alert>
      ))}
      {env?.notes.map((note) => (
        <Alert key={note} tone="info">
          {note}
        </Alert>
      ))}

      <div className="stat-row">
        <Card title="游戏条目">
          <p className="stat-value">{app.games.length}</p>
          <p className="muted small">{capable.length} 个检测到 DLSS 帧生成能力</p>
        </Card>
        <Card title="已注入">
          <p className="stat-value">{installedGames.length}</p>
          <p className="muted small">
            {app.games.filter((game) => app.statuses[game.id]?.state === 'conflict').length} 个存在冲突或异常
          </p>
        </Card>
        <Card title="运行库">
          <p className="stat-value">{app.packages.length}</p>
          <p className="muted small">{[...packageUsage.entries()].map(([name, count]) => `${name} ×${count}`).join(' · ') || '还没有游戏在用'}</p>
        </Card>
      </div>

      <Card title="环境检测" subtitle="upstream 需要 NVIDIA 驱动提供 NGX / NVAPI 接口">
        {env ? (
          <div className="stack">
            <div className="kv">
              <span className="muted small">显卡</span>
              <span>
                {env.gpus.length === 0 ? '未检测到 NVIDIA 显卡' : env.gpus.map((gpu) => `${gpu.name}${gpu.driver ? `（驱动 ${gpu.driver}）` : ''}`).join(' / ')}
              </span>
            </div>
            <div className="kv">
              <span className="muted small">架构判断</span>
              <span>
                {env.smKind === 'sm86' && <Badge tone="ok">SM86（RTX 30 系，官方支持）</Badge>}
                {env.smKind === 'sm75' && <Badge tone="warn">SM75（RTX 20 系，实验性）</Badge>}
                {env.smKind === 'ada+' && <Badge tone="info">RTX 40/50 系（原生支持，一般不需要）</Badge>}
                {env.smKind === 'unknown' && <Badge tone="muted">未知</Badge>}
              </span>
            </div>
            <div className="kv">
              <span className="muted small">数据目录</span>
              <span className="mono small">{env.dataDir}</span>
            </div>
            <div className="kv">
              <span className="muted small">版本</span>
              <span className="small">
                GUI v{env.appVersion} · Electron {env.electron} · Node {env.node}
              </span>
            </div>
            <div className="row">
              <Button size="sm" onClick={() => void window.api.openPath(env.dataDir)}>
                打开数据目录
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void app.refreshEnv()}>
                重新检测
              </Button>
            </div>
          </div>
        ) : (
          <p className="muted small">检测中…</p>
        )}
      </Card>

      <div className="two-col">
        <Card title="快速开始" subtitle="四步跑起来">
          <ol className="list ordered">
            <li>
              在「运行库」里下载或导入 DLSSG 发布包（推荐 310.9，最高 6X）
              <div className="row" style={{ marginTop: 6 }}>
                <Button size="sm" onClick={onGoLibrary}>
                  去运行库
                </Button>
              </div>
            </li>
            <li>扫描或手动添加游戏，确认「渲染 EXE 目录」正确</li>
            <li>在游戏详情里选代理 DLL，点「开始注入」</li>
            <li>启动游戏 → 图形设置里打开 DLSS 帧生成 → 选倍率</li>
          </ol>
        </Card>

        <Card title="风险提示" tone="warn">
          <ul className="list">
            <li>注入 DLL 的行为和作弊器特征一致：<strong>绝不要在带反作弊的网游里使用</strong>（PUBG、Valorant、部分带 EAC/BattlEye 的游戏等），会封号。</li>
            <li>只用于单机 3A。多人游戏、带反作弊的单机也请先还原。</li>
            <li>上游 DLL 自带自签名证书，Windows SmartScreen 可能提示「未知发布者」，这是信誉提示。</li>
            <li>本工具只负责复制文件、写 ini 与备份还原，不修改游戏本体、不联网上传任何东西。</li>
          </ul>
        </Card>
      </div>

      {installedGames.length > 0 && (
        <Card title="已注入的游戏">
          <table className="table">
            <thead>
              <tr>
                <th>游戏</th>
                <th>状态</th>
                <th>运行库</th>
                <th>代理</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {installedGames.map((game) => (
                <tr key={game.id}>
                  <td>{game.name}</td>
                  <td>{STATE_LABEL[app.statuses[game.id]?.state ?? 'installed']}</td>
                  <td className="small">{game.install?.packageName}</td>
                  <td className="mono small">{game.install?.proxyName}</td>
                  <td>
                    <Button size="sm" variant="ghost" onClick={() => onOpenGame(game.id)}>
                      打开
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card title="关于上游">
        <div className="stack">
          <p className="small">
            运行库来自开源项目 <span className="mono">sdli1995/dlssg_for_sm86</span>（GPLv3）：在 RTX 30 系（SM86）上启用 NVIDIA DLSS 帧生成，
            RTX 20 系（SM75）路由为实验性。内嵌的 <span className="mono">nvngx_dlssg.dll</span>、模型与内核来自 NVIDIA，不随源码转授权。
          </p>
          <div className="row">
            <Button size="sm" onClick={() => void window.api.openExternal('https://github.com/sdli1995/dlssg_for_sm86')}>
              上游仓库
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void window.api.openExternal('https://github.com/sdli1995/dlssg_for_sm86/blob/main/README.md')}>
              上游说明文档
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
