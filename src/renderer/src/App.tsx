import { useState, type JSX } from 'react'
import { Button, ProgressStrip, ToastStack } from './components/ui'
import { AppProvider, useApp } from './state'
import { Dashboard } from './pages/Dashboard'
import { Games } from './pages/Games'
import { GameDetail } from './pages/GameDetail'
import { Library } from './pages/Library'
import { Settings } from './pages/Settings'

type Route = { name: 'dashboard' } | { name: 'games' } | { name: 'game'; id: string } | { name: 'library' } | { name: 'settings' }

function Shell(): JSX.Element {
  const app = useApp()
  const [route, setRoute] = useState<Route>({ name: 'dashboard' })

  const nav: { key: Route['name']; label: string; count?: number }[] = [
    { key: 'dashboard', label: '概览' },
    { key: 'games', label: '游戏', count: app.games.length },
    { key: 'library', label: '运行库', count: app.packages.length },
    { key: 'settings', label: '设置' }
  ]

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">FG</span>
          <div>
            <strong>DLSSG GUI</strong>
            <p className="muted small">帧生成注入管理器</p>
          </div>
        </div>
        <nav>
          {nav.map((item) => (
            <button
              type="button"
              key={item.key}
              className={`nav-item${
                route.name === item.key || (item.key === 'games' && route.name === 'game') ? ' nav-active' : ''
              }`}
              onClick={() => setRoute({ name: item.key } as Route)}
            >
              <span>{item.label}</span>
              {item.count !== undefined && <span className="nav-count">{item.count}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <p className="muted small">
            {app.env?.gpus[0]?.name ?? '未检测到显卡'}
            {app.env?.driverMajor ? ` · 驱动 ${app.env.driverMajor}` : ''}
          </p>
          <Button size="sm" variant="ghost" onClick={() => void app.refreshEnv()}>
            重新检测环境
          </Button>
        </div>
      </aside>

      <main className="content">
        <ProgressStrip event={app.progress} />
        {route.name === 'dashboard' && (
          <Dashboard
            onGoGames={() => setRoute({ name: 'games' })}
            onGoLibrary={() => setRoute({ name: 'library' })}
            onOpenGame={(id) => setRoute({ name: 'game', id })}
          />
        )}
        {route.name === 'games' && <Games onOpenGame={(id) => setRoute({ name: 'game', id })} />}
        {route.name === 'game' && (
          <GameDetail gameId={route.id} onBack={() => setRoute({ name: 'games' })} onGoLibrary={() => setRoute({ name: 'library' })} />
        )}
        {route.name === 'library' && <Library />}
        {route.name === 'settings' && <Settings />}
      </main>
      <ToastStack toasts={app.toasts} />
    </div>
  )
}

export default function App(): JSX.Element {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  )
}
