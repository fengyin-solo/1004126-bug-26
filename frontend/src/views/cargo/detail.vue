<template>
  <section class="page" data-module="cargo-detail">
    <header class="page-head">
      <div>
        <h2>货物装卸详情</h2>
        <p class="page-desc">
          装卸编号 {{ view ? view.row['装卸编号'] : cargoId }} 的完整档案与三步链路进度。
        </p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/cargo">返回列表</RouterLink>
      </div>
    </header>

    <p v-if="!view" class="empty-state">没有找到该装卸编号的货物装卸记录。</p>

    <template v-else>
      <ol class="flow-steps">
        <li v-for="step in view.steps" :key="step.key" :data-state="step.state">
          <span>{{ step.label }}</span>
          <strong>{{ stateText[step.state] }}</strong>
        </li>
      </ol>

      <table class="data-table detail-table">
        <tbody>
          <tr v-for="field in fields" :key="field">
            <th>{{ field }}</th>
            <td>{{ view.row[field] ?? '—' }}</td>
          </tr>
          <tr>
            <th>当前状态</th>
            <td>{{ view.row.status }}</td>
          </tr>
          <tr>
            <th>完成判定（统一口径）</th>
            <td>{{ view.completed ? '已完成' : '未完成' }}</td>
          </tr>
        </tbody>
      </table>

      <section class="writeback-panel">
        <h3>保障回写结果</h3>
        <p v-if="view.writebackNote">
          航班保障「{{ view.row['关联航班'] }}」保障节点：{{ view.writebackNote }}
        </p>
        <p v-else class="muted-text">尚未回写到航班保障。</p>
      </section>

      <div class="page-actions">
        <button
          class="btn primary"
          type="button"
          :disabled="submitting || view.completed || isAborted"
          @click="confirm"
        >
          {{ submitting ? '提交中…' : '确认完成' }}
        </button>
        <button
          v-if="view.checkpoint"
          class="btn"
          type="button"
          :disabled="submitting"
          @click="resume"
        >
          从断点继续（{{ view.checkpoint.nextStep === 'writeback' ? '保障回写' : '确认完成' }}）
        </button>
      </div>
      <p v-if="isAborted" class="error-text">
        该记录已异常中断，历史异常保持原口径，不能再确认完成。
      </p>
      <p v-if="message" :class="messageOk ? 'muted-text' : 'error-text'">{{ message }}</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import {
  confirmCargoCompletion,
  getCargoFlowView,
  resumeCargoFlow,
} from '@/api/cargo-flow'
import type { CargoFlowView } from '@/api/cargo-flow'
import { useSessionStore } from '@/stores/session'

const route = useRoute()
const store = useSessionStore()
const cargoId = Number(route.params.id)

const fields = ["装卸编号", "关联航班", "货物品类", "件数吨位", "装卸班组", "计划开始", "实际完成", "装卸状态"]
const stateText = {
  done: '已完成',
  ready: '待操作',
  waiting: '待前置步骤',
  failed: '失败待续跑',
} as const

const view = ref<CargoFlowView | null>(null)
const submitting = ref(false)
const message = ref('')
const messageOk = ref(false)

const isAborted = computed(() => String(view.value?.row.status ?? '') === '异常中断')

function reload() {
  view.value = getCargoFlowView(cargoId)
}

async function run(task: () => Promise<{ ok: boolean; message: string }>) {
  if (submitting.value) {
    return
  }
  submitting.value = true
  message.value = ''
  try {
    const result = await task()
    message.value = result.message
    messageOk.value = result.ok
  } finally {
    submitting.value = false
    reload()
  }
}

function confirm() {
  // 并发提交只留一次：按钮提交中即禁用，服务端（本地服务）也有在途守卫
  void run(() =>
    confirmCargoCompletion(cargoId, {
      operator: store.operator,
      flight: String(view.value?.row['关联航班'] ?? ''),
    }),
  )
}

function resume() {
  void run(() => resumeCargoFlow(cargoId))
}

onMounted(reload)
</script>
