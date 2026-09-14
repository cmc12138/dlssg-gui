import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode, type JSX } from 'react'
import type {
  AppSettings,
  EnvironmentInfo,
  GameEntry,
  GameStatus,
  ProgressEvent,
  RuntimePackage,
  ScannedGame
} from '@shared/types'
import { useToasts } from './components/ui'

export interface ScanState {
  running: boolean
  progress?: ProgressEvent
  results: ScannedGame[]
  warnings: string[]
}

interface AppData {
  env?: EnvironmentInfo
  settings?: AppSettings
  packages: RuntimePackage[]
  games: GameEntry[]
  statuses: Record<string, GameStatus>
  loading: boolean
  scan: ScanState
  progress?: ProgressEvent
  refreshEnv: () => Promise<void>
  refreshPackages: () => Promise<void>
  refreshGames: () => Promise<void>
  refreshStatuses: (ids?: string[]) => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  runScan: () => Promise<void>
  clearScan: () => void
  notify: (message: string, tone?: 'ok' | 'bad' | 'info') => void
  toasts: ReturnType<typeof useToasts>['toasts']
}

const AppContext = createContext<AppData | null>(null)

export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const [env, setEnv] = useState<EnvironmentInfo>()
  const [settings, setSettings] = useState<AppSettings>()
  const [packages, setPackages] = useState<RuntimePackage[]>([])
  const [games, setGames] = useState<GameEntry[]>([])
  const [statuses, setStatuses] = useState<Record<string, GameStatus>>({})
  const [loading, setLoading] = useState(true)
  const [progress, setProgress] = useState<ProgressEvent>()
  const [scan, setScan] = useState<ScanState>({ running: false, results: [], warnings: [] })
  const { toasts, push } = useToasts()

  const refreshEnv = useCallback(async () => {
    setEnv(await window.api.getEnvironment())
  }, [])

  const refreshPackages = useCallback(async () => {
    setPackages(await window.api.listPackages())
  }, [])

  const refreshGames = useCallback(async () => {
    setGames(await window.api.listGames())
  }, [])

  const refreshStatuses = useCallback(async (ids?: string[]) => {
    const list = ids ?? (await window.api.listGames()).map((game) => game.id)
    const entries = await Promise.all(
      list.map(async (id) => {
        try {
          return [id, await window.api.gameStatus(id, false)] as const
        } catch {
          return null
        }
      })
    )
    setStatuses((current) => {
      const next = { ...current }
      for (const entry of entries) if (entry) next[entry[0]] = entry[1]
      return next
    })
  }, [])

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    setSettings(await window.api.updateSettings(patch))
  }, [])

  const runScan = useCallback(async () => {
    setScan({ running: true, results: [], warnings: [] })
    try {
      const response = await window.api.scanGames()
      setScan({ running: false, results: response.games, warnings: response.warnings })
      push(`扫描完成：发现 ${response.games.length} 个游戏，其中 ${response.games.filter((g) => g.dlssgCapable).length} 个支持 DLSS 帧生成`, 'ok')
    } catch (error) {
      setScan({ running: false, results: [], warnings: [(error as Error).message] })
      push(`扫描失败：${(error as Error).message}`, 'bad')
    }
  }, [push])

  const clearScan = useCallback(() => setScan({ running: false, results: [], warnings: [] }), [])

  useEffect(() => {
    void (async () => {
      try {
        const [environment, loadedSettings, loadedPackages, loadedGames] = await Promise.all([
          window.api.getEnvironment(),
          window.api.getSettings(),
          window.api.listPackages(),
          window.api.listGames()
        ])
        setEnv(environment)
        setSettings(loadedSettings)
        setPackages(loadedPackages)
        setGames(loadedGames)
        await refreshStatuses(loadedGames.map((game) => game.id))
      } finally {
        setLoading(false)
      }
    })()
  }, [refreshStatuses])

  useEffect(() => {
    const off = window.api.onProgress((event) => {
      setProgress(event)
      if (event.scope === 'scan') {
        setScan((current) => ({ ...current, running: true, progress: event }))
      }
    })
    return off
  }, [])

  const value = useMemo<AppData>(
    () => ({
      env,
      settings,
      packages,
      games,
      statuses,
      loading,
      scan,
      progress,
      refreshEnv,
      refreshPackages,
      refreshGames,
      refreshStatuses,
      updateSettings,
      runScan,
      clearScan,
      notify: push,
      toasts
    }),
    [
      env,
      settings,
      packages,
      games,
      statuses,
      loading,
      scan,
      progress,
      refreshEnv,
      refreshPackages,
      refreshGames,
      refreshStatuses,
      updateSettings,
      runScan,
      clearScan,
      push,
      toasts
    ]
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppData {
  const context = useContext(AppContext)
  if (!context) throw new Error('useApp 必须在 AppProvider 内使用')
  return context
}
