<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Pencil, Trash2 } from 'lucide-vue-next'

const emit = defineEmits<{
  (e: 'edit'): void
  (e: 'delete'): void
}>()

const { t } = useI18n()

/** 雙向滑動門檻（px）：左滑修改、右滑刪除（刪除門檻稍深以防誤觸） */
const LEFT_EDIT_THRESHOLD = -72
const RIGHT_DELETE_THRESHOLD = 96
const MAX_LEFT_PULL = -132
const MAX_RIGHT_PULL = 152

const offsetX = ref(0)
const isDragging = ref(false)
let startX = 0
let startY = 0
let directionLocked: 'horizontal' | 'vertical' | null = null
let activePointerId: number | null = null
let captureEl: HTMLElement | null = null
let suppressNextClick = false

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

function onPointerDown(event: PointerEvent) {
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
  if (!isDragging.value) return
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
  offsetX.value = Math.max(MAX_LEFT_PULL, Math.min(MAX_RIGHT_PULL, dx))
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
  offsetX.value = 0
  directionLocked = null
  activePointerId = null
  captureEl = null

  if (triggered === 'edit') {
    emit('edit')
  } else if (triggered === 'delete') {
    emit('delete')
  }
}
</script>

<template>
  <div
    class="relative overflow-hidden select-none touch-pan-y"
    @click.capture="onClickCapture"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="finishDrag"
    @pointercancel="finishDrag"
  >
    <!-- 左滑右側背景：天藍修改 -->
    <div
      v-if="offsetX < 0"
      class="absolute inset-0 flex items-center justify-end px-4 text-white"
      :style="{
        background: `linear-gradient(90deg, rgba(14, 165, 233, ${0.3 + editProgress * 0.7}) 0%, rgba(2, 132, 199, ${0.4 + editProgress * 0.6}) 100%)`,
      }"
    >
      <div class="flex items-center gap-1.5 text-xs font-bold">
        <Pencil
          class="h-4 w-4 transition-transform"
          :class="pendingAction === 'edit' ? 'scale-110' : ''"
        />
        <span>{{
          pendingAction === 'edit' ? t('swipe.releaseEdit') : t('home.editTx')
        }}</span>
      </div>
    </div>

    <!-- 右滑左側背景：玫瑰紅刪除 -->
    <div
      v-if="offsetX > 0"
      class="absolute inset-0 flex items-center justify-start px-4 text-white"
      :style="{
        background: `linear-gradient(90deg, rgba(225, 29, 72, ${0.4 + deleteProgress * 0.6}) 0%, rgba(244, 63, 94, ${0.28 + deleteProgress * 0.72}) 100%)`,
      }"
    >
      <div class="flex items-center gap-1.5 text-xs font-bold">
        <Trash2
          class="h-4 w-4 transition-transform"
          :class="pendingAction === 'delete' ? 'scale-110' : ''"
        />
        <span>{{
          pendingAction === 'delete'
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
          : 'cursor-grab transition-transform duration-200 ease-out'
      "
      :style="{ transform: `translateX(${offsetX}px)` }"
    >
      <slot />
    </div>
  </div>
</template>
