import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 货物装卸三步链路：列表入口 → 详情页 → 保障回写。
// 全链路只认这一个完成判定与确认入口：件数吨位、abnormal 等历史字段在任何一步都不会被改写，
// 特种车辆调度清单也从同一份货物装卸记录派生，两侧结果天然一致。

const CARGO_KEY = 'cargo'
const FLIGHT_KEY = 'flight_ops'

const CARGO_STATUS = {
  done: '已完成',
  aborted: '异常中断',
} as const

// 统一完成判定：列表、详情页、保障回写、特种车辆调度清单都以此为准，不再各自解释状态。
export function isCargoCompleted(row: EntryRow): boolean {
  return String(row.status) === CARGO_STATUS.done
}

// ---------------------------------------------------------------------------
// 断点持久化：确认完成与保障回写是两步写操作，中间任何一步失败都把断点存下来，
// 下次从断点继续，而不是从头再来。
// ---------------------------------------------------------------------------

const CHECKPOINT_STORAGE_KEY = 'airport-ground-handling:cargo-flow'

export type FlowStep = 'confirm' | 'writeback'

export type ConfirmContext = {
  operator?: string
  /** 调用方看到的关联航班：与当前记录不一致即归属不符，拒绝改动 */
  flight?: string
}

export type FlowCheckpoint = {
  cargoId: number
  nextStep: FlowStep
  context: ConfirmContext
  updatedAt: string
}

function readCheckpoints(): FlowCheckpoint[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(CHECKPOINT_STORAGE_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as FlowCheckpoint[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeCheckpoints(checkpoints: FlowCheckpoint[]): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(CHECKPOINT_STORAGE_KEY, JSON.stringify(checkpoints))
}

export function getCargoCheckpoint(cargoId: number): FlowCheckpoint | null {
  return readCheckpoints().find((item) => item.cargoId === cargoId) ?? null
}

function saveCheckpoint(cargoId: number, nextStep: FlowStep, context: ConfirmContext): void {
  const rest = readCheckpoints().filter((item) => item.cargoId !== cargoId)
  rest.push({ cargoId, nextStep, context, updatedAt: formatNow() })
  writeCheckpoints(rest)
}

function clearCheckpoint(cargoId: number): void {
  writeCheckpoints(readCheckpoints().filter((item) => item.cargoId !== cargoId))
}

// ---------------------------------------------------------------------------
// 确认完成：幂等 + 并发只留一次
// ---------------------------------------------------------------------------

type StepResult = ActionResult & { changed?: boolean }

// 在途提交：同一装卸编号的并发提交只留第一次，后续调用直接复用在途结果。
const inflight = new Map<number, Promise<ActionResult>>()

export function confirmCargoCompletion(id: number, context: ConfirmContext = {}): Promise<ActionResult> {
  const running = inflight.get(id)
  if (running) {
    return running
  }
  const task = runChain(id, context).finally(() => {
    inflight.delete(id)
  })
  inflight.set(id, task)
  return task
}

async function runChain(id: number, context: ConfirmContext): Promise<ActionResult> {
  const checkpoint = getCargoCheckpoint(id)
  const startAt: FlowStep = checkpoint ? checkpoint.nextStep : 'confirm'
  // 断点续跑时沿用断点里冻结的上下文，保证归属校验口径不变
  const effectiveContext = checkpoint ? checkpoint.context : context
  let changed = false

  if (startAt === 'confirm') {
    const confirmed = await confirmStep(id, effectiveContext)
    if (!confirmed.ok) {
      return confirmed
    }
    changed = confirmed.changed === true
    saveCheckpoint(id, 'writeback', effectiveContext)
  }

  const writtenBack = await writebackStep(id)
  if (!writtenBack.ok) {
    // 断点已留在 writeback：本次未完成的步骤下次从这里继续
    return writtenBack
  }
  changed = changed || writtenBack.changed === true

  clearCheckpoint(id)
  return {
    ok: true,
    message: changed
      ? '货物装卸已确认完成，保障回写与特种车辆调度清单已同步真实结果'
      : '重复确认：完成判定、件数吨位与保障回写均已存在，未做改动',
  }
}

async function confirmStep(id: number, context: ConfirmContext): Promise<StepResult> {
  // 让出事件循环，并发守卫才有意义
  await Promise.resolve()
  const rows = listRows(CARGO_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的货物装卸` }
  }
  const row = rows[index]

  // 历史异常记录保持原口径：异常中断的记录不参与完成判定，也不被改动
  if (String(row.status) === CARGO_STATUS.aborted) {
    return { ok: false, message: `装卸编号 ${row['装卸编号']} 已异常中断，历史异常保持原口径，不做改动` }
  }

  // 归属不符不得改动：调用方看到的关联航班与当前记录不一致时直接拒绝
  if (context.flight !== undefined && context.flight !== String(row['关联航班'] ?? '')) {
    return {
      ok: false,
      message: `归属不符：装卸编号 ${row['装卸编号']} 现归属「${row['关联航班']}」，与本次操作的「${context.flight}」不一致，未做改动`,
    }
  }

  // 统一完成判定：已完成的重复确认幂等返回，件数吨位原样保留
  if (isCargoCompleted(row)) {
    return { ok: true, changed: false, message: '完成判定已存在' }
  }

  const updated: EntryRow = {
    ...row,
    status: CARGO_STATUS.done,
    pending: false,
    实际完成: formatNow(),
    装卸状态: CARGO_STATUS.done,
    // 件数吨位、货物品类、abnormal 等历史字段一律保持原样
  }
  const next = [...rows]
  next[index] = updated
  saveRows(CARGO_KEY, next)
  return { ok: true, changed: true, message: `装卸编号 ${row['装卸编号']} 已确认完成` }
}

async function writebackStep(id: number): Promise<StepResult> {
  await Promise.resolve()
  const row = listRows(CARGO_KEY).find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的货物装卸` }
  }
  const flight = String(row['关联航班'] ?? '')
  const note = `货物装卸已完成（${row['装卸编号']}，${row['件数吨位']}）`
  const flights = listRows(FLIGHT_KEY)
  const index = flights.findIndex((item) => String(item['航班号'] ?? '') === flight)
  // 归属不符不得改动：航班保障里找不到归属航班，回写失败且不改动任何记录，断点保留
  if (index < 0) {
    return {
      ok: false,
      message: `保障回写失败：航班保障中没有归属航班「${flight}」，未改动任何记录，可从断点继续`,
    }
  }
  const target = flights[index]
  const current = String(target['保障节点'] ?? '')
  // 幂等回写：同一装卸编号只回写一次
  if (current.includes(String(row['装卸编号'] ?? ''))) {
    return { ok: true, changed: false, message: '保障节点已回写过' }
  }
  const updated: EntryRow = { ...target, 保障节点: current ? `${current}；${note}` : note }
  const next = [...flights]
  next[index] = updated
  saveRows(FLIGHT_KEY, next)
  return { ok: true, changed: true, message: `已回写航班保障「${flight}」的保障节点` }
}

// ---------------------------------------------------------------------------
// 断点续跑
// ---------------------------------------------------------------------------

export function resumeCargoFlow(id: number): Promise<ActionResult> {
  const checkpoint = getCargoCheckpoint(id)
  if (!checkpoint) {
    return Promise.resolve({ ok: false, message: '没有待续跑的断点' })
  }
  return confirmCargoCompletion(id, checkpoint.context)
}

// 页面挂载时调用：把所有未完成的三步链路从各自断点继续跑完。
export async function resumePendingFlows(): Promise<ActionResult[]> {
  const results: ActionResult[] = []
  for (const checkpoint of readCheckpoints()) {
    results.push(await confirmCargoCompletion(checkpoint.cargoId, checkpoint.context))
  }
  return results
}

// ---------------------------------------------------------------------------
// 详情页视图与特种车辆调度清单
// ---------------------------------------------------------------------------

export type FlowStepView = { key: string; label: string; state: 'done' | 'ready' | 'waiting' | 'failed' }

export type CargoFlowView = {
  row: EntryRow
  completed: boolean
  checkpoint: FlowCheckpoint | null
  steps: FlowStepView[]
  writebackNote: string
}

export function getCargoFlowView(id: number): CargoFlowView | null {
  const row = listRows(CARGO_KEY).find((item) => Number(item.id) === id)
  if (!row) {
    return null
  }
  const checkpoint = getCargoCheckpoint(id)
  const completed = isCargoCompleted(row)
  const steps: FlowStepView[] = [
    { key: 'list', label: '① 列表入口登记', state: 'done' },
    { key: 'confirm', label: '② 详情页确认完成', state: completed ? 'done' : 'ready' },
    { key: 'writeback', label: '③ 保障回写', state: checkpoint ? 'failed' : completed ? 'done' : 'waiting' },
  ]
  const flight = String(row['关联航班'] ?? '')
  const flightRow = listRows(FLIGHT_KEY).find((item) => String(item['航班号'] ?? '') === flight)
  return {
    row,
    completed,
    checkpoint,
    steps,
    writebackNote: flightRow ? String(flightRow['保障节点'] ?? '') : '',
  }
}

export type CargoDispatchEntry = {
  id: number
  装卸编号: string
  关联航班: string
  货物品类: string
  件数吨位: string
  完成时间: string
  完成判定: string
  当前状态: string
}

// 特种车辆调度清单：直接同源读取货物装卸记录，不另存拷贝，
// 完成判定与件数吨位永远和货物装卸侧一致；异常中断等历史状态按原口径展示。
export function listCargoDispatch(): CargoDispatchEntry[] {
  return listRows(CARGO_KEY).map((row) => {
    const completed = isCargoCompleted(row)
    return {
      id: Number(row.id),
      装卸编号: String(row['装卸编号'] ?? ''),
      关联航班: String(row['关联航班'] ?? ''),
      货物品类: String(row['货物品类'] ?? ''),
      件数吨位: String(row['件数吨位'] ?? ''),
      完成时间: completed ? String(row['实际完成'] ?? '—') : '—',
      完成判定: completed ? '已完成' : '未完成',
      当前状态: String(row.status ?? ''),
    }
  })
}

function formatNow(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}
