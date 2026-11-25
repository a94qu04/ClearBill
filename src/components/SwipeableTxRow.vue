<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Pencil, Trash2 } from 'lucide-vue-next'

const emit = defineEmits<{
  (e: 'edit'): void
  (e: 'delete'): void
}>()

const { t } = useI18n()

/** 雙向滑動門檻（px）：左滑修改、右滑刪除（刪除門檻稍深以防誤觸） */
const LEFT_EDIT_THRESHOLD = -76
const RIGHT_DELETE_THRESHOLD = 100
const MAX_LEFT_PULL = -140
const MAX_RIGHT_PULL = 164

const offsetX = ref(0)
const isDragging = ref(false)
const actionPhase = ref<'idle' | 'settling_edit' | 'exiting_delete'>('idle')
const rowCollapsed = ref(false)

let startX = 0
let startY = 0
let directionLocked: 'horizontal' | 'vertical' | null = null
let activePointerId: number | null = null
let captureEl: HTMLElement | null = null
let suppressNextClick = false
let actionTimer: ReturnType<typeof setTimeout> | null = null
let collapseTimer: ReturnType<typeof setTimeout> | null = null

type PendingAction = 'none' | 'edit' | 'delete'

const pendingAction = computed<PendingAction>(() => {
  if (offsetX.value <= LEFT_EDIT_THRESHOLD) return 'edit'
  if (offsetX.value >= RIGHT_DELETE_THRESHOLD) return 'delete'
  return 'none'
})

function triggerHaptic(durationMs: number) {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(durationMs)
    } catch {
      // 忽略不支援震動之瀏覽器環境
    }
  }
}

// 跨越修改或刪除門檻瞬間給予微震動手感回饋（不重複狂震）
watch(pendingAction, (next, prev) => {
  if (!isDragging.value || next === prev) return
  if (next === 'edit') {
    triggerHaptic(12)
  } else if (next === 'delete') {
    triggerHaptic(18)
  }
})

const editProgress = computed(() => {
  if (offsetX.value >= 0) return 0
  return Math.min(1, Math.abs(offsetX.value) / Math.abs(LEFT_EDIT_THRESHOLD))
})

const deleteProgress = computed(() => {
  if (offsetX.value <= 0) return 0
  return Math.min(1, offsetX.value / RIGHT_DELETE_THRESHOLD)
})

/** 超過門檻後加上溫和橡皮筋阻尼手感，讓拉動更自然 */
function applyRubberBand(dx: number): number {
  if (dx < LEFT_EDIT_THRESHOLD) {
    const extra = dx - LEFT_EDIT_THRESHOLD
    return Math.max(MAX_LEFT_PULL, LEFT_EDIT_THRESHOLD + extra * 0.42)
  }
  if (dx > RIGHT_DELETE_THRESHOLD) {
    const extra = dx - RIGHT_DELETE_THRESHOLD
    return Math.min(MAX_RIGHT_PULL, RIGHT_DELETE_THRESHOLD + extra * 0.42)
  }
  return dx
}

function clearActionTimers() {
  if (actionTimer) {
    clearTimeout(actionTimer)
    actionTimer = null
  }
  if (collapseTimer) {
    clearTimeout(collapseTimer)
    collapseTimer = null
  }
}

function onPointerDown(event: PointerEvent) {
  if (actionPhase.value !== 'idle') return
  if (event.pointerType === 'mouse' && event.button !== 0) return
  const target = event.target as HTMLElement | null
  if (target?.closest('button, a, input, select')) return

  isDragging.value = true
  startX = event.clientX
  startY = event.clientY
  directionLocked = null
  activePointerId = event.pointerId
  captureEl = event.currentTarget as HTMLElement | null
}

function onPointerMove(event: PointerEvent) {
  if (!isDragging.value || actionPhase.value !== 'idle') return
  const dx = event.clientX - startX
  const dy = event.clientY - startY

  if (!directionLocked) {
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
    directionLocked = Math.abs(dx) >= Math.abs(dy) ? 'horizontal' : 'vertical'
    if (
      directionLocked === 'horizontal' &&
      captureEl &&
      activePointerId !== null
    ) {
      try {
        captureEl.setPointerCapture(activePointerId)
      } catch {
        // 忽略不支援環境
      }
    }
  }

  if (directionLocked !== 'horizontal') return

  if (Math.abs(dx) > 10) {
    suppressNextClick = true
  }
  offsetX.value = applyRubberBand(dx)
}

function onClickCapture(event: MouseEvent) {
  if (suppressNextClick) {
    suppressNextClick = false
    event.preventDefault()
    event.stopPropagation()
  }
}

function finishDrag() {
  if (!isDragging.value) return
  isDragging.value = false

  if (captureEl && activePointerId !== null) {
    try {
      if (captureEl.hasPointerCapture(activePointerId)) {
        captureEl.releasePointerCapture(activePointerId)
      }
    } catch {
      // 忽略釋放例外
    }
  }

  const triggered = pendingAction.value
  directionLocked = null
  activePointerId = null
  captureEl = null

  clearActionTimers()

  if (triggered === 'edit') {
    // 左滑修改：先優雅彈性滑回原位，再柔和開啟修改彈窗
    actionPhase.value = 'settling_edit'
    offsetX.value = 0
    actionTimer = setTimeout(() => {
      actionPhase.value = 'idle'
      emit('edit')
    }, 240)
    return
  }

  if (triggered === 'delete') {
    // 右滑刪除：先向右飛出淡出，再平滑收合高度後才刪除
    actionPhase.value = 'exiting_delete'
    offsetX.value = 420
    collapseTimer = setTimeout(() => {
      rowCollapsed.value = true
    }, 180)
    actionTimer = setTimeout(() => {
      emit('delete')
      // 若父層未移除此元件（如取消），保險還原狀態
      actionPhase.value = 'idle'
      rowCollapsed.value = false
      offsetX.value = 0
    }, 360)
    return
  }

  offsetX.value = 0
}

onBeforeUnmount(() => {
  clearActionTimers()
})
</script>

<template>
  <div
    class="relative overflow-hidden select-none touch-pan-y transition-all duration-200 ease-out"
    :class="rowCollapsed ? 'max-h-0 opacity-0' : 'max-h-[420px] opacity-100'"
    @click.capture="onClickCapture"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="finishDrag"
    @pointercancel="finishDrag"
  >
    <!-- 左滑右側背景：天藍修改 -->
    <div
      v-if="offsetX < 0 || actionPhase === 'settling_edit'"
      class="absolute inset-0 flex items-center justify-end px-4 text-white transition-opacity duration-200"
      :class="actionPhase === 'settling_edit' ? 'opacity-0' : 'opacity-100'"
      :style="{
        background: `linear-gradient(90deg, rgba(14, 165, 233, ${0.32 + editProgress * 0.68}) 0%, rgba(2, 132, 199, ${0.44 + editProgress * 0.56}) 100%)`,
      }"
    >
      <div
        class="flex items-center gap-1.5 text-xs font-bold transition-transform duration-200 ease-out"
        :style="{
          opacity: Math.max(0.35, editProgress),
          transform: `scale(${pendingAction === 'edit' ? 1.08 : 0.92 + editProgress * 0.1})`,
        }"
      >
        <Pencil
          class="h-4 w-4 transition-transform duration-200"
          :class="pendingAction === 'edit' ? '-rotate-12 scale-110' : ''"
        />
        <span>{{
          pendingAction === 'edit' ? t('swipe.releaseEdit') : t('home.editTx')
        }}</span>
      </div>
    </div>

    <!-- 右滑左側背景：玫瑰紅刪除 -->
    <div
      v-if="offsetX > 0 || actionPhase === 'exiting_delete'"
      class="absolute inset-0 flex items-center justify-start px-4 text-white transition-opacity duration-200"
      :style="{
        background:
          actionPhase === 'exiting_delete'
            ? 'linear-gradient(90deg, rgba(225, 29, 72, 1) 0%, rgba(244, 63, 94, 0.96) 100%)'
            : `linear-gradient(90deg, rgba(225, 29, 72, ${0.42 + deleteProgress * 0.58}) 0%, rgba(244, 63, 94, ${0.3 + deleteProgress * 0.7}) 100%)`,
      }"
    >
      <div
        class="flex items-center gap-1.5 text-xs font-bold transition-transform duration-200 ease-out"
        :style="{
          opacity: actionPhase === 'exiting_delete' ? 1 : Math.max(0.35, deleteProgress),
          transform: `scale(${pendingAction === 'delete' || actionPhase === 'exiting_delete' ? 1.08 : 0.92 + deleteProgress * 0.1})`,
        }"
      >
        <Trash2
          class="h-4 w-4 transition-transform duration-200"
          :class="pendingAction === 'delete' || actionPhase === 'exiting_delete' ? 'scale-110' : ''"
        />
        <span>{{
          pendingAction === 'delete' || actionPhase === 'exiting_delete'
            ? t('swipe.releaseDelete')
            : t('home.deleteTx')
        }}</span>
      </div>
    </div>

    <!-- 前景帳目卡片主體 -->
    <div
      class="relative bg-white dark:bg-slate-900"
      :class="
        isDragging
          ? 'cursor-grabbing'
          : actionPhase === 'exiting_delete'
            ? 'pointer-events-none opacity-0 transition-all duration-300 ease-in'
            : 'cursor-grab transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]'
      "
      :style="{ transform: `translateX(${offsetX}px)` }"
    >
      <slot />
    </div>
  </div>
</template>
