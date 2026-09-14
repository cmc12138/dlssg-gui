import { useMemo, useState, type JSX } from 'react'
import type { GameEntry } from '@shared/types'
import { Alert, Badge, Button, Card, EmptyState, ProgressBar, Select, Spinner, TextInput } from '../components/ui'
import { useApp } from '../state'
import { STATE_LABEL, STATE_TONE, truncateMiddle } from '../lib/format'

export function Games({ onOpenGame }: { onOpenGame: (id: string) => void }): JSX.Element {
  const app = useApp()
  const [filter, setFilter] = useState<'all' | 'capable' | 'installed'>('all')
  const [keyword, setKeyword] = useState('')
  const [busy, setBusy] = useState<string>()

  const filtered = useMemo(() => {
    const list = app.games.filter((game) => {
      if (keyword && !`${game.name} ${game.exeDir}`.toLowerCase().includes(keyword.toLowerCase())) return false
      const status = app.statuses[game.id]
      if (filter === 'capable') return game.dlssgCapable
      if (filter === 'installed') return status?.state === 'installed' || status?.state === 'outdated' || status?.state === 'partial'
      return true
    })
    return list.sort((a, b) => Number(b.dlssgCapable) - Number(a.dlssgCapable) || a.name.localeCompare(b.name, 'zh-Hans-CN'))
  }, [app.games, app.statuses, filter, keyword])

  const addGame = async (installDir: string): Promise<void> => {
    setBusy(installDir)
    try {
      const game = await window.api.addGameFromFolder(installDir)
      await app.refreshGames()
      if (game) await app.refreshStatuses([game.id])
      app.notify('已添加到游戏列表', 'ok')
    } catch (error) {
      app.notify(`添加失败：${(error as Error).message}`, 'bad')
    } finally {
      setBusy(undefined)
    }
  }

  const removeGame = async (game: GameEntry): Promise<void> => {
    try {
      await window.api.removeGame(game.id, false)
      await app.refreshGames()
      app.notify('已从列表移除（游戏目录里的文件没有动）', 'ok')
    } catch (error) {
      app.notify(`移除失败：${(error as Error).message}`, 'bad')
    }
  }

  const newGames = app.scan.results.filter((game) => !game.known)

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h2>游戏</h2>
          <p className="muted small">
            共 {app.games.length} 个条目，{app.games.filter((g) => g.dlssgCapable).length} 个检测到 DLSS 帧生成能力
          </p>
        </div>
        <div className="row">
          <Button onClick={() => void app.runScan()} disabled={app.scan.running}>
            {app.scan.running ? '扫描中…' : '扫描本机游戏'}
          </Button>
          <Button variant="primary" onClick={() => void addGame('')} disabled={busy === ''}>
            手动添加游戏目录
          </Button>
        </div>
      </header>

      {app.scan.running && app.scan.progress && (
        <ProgressBar done={app.scan.progress.done} total={app.scan.progress.total} label={app.scan.progress.label} />
      )}

      {app.scan.warnings.length > 0 && (
        <Alert tone="warn" title="扫描提示">
          <ul className="list">
            {app.scan.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Alert>
      )}

      {app.scan.results.length > 0 && (
        <Card
          title="扫描结果"
          subtitle={`发现 ${app.scan.results.length} 个游戏，${newGames.length} 个还没加入列表`}
          actions={
            <Button size="sm" onClick={() => app.clearScan()}>
              收起
            </Button>
          }
        >
          <div className="scan-list">
            {app.scan.results.slice(0, 200).map((game) => (
              <div className="scan-row" key={`${game.name}-${game.installDir}`}>
                <div className="scan-main">
                  <span className="scan-name">{game.name}</span>
                  <span className="muted small">{truncateMiddle(game.exeDir ?? game.installDir, 70)}</span>
                </div>
                <div className="row">
                  <Badge tone="info">{game.source.toUpperCase()}</Badge>
                  {game.dlssgCapable ? <Badge tone="ok">支持帧生成</Badge> : <Badge tone="muted">未检测到 DLSS-G</Badge>}
                  {game.known ? (
                    <Badge tone="muted">已在列表</Badge>
                  ) : (
                    <Button size="sm" onClick={() => void addGame(game.installDir)} disabled={busy === game.installDir}>
                      加入列表
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="toolbar">
        <TextInput value={keyword} onChange={setKeyword} placeholder="搜索游戏名或路径" />
        <Select
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: '全部' },
            { value: 'capable', label: '支持帧生成' },
            { value: 'installed', label: '已注入' }
          ]}
        />
      </div>

      {app.loading ? (
        <Spinner label="读取中…" />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="还没有游戏条目"
          hint="点「扫描本机游戏」自动找出 Steam / Epic / GOG 里的游戏，或者手动选择游戏目录。"
          action={<Button variant="primary" onClick={() => void app.runScan()}>开始扫描</Button>}
        />
      ) : (
        <div className="grid">
          {filtered.map((game) => {
            const status = app.statuses[game.id]
            const state = status?.state ?? 'not-installed'
            return (
              <article className="game-card" key={game.id}>
                <header>
                  <div className="game-title">
                    <h3 title={game.name}>{game.name}</h3>
                    <div className="row wrap">
                      <Badge tone="info">{game.source.toUpperCase()}</Badge>
                      {game.dlssgCapable ? <Badge tone="ok">DLSS-G</Badge> : <Badge tone="muted">未检测到 DLSS-G</Badge>}
                      <Badge tone={STATE_TONE[state] ?? 'muted'}>{STATE_LABEL[state] ?? state}</Badge>
                      {status?.running && <Badge tone="warn">正在运行</Badge>}
                    </div>
                  </div>
                </header>
                <p className="path-line" title={game.exeDir} onClick={() => void window.api.openPath(game.exeDir)}>
                  {truncateMiddle(game.exeDir, 60)}
                </p>
                {status?.message && <p className="muted small">{status.message}</p>}
                <footer className="row">
                  <Button variant="primary" size="sm" onClick={() => onOpenGame(game.id)}>
                    配置 / 注入
                  </Button>
                  <Button size="sm" onClick={() => void window.api.openPath(game.exeDir)}>
                    打开目录
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void removeGame(game)}>
                    移除
                  </Button>
                </footer>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
