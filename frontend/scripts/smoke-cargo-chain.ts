// 冒烟测试：在 node 里用内存 localStorage 跑货物装卸确认完成链路。
// 用法：esbuild 打包后执行（见下方命令），断言全部通过会打印 ALL PASS。
const store: Record<string, string> = {}
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v)
    },
    removeItem: (k: string) => {
      delete store[k]
    },
  },
}

import {
  confirmCargoChain,
  findFlightSupport,
  getCargoByCode,
  getCargoChainJournal,
  judgeCargoCompletion,
  listVehicleDispatch,
  resetModule,
  runAction,
} from '@/api/local-service'
import { listRows, saveRows } from '@/data/local-store'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`PASS ${name}`)
  } else {
    failed += 1
    console.log(`FAIL ${name}`, extra ?? '')
  }
}

// ---------- 1. 统一完成判定 ----------
check('判定 CARG-0004 = 可确认', judgeCargoCompletion('CARG-0004').kind === '可确认')
check('判定 CARG-0005 = 待装卸', judgeCargoCompletion('CARG-0005').kind === '待装卸')
check('判定 CARG-0003 = 已完成', judgeCargoCompletion('CARG-0003').kind === '已完成')
check('判定 不存在', judgeCargoCompletion('CARG-9999').kind === '不存在')

// ---------- 2. 正常三步链路 ----------
const r1 = confirmCargoChain('CARG-0004')
check('链路成功', r1.ok, r1.message)
const j1 = getCargoChainJournal('CARG-0004')
check('台账已完成', j1?.status === '已完成', j1)
check('三步都走完', j1?.steps.every((s) => s.state === '已完成' || s.state === '已跳过'), j1?.steps)
const cargo4 = getCargoByCode('CARG-0004')
check('状态=已完成', cargo4?.status === '已完成')
check('件数吨位未清零', cargo4?.['件数吨位'] === '120件/2.4吨', cargo4?.['件数吨位'])
check('实际完成已写入', cargo4?.['实际完成'] !== '待确认')
const flight = findFlightSupport('CA1821')
check('保障回写', String(flight?.['保障节点']).includes('货物装卸已完成(CARG-0004)'), flight?.['保障节点'])
const dispatches = listVehicleDispatch()
const d1 = dispatches.find((d) => d['调度编号'] === 'DISP-0001')
const d3 = dispatches.find((d) => d['调度编号'] === 'DISP-0003')
const d4 = dispatches.find((d) => d['调度编号'] === 'DISP-0004')
check('DISP-0001 已收车+真实结果', d1?.status === '已收车' && String(d1?.['实际结果']).includes('CARG-0004'), d1)
check('DISP-0004 归属不符未改动', d4?.status === '出车中' && d4?.['实际结果'] === '待回写', d4)
check('DISP-0003 历史异常保持原口径', d3?.status === '异常' && d3?.abnormal === true && d3?.['实际结果'] === '车辆故障中断，已换车', d3)
const spec4 = listRows('special_vehicle').find((v) => v['车辆编号'] === 'SPEC-0004')
const spec5 = listRows('special_vehicle').find((v) => v['车辆编号'] === 'SPEC-0005')
check('SPEC-0004 收车回待命', spec4?.status === '待命', spec4?.status)
check('SPEC-0005 不受影响', spec5?.status === '待命' && spec5?.['车辆状态'] === '待命')

// ---------- 3. 并发/重复提交只留一次 ----------
const r2 = confirmCargoChain('CARG-0004')
check('重复确认幂等去重', r2.ok && r2.deduped === true, r2.message)
check('重复确认后件数吨位仍不变', getCargoByCode('CARG-0004')?.['件数吨位'] === '120件/2.4吨')
const r3 = runAction('cargo', 4, '确认完成')
check('runAction 统一走链路且幂等', r3.ok && (r3 as { deduped?: boolean }).deduped === true, r3.message)

// ---------- 4. 历史异常保持原口径（CARG-0002：装卸中 + abnormal） ----------
const r4 = confirmCargoChain('CARG-0002')
check('CARG-0002 链路可跑通', r4.ok, r4.message)
const cargo2 = getCargoByCode('CARG-0002')
check('CARG-0002 abnormal 标志不动', cargo2?.abnormal === true, cargo2)
const j2 = getCargoChainJournal('CARG-0002')
check('CARG-0002 回写跳过（归属不符）', j2?.steps[1].state === '已跳过', j2?.steps[1])
check('CARG-0002 调度同步保留历史异常', j2?.steps[2].message.includes('保持原口径'), j2?.steps[2])

// ---------- 5. 待装卸 / 异常中断 拒绝 ----------
check('待装卸拒绝', !confirmCargoChain('CARG-0005').ok)
// 造一条异常中断：链路必须拒绝且一个字都不改。
const rowsA = listRows('cargo')
const idxA = rowsA.findIndex((r) => r['装卸编号'] === 'CARG-0003')
rowsA[idxA] = { ...rowsA[idxA], status: '异常中断', abnormal: true }
saveRows('cargo', rowsA)
const beforeA = getCargoByCode('CARG-0003')
const rA = confirmCargoChain('CARG-0003')
const afterA = getCargoByCode('CARG-0003')
check('异常中断拒绝', !rA.ok, rA.message)
check('异常中断记录原口径未动', JSON.stringify(beforeA) === JSON.stringify(afterA), afterA)

// ---------- 6. 失败从断点继续 ----------
// 构造：CARG-0005 开始装卸后清空关联航班 → 第②步失败；补回航班后重提 → 从断点继续。
const rows = listRows('cargo')
const idx5 = rows.findIndex((r) => r['装卸编号'] === 'CARG-0005')
rows[idx5] = { ...rows[idx5], status: '装卸中', 装卸状态: '装卸中', 关联航班: '' }
saveRows('cargo', rows)
const r5 = confirmCargoChain('CARG-0005')
check('第②步失败', !r5.ok && r5.journal?.status === '失败', r5.message)
check('断点停在第②步', r5.journal?.steps[0].state === '已完成' && r5.journal?.steps[1].state === '失败', r5.journal?.steps)
check('失败后件数吨位未动', getCargoByCode('CARG-0005')?.['件数吨位'] === '86件/1.1吨')
const rows2 = listRows('cargo')
const idx5b = rows2.findIndex((r) => r['装卸编号'] === 'CARG-0005')
rows2[idx5b] = { ...rows2[idx5b], 关联航班: 'CA1822' }
saveRows('cargo', rows2)
const r6 = confirmCargoChain('CARG-0005')
check('从断点继续并完成', r6.ok && r6.resumed === true, r6.message)
const j5 = getCargoChainJournal('CARG-0005')
check('断点续跑后台账已完成', j5?.status === '已完成')
check('第①步未重复执行（断点续跑）', j5?.steps[0].message.includes('件数吨位保持'), j5?.steps[0])
const d2 = listVehicleDispatch().find((d) => d['调度编号'] === 'DISP-0002')
check('DISP-0002 已同步真实结果', d2?.status === '已收车' && String(d2?.['实际结果']).includes('CARG-0005'), d2)
check('CA1822 保障回写', String(findFlightSupport('CA1822')?.['保障节点']).includes('货物装卸已完成(CARG-0005)'))

// ---------- 7. 数据重置后台账自愈 ----------
// resetModule 把记录打回种子（CARG-0004 回到装卸中），旧台账仍是已完成：
// 重新确认必须全链路重跑，而不是被旧台账幂等掉。
resetModule('cargo')
const r7 = confirmCargoChain('CARG-0004')
check('重置后可重新确认（台账自愈）', r7.ok && r7.deduped !== true, r7.message)
check('重置后状态再翻完成', getCargoByCode('CARG-0004')?.status === '已完成')
check('重置后件数吨位仍未动', getCargoByCode('CARG-0004')?.['件数吨位'] === '120件/2.4吨')

console.log(failed === 0 ? 'ALL PASS' : `${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
