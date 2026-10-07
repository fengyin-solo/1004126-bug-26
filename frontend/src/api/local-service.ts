import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, getCargoJournal, listRows, resetRows, saveCargoJournal, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  CargoChainJournal,
  CargoChainResult,
  CargoChainStep,
  CargoChainStepKey,
  CargoCompletionJudgment,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  // 货物装卸的「确认完成」统一走三步链路：列表入口、详情页都汇到同一个完成判定，
  // 任何入口拿到的都是同一份结果，不会出现两侧对不上。
  if (key === CARGO_KEY && action === CARGO_CONFIRM_ACTION) {
    const row = listRows(key).find((item) => Number(item.id) === id)
    if (!row) {
      return { ok: false, message: `没有找到编号为 ${id} 的货物装卸` }
    }
    return confirmCargoChain(String(row['装卸编号']))
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// ============================================================================
// 货物装卸确认完成链路
//
// 三步链路：①确认完成（状态流转）→ ②保障回写（航班保障）→ ③调度清单同步（特种车辆）。
// 共享根因的修法：完成判定只有 judgeCargoCompletion 一处，确认动作只有 confirmCargoChain
// 一处；确认只翻状态，绝不重算、绝不清零件数吨位；台账既是幂等键（并发只留一次），
// 也是断点（失败从断点继续）；历史异常与归属不符的记录一律不改动。
// ============================================================================

const CARGO_KEY = 'cargo'
const FLIGHT_KEY = 'flight_ops'
const VEHICLE_KEY = 'special_vehicle'
const DISPATCH_KEY = 'vehicle_dispatch'
const CARGO_CONFIRM_ACTION = '确认完成'

const CHAIN_STEPS: { key: CargoChainStepKey; label: string }[] = [
  { key: 'confirm', label: '确认完成（状态流转）' },
  { key: 'writeback', label: '保障回写（航班保障）' },
  { key: 'dispatch', label: '调度清单同步（特种车辆）' },
]

// 并发提交只留一次：同一装卸编号在途只允许一个链路，其余直接忽略。
const cargoChainInFlight = new Set<string>()

function nowText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function getCargoByCode(code: string): EntryRow | null {
  return listRows(CARGO_KEY).find((row) => String(row['装卸编号']) === code) ?? null
}

export function getCargoChainJournal(code: string): CargoChainJournal | null {
  return getCargoJournal(code)
}

export function listVehicleDispatch(filters: Record<string, string> = {}): EntryRow[] {
  return filterRows(listRows(DISPATCH_KEY), filters)
}

export function findFlightSupport(flightNo: string): EntryRow | null {
  return listRows(FLIGHT_KEY).find((row) => String(row['航班号']) === flightNo) ?? null
}

/**
 * 统一完成判定：列表入口、详情页、链路内部共用这一个判定，是两侧结果一致的唯一来源。
 * 判定只看状态机，不看入口；异常中断的记录保持原口径，永远判为不可确认。
 */
export function judgeCargoCompletion(code: string): CargoCompletionJudgment {
  const row = getCargoByCode(code)
  if (!row) {
    return { kind: '不存在' }
  }
  const status = String(row.status)
  if (status === '已完成') {
    return { kind: '已完成', row, journal: getCargoJournal(code) }
  }
  if (status === '异常中断') {
    return { kind: '异常中断', row }
  }
  if (status !== '装卸中') {
    return { kind: '待装卸', row }
  }
  return { kind: '可确认', row }
}

/** 确认完成链路入口：并发去重在这里收口，同一装卸编号同时在途的提交只留一个。 */
export function confirmCargoChain(code: string): CargoChainResult {
  if (cargoChainInFlight.has(code)) {
    return { ok: false, message: `装卸编号 ${code} 的确认链路正在执行，重复提交已忽略（只留一次）` }
  }
  cargoChainInFlight.add(code)
  try {
    return runCargoChain(code)
  } finally {
    cargoChainInFlight.delete(code)
  }
}

function newCargoJournal(code: string): CargoChainJournal {
  return {
    code,
    status: '进行中',
    steps: CHAIN_STEPS.map(({ key, label }) => ({ key, label, state: '待执行', message: '' })),
    result: '',
    updatedAt: nowText(),
  }
}

function failCargoChain(journal: CargoChainJournal, step: CargoChainStep, error: unknown): CargoChainResult {
  step.state = '失败'
  step.message = error instanceof Error ? error.message : '执行失败'
  journal.status = '失败'
  journal.updatedAt = nowText()
  saveCargoJournal(journal)
  return {
    ok: false,
    journal,
    message: `链路在「${step.label}」中断：${step.message}。断点已记录，处理后重新提交将从断点继续`,
  }
}

function runCargoChain(code: string): CargoChainResult {
  // 第一道：统一完成判定，先把不该走的单挡在链路外。
  const judgment = judgeCargoCompletion(code)
  if (judgment.kind === '不存在') {
    return { ok: false, message: `没有找到装卸编号为 ${code} 的货物装卸` }
  }
  if (judgment.kind === '异常中断') {
    return { ok: false, message: `装卸编号 ${code} 已异常中断，历史异常记录保持原口径，不能确认完成` }
  }
  if (judgment.kind === '待装卸') {
    return { ok: false, message: `装卸编号 ${code} 尚未开始装卸，请先执行「开始装卸」` }
  }
  if (judgment.kind === '已完成') {
    // 状态已是已完成但台账没跑完：说明上次链路中途失败，落入下方从断点继续，
    // 不能被「已完成」三个字骗过去——判定要看台账，不能只看状态。
    const unfinished = judgment.journal && judgment.journal.status !== '已完成'
    if (!unfinished) {
      // 重复确认只留一次：直接沿用首次结果，不重算、不清零件数吨位。
      const qty = String(judgment.row['件数吨位'] ?? '')
      return {
        ok: true,
        deduped: true,
        journal: judgment.journal ?? undefined,
        message: judgment.journal?.result
          ? `重复提交已去重，沿用首次结果：${judgment.journal.result}`
          : `装卸编号 ${code} 已是已完成，件数吨位保持「${qty}」不变`,
      }
    }
  }

  const row = judgment.row
  const flight = String(row['关联航班'] ?? '').trim()
  const qty = String(row['件数吨位'] ?? '')

  // 第二道：台账断点。已有台账说明上次没跑完，从第一个未完成的步骤继续；
  // 台账已完成的（另一个入口先跑完）直接沿用，不重复执行。
  let journal = getCargoJournal(code)
  if (journal && journal.status === '已完成' && judgment.kind === '可确认') {
    // 记录被重置回装卸中（如 resetModule）：旧台账已不适用，作废重建。
    journal = null
  }
  const resumed = !!journal && journal.steps.some((step) => step.state !== '待执行')
  if (!journal) {
    journal = newCargoJournal(code)
  } else if (journal.status === '已完成') {
    return { ok: true, deduped: true, journal, message: `重复提交已去重，沿用首次结果：${journal.result}` }
  }
  journal.status = '进行中'
  journal.updatedAt = nowText()
  saveCargoJournal(journal)

  // ①确认完成：只翻状态与完成时间，件数吨位、abnormal 等一律不动。
  // 台账说做完了但记录其实没翻状态（数据被重置过）时，以记录为准补做这一步。
  const confirmStep = journal.steps[0]
  const rowAlreadyDone = String(row.status) === '已完成'
  if (confirmStep.state !== '已完成' || !rowAlreadyDone) {
    try {
      const rows = listRows(CARGO_KEY)
      const index = rows.findIndex((item) => String(item['装卸编号']) === code)
      if (index < 0) {
        throw new Error('货物装卸记录不存在')
      }
      const next = [...rows]
      next[index] = { ...next[index], status: '已完成', pending: false, 装卸状态: '已完成', 实际完成: nowText() }
      saveRows(CARGO_KEY, next)
      confirmStep.state = '已完成'
      confirmStep.message = `货物装卸已确认完成，件数吨位保持「${qty}」`
    } catch (error) {
      return failCargoChain(journal, confirmStep, error)
    }
    journal.updatedAt = nowText()
    saveCargoJournal(journal)
  }

  // ②保障回写：只写归属本航班的保障记录；归属不符不得改动，跳过并记录。
  const writebackStep = journal.steps[1]
  if (writebackStep.state !== '已完成' && writebackStep.state !== '已跳过') {
    try {
      if (!flight) {
        throw new Error('关联航班为空，无法定位保障记录')
      }
      const rows = listRows(FLIGHT_KEY)
      const index = rows.findIndex((item) => String(item['航班号']) === flight)
      if (index < 0) {
        writebackStep.state = '已跳过'
        writebackStep.message = `航班 ${flight} 没有归属的保障记录，回写跳过（归属不符不得改动）`
      } else {
        const next = [...rows]
        next[index] = { ...next[index], 保障节点: `货物装卸已完成(${code})` }
        saveRows(FLIGHT_KEY, next)
        writebackStep.state = '已完成'
        writebackStep.message = `已回写航班 ${flight} 保障节点：货物装卸已完成(${code})`
      }
    } catch (error) {
      return failCargoChain(journal, writebackStep, error)
    }
    journal.updatedAt = nowText()
    saveCargoJournal(journal)
  }

  // ③调度清单同步：把真实结果写回特种车辆调度清单，并收回归属车辆。
  // 历史异常的调度单保持原口径；关联航班对不上的调度单归属不符，一律不改动。
  const dispatchStep = journal.steps[2]
  if (dispatchStep.state !== '已完成' && dispatchStep.state !== '已跳过') {
    try {
      const notes: string[] = []
      const syncedVehicleCodes = new Set<string>()
      let synced = 0
      const nextDispatches = listRows(DISPATCH_KEY).map((item) => {
        if (String(item['装卸编号']) !== code) {
          return item
        }
        if (item.abnormal || String(item.status) === '异常') {
          notes.push(`${item['调度编号']}为历史异常，保持原口径未改动`)
          return item
        }
        if (String(item['关联航班']) !== flight) {
          notes.push(`${item['调度编号']}关联航班归属不符，未改动`)
          return item
        }
        synced += 1
        syncedVehicleCodes.add(String(item['车辆编号']))
        return {
          ...item,
          status: '已收车',
          pending: false,
          调度状态: '已收车',
          实际收车: nowText(),
          实际结果: `货物装卸已完成(${code})`,
        }
      })
      const vehicles = listRows(VEHICLE_KEY)
      const knownVehicles = new Set(vehicles.map((item) => String(item['车辆编号'])))
      for (const vehicleCode of syncedVehicleCodes) {
        if (!knownVehicles.has(vehicleCode)) {
          notes.push(`车辆 ${vehicleCode} 不存在，车辆状态未改动（归属不符）`)
        }
      }
      let returned = 0
      const nextVehicles = vehicles.map((item) => {
        if (!syncedVehicleCodes.has(String(item['车辆编号'])) || String(item.status) !== '出车中') {
          return item
        }
        returned += 1
        return { ...item, status: '待命', pending: true, 车辆状态: '待命' }
      })
      saveRows(DISPATCH_KEY, nextDispatches)
      saveRows(VEHICLE_KEY, nextVehicles)
      dispatchStep.state = synced > 0 ? '已完成' : '已跳过'
      dispatchStep.message =
        synced > 0
          ? [`调度清单已同步真实结果：${synced} 张调度单收车、${returned} 辆车回待命`, ...notes].join('；')
          : ['没有归属本装卸编号的调度单，同步跳过', ...notes].join('；')
    } catch (error) {
      return failCargoChain(journal, dispatchStep, error)
    }
    journal.updatedAt = nowText()
    saveCargoJournal(journal)
  }

  // 收尾：首次定口径，之后的重复提交都原样返回这份结果。
  journal.status = '已完成'
  journal.result = [
    `装卸编号 ${code} 确认完成，件数吨位「${qty}」保持不变`,
    ...journal.steps.map((step) => step.message).filter((message) => message !== ''),
  ].join('；')
  journal.updatedAt = nowText()
  saveCargoJournal(journal)
  return {
    ok: true,
    journal,
    resumed,
    message: resumed ? `已从断点继续并跑完链路：${journal.result}` : journal.result,
  }
}
