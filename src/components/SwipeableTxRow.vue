<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Pencil, Trash2 } from 'lucide-vue-next'

const emit = defineEmits<{
  (e: 'edit'): void
  (e: 'delete'): void
}>()

const { t } = useI18n()

/**
 * 雙向觸控滑動門檻（px）：依行動端業界慣例採「左滑刪除、右滑修改」
 * 刪除門檻更深以防誤觸，並避開螢幕最左緣 28px 系統返回手勢熱區
 */
const LEFT_DELETE_THRESHOLD = -100
const RIGHT_EDIT_THRESHOLD = 76
const MAX_LEFT_PULL = -164
const MAX_RIGHT_PULL = 140
const EDGE_BACK_GUARD_PX = 28

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
  if (offsetX.value >= RIGHT_EDIT_THRESHOLD) return 'edit'
  if (offsetX.value <= LEFT_DELETE_THRESHOLD) return 'delete'
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
  if (offsetX.value <= 0) return 0
  return Math.min(1, offsetX.value / RIGHT_EDIT_THRESHOLD)
})

const deleteProgress = computed(() => {
  if (offsetX.value >= 0) return 0
  return Math.min(1, Math.abs(offsetX.value) / Math.abs(LEFT_DELETE_THRESHOLD))
})

/** 超過門檻後加上溫和橡皮筋阻尼手感，讓拉動更自然 */
function applyRubberBand(dx: number): number {
  if (dx < LEFT_DELETE_THRESHOLD) {
    const extra = dx - LEFT_DELETE_THRESHOLD
    return Math.max(MAX_LEFT_PULL, LEFT_DELETE_THRESHOLD + extra * 0.42)
  }
  if (dx > RIGHT_EDIT_THRESHOLD) {
    const extra = dx - RIGHT_EDIT_THRESHOLD
    return Math.min(MAX_RIGHT_PULL, RIGHT_EDIT_THRESHOLD + extra * 0.42)
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
  // 僅於觸控／手寫筆啟用滑動手勢，桌機滑鼠保留自由選字複製與展開操作按鈕
  if (event.pointerType === 'mouse') return
  // 避開 iOS / Android 螢幕最左緣系統返回手勢熱區
  if (event.clientX < EDGE_BACK_GUARD_PX) return
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
    // 右滑修改：先優雅彈性滑回原位，再開啟修改彈窗
    actionPhase.value = 'settling_edit'
    offsetX.value = 0
    actionTimer = setTimeout(() => {
      actionPhase.value = 'idle'
      emit('edit')
    }, 240)
    return
  }

  if (triggered === 'delete') {
    // 左滑刪除：先向左飛出淡出，再以 CSS Grid 平滑收合高度後才刪除
    actionPhase.value = 'exiting_delete'
    offsetX.value = -420
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
  <!-- 使用 CSS Grid 0fr/1fr 收合動畫，完全不受內容高度限制（大團展開詳情絕不截斷） -->
  <div
    class="grid transition-[grid-template-rows,opacity] duration-200 ease-out"
    :class="rowCollapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'"
  >
    <div
      class="relative overflow-hidden touch-pan-y"
      :class="isDragging ? 'select-none' : ''"
      @click.capture="onClickCapture"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="finishDrag"
      @pointercancel="finishDrag"
    >
      <!-- 右滑左側背景：天藍修改 -->
      <div
        v-if="offsetX > 0 || actionPhase === 'settling_edit'"
        class="absolute inset-0 flex items-center justify-start px-4 text-white transition-opacity duration-200"
        :class="actionPhase === 'settling_edit' ? 'opacity-0' : 'opacity-100'"
        :style="{
          background: `linear-gradient(90deg, rgba(2, 132, 199, ${0.44 + editProgress * 0.56}) 0%, rgba(14, 165, 233, ${0.32 + editProgress * 0.68}) 100%)`,
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

      <!-- 左滑右側背景：玫瑰紅刪除 -->
      <div
        v-if="offsetX < 0 || actionPhase === 'exiting_delete'"
        class="absolute inset-0 flex items-center justify-end px-4 text-white transition-opacity duration-200"
        :style="{
          background:
            actionPhase === 'exiting_delete'
              ? 'linear-gradient(90deg, rgba(244, 63, 94, 0.96) 0%, rgba(225, 29, 72, 1) 100%)'
              : `linear-gradient(90deg, rgba(244, 63, 94, ${0.3 + deleteProgress * 0.7}) 0%, rgba(225, 29, 72, ${0.42 + deleteProgress * 0.58}) 100%)`,
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
        class="relative bg-white dark:bg-[#1C1C1E]"
        :class="
          isDragging
            ? ''
            : actionPhase === 'exiting_delete'
              ? 'pointer-events-none opacity-0 transition-all duration-300 ease-in'
              : 'transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]'
        "
        :style="{ transform: `translateX(${offsetX}px)` }"
      >
        <slot />
      </div>
    </div>
  </div>
</template>
