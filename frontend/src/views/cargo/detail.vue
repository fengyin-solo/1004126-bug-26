<template>
  <section class="page" data-module="cargo-detail">
    <header class="page-head">
      <div>
        <h2>货物装卸详情 · {{ code }}</h2>
        <p class="page-desc">装卸编号在列表入口、详情页与保障回写之间共用同一份数据，确认完成走统一三步链路。</p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn ghost" to="/cargo">返回列表</RouterLink>
        <button
          v-if="judgmentKind === '可确认' || (journal && journal.status === '失败')"
          class="btn primary"
          type="button"
          :disabled="submitting"
          @click="confirm"
        >
          {{ submitting ? '提交中…' : journal && journal.status === '失败' ? '从断点继续' : '确认完成' }}
        </button>
      </div>
    </header>

    <template v-if="row">
      <h3 class="section-title">装卸单信息</h3>
      <table class="data-table">
        <tbody>
          <tr v-for="field in fields" :key="field">
            <th class="field-name">{{ field }}</th>
            <td>{{ row[field] ?? '—' }}</td>
          </tr>
          <tr>
            <th class="field-name">当前状态</th>
            <td>{{ row.status }}</td>
          </tr>
        </tbody>
      </table>

      <h3 class="section-title">统一完成判定</h3>
      <p class="judgment" :data-kind="judgmentKind">
        判定结果：<strong>{{ judgmentText }}</strong>
        <span class="judgment-note">列表入口与本详情页共用同一判定，两侧结果一致；确认不会改动件数吨位。</span>
      </p>

      <h3 class="section-title">三步链路进度</h3>
      <table v-if="journal" class="data-table">
        <thead>
          <tr><th>步骤</th><th>状态</th><th>说明</th></tr>
        </thead>
        <tbody>
          <tr v-for="step in journal.steps" :key="step.key">
            <td>{{ step.label }}</td>
            <td>{{ step.state }}</td>
            <td>{{ step.message || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">链路尚未发起，点击「确认完成」开始三步链路。</p>
      <p v-if="journal" class="judgment-note">台账状态：{{ journal.status }} · 更新于 {{ journal.updatedAt }}</p>

      <h3 class="section-title">保障回写（航班保障）</h3>
      <table v-if="flightSupport" class="data-table">
        <thead>
          <tr><th>航班号</th><th>机尾号</th><th>保障节点</th><th>保障状态</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>{{ flightSupport['航班号'] }}</td>
            <td>{{ flightSupport['机尾号'] }}</td>
            <td>{{ flightSupport['保障节点'] }}</td>
            <td>{{ flightSupport.status }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">航班 {{ row['关联航班'] || '（空）' }} 没有归属的保障记录，回写将跳过（归属不符不得改动）。</p>

      <h3 class="section-title">特种车辆调度清单（本装卸编号）</h3>
      <table v-if="dispatches.length" class="data-table">
        <thead>
          <tr><th>调度编号</th><th>关联航班</th><th>车辆编号</th><th>调度状态</th><th>实际收车</th><th>实际结果</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in dispatches" :key="String(item.id)">
            <td>{{ item['调度编号'] }}</td>
            <td>{{ item['关联航班'] }}</td>
            <td>{{ item['车辆编号'] }}</td>
            <td>{{ item.status }}</td>
            <td>{{ item['实际收车'] }}</td>
            <td>{{ item['实际结果'] }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">本装卸编号暂无调度单。</p>
    </template>
    <p v-else class="empty-state">没有找到装卸编号为 {{ code }} 的货物装卸记录。</p>

    <footer class="page-foot">
      <span>装卸编号：{{ code }}</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import {
  confirmCargoChain,
  findFlightSupport,
  getCargoByCode,
  getCargoChainJournal,
  judgeCargoCompletion,
  listVehicleDispatch,
} from '@/api/local-service'
import type { CargoChainJournal, EntryRow } from '@/data/types'

const route = useRoute()
const code = String(route.params.code ?? '')

const fields = ['装卸编号', '关联航班', '货物品类', '件数吨位', '装卸班组', '计划开始', '实际完成', '装卸状态']

const row = ref<EntryRow | null>(null)
const journal = ref<CargoChainJournal | null>(null)
const flightSupport = ref<EntryRow | null>(null)
const dispatches = ref<EntryRow[]>([])
const judgmentKind = ref('')
const submitting = ref(false)
const errorMessage = ref('')
const noticeMessage = ref('')

const JUDGMENT_TEXT: Record<string, string> = {
  可确认: '可确认（装卸中，可发起确认完成链路）',
  已完成: '已完成（重复确认将被去重，沿用首次结果）',
  待装卸: '待装卸（需先开始装卸）',
  异常中断: '异常中断（历史异常记录保持原口径，不能确认完成）',
  不存在: '记录不存在',
}

const judgmentText = computed(() => {
  if (judgmentKind.value === '已完成' && journal.value && journal.value.status === '失败') {
    return '已完成（上次链路中途失败，可从断点继续）'
  }
  return JUDGMENT_TEXT[judgmentKind.value] ?? judgmentKind.value
})

function reload() {
  row.value = getCargoByCode(code)
  journal.value = getCargoChainJournal(code)
  judgmentKind.value = judgeCargoCompletion(code).kind
  flightSupport.value = row.value ? findFlightSupport(String(row.value['关联航班'] ?? '')) : null
  dispatches.value = listVehicleDispatch({ 装卸编号: code })
}

function confirm() {
  if (submitting.value) {
    return
  }
  submitting.value = true
  errorMessage.value = ''
  noticeMessage.value = ''
  try {
    const result = confirmCargoChain(code)
    if (!result.ok) {
      errorMessage.value = result.message
    } else {
      noticeMessage.value = result.message
    }
  } finally {
    submitting.value = false
    reload()
  }
}

onMounted(reload)
</script>
