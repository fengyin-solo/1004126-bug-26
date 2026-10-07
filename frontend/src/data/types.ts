/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// ---- 货物装卸确认完成链路：统一完成判定 + 三步链路台账 ----

/** 链路步骤：①确认完成（状态流转） ②保障回写（航班保障） ③调度清单同步（特种车辆） */
export type CargoChainStepKey = 'confirm' | 'writeback' | 'dispatch'

export type CargoChainStep = {
  key: CargoChainStepKey
  label: string
  state: '待执行' | '已完成' | '已跳过' | '失败'
  message: string
}

/** 链路台账：每个装卸编号一份，既是幂等键（并发只留一次），也是断点（失败从这里继续）。 */
export type CargoChainJournal = {
  code: string
  status: '进行中' | '已完成' | '失败'
  steps: CargoChainStep[]
  /** 首次确认完成时定下的口径（含件数吨位快照），重复提交原样返回，不再重算。 */
  result: string
  updatedAt: string
}

/** 统一完成判定：列表入口、详情页、链路内部都用这一个结果，保证两侧一致。 */
export type CargoCompletionJudgment =
  | { kind: '可确认'; row: EntryRow }
  | { kind: '已完成'; row: EntryRow; journal: CargoChainJournal | null }
  | { kind: '待装卸'; row: EntryRow }
  | { kind: '异常中断'; row: EntryRow }
  | { kind: '不存在' }

export type CargoChainResult = ActionResult & {
  journal?: CargoChainJournal
  /** 重复提交被去重，沿用首次结果 */
  deduped?: boolean
  /** 本次是从失败断点继续执行的 */
  resumed?: boolean
}
