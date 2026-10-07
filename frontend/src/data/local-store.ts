import { SEED_ROWS } from './seed'
import type { CargoChainJournal, EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-handling:entries'
// 货物装卸确认完成链路的台账：与业务数据分开存，互不污染。
const JOURNAL_KEY = 'airport-ground-handling:cargo-chain-journal'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// ---- 链路台账读写：每个装卸编号一份，链路每跑完一步就落一次，失败后可从断点继续 ----

function readJournals(): Record<string, CargoChainJournal> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {}
  }
  const raw = window.localStorage.getItem(JOURNAL_KEY)
  if (!raw) {
    return {}
  }
  try {
    return JSON.parse(raw) as Record<string, CargoChainJournal>
  } catch {
    return {}
  }
}

export function getCargoJournal(code: string): CargoChainJournal | null {
  return readJournals()[code] ?? null
}

export function saveCargoJournal(journal: CargoChainJournal): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  const all = readJournals()
  all[journal.code] = journal
  window.localStorage.setItem(JOURNAL_KEY, JSON.stringify(all))
}
