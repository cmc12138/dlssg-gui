import { JsonStore } from './store'
import { gamesFile, packagesFile, settingsFile } from './paths'
import type { AppSettings, GameEntry, RuntimePackage } from '@shared/types'

export const settingsStore = new JsonStore<AppSettings>(settingsFile, () => ({
  defaultProxy: 'version.dll',
  confirmBeforeInstall: true,
  keepBackups: 3,
  preferMirror: true
}))

export interface GamesFile {
  games: GameEntry[]
}

export interface PackagesFile {
  packages: RuntimePackage[]
}

export const gamesStore = new JsonStore<GamesFile>(gamesFile, () => ({ games: [] }))
export const packagesStore = new JsonStore<PackagesFile>(packagesFile, () => ({ packages: [] }))

export async function listGames(): Promise<GameEntry[]> {
  return (await gamesStore.read()).games
}

export async function getGame(id: string): Promise<GameEntry | undefined> {
  return (await listGames()).find((g) => g.id === id)
}

export async function saveGame(game: GameEntry): Promise<void> {
  game.updatedAt = new Date().toISOString()
  await gamesStore.update((file) => {
    const index = file.games.findIndex((g) => g.id === game.id)
    if (index >= 0) file.games[index] = game
    else file.games.push(game)
  })
}

export async function deleteGame(id: string): Promise<void> {
  await gamesStore.update((file) => {
    file.games = file.games.filter((g) => g.id !== id)
  })
}

export async function listPackages(): Promise<RuntimePackage[]> {
  return (await packagesStore.read()).packages
}

export async function getPackage(id: string): Promise<RuntimePackage | undefined> {
  return (await listPackages()).find((p) => p.id === id)
}

export async function savePackage(pkg: RuntimePackage): Promise<void> {
  await packagesStore.update((file) => {
    const index = file.packages.findIndex((p) => p.id === pkg.id)
    if (index >= 0) file.packages[index] = pkg
    else file.packages.push(pkg)
  })
}

export async function deletePackageRecord(id: string): Promise<void> {
  await packagesStore.update((file) => {
    file.packages = file.packages.filter((p) => p.id !== id)
  })
}
