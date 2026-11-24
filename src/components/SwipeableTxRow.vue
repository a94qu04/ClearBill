<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Pencil, Trash2 } from 'lucide-vue-next'

const emit = defineEmits<{
  (e: 'edit'): void
  (e: 'delete'): void
}>()

const { t } = useI18n()

/** 左滑兩段式門檻（px）：取消右滑，僅保留左滑修改與深滑漸層刪除 */
const LEFT_EDIT_THRESHOLD = -68
const LEFT_DELETE_THRESHOLD = -145
const MAX_LEFT_PULL = -215

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
  if (offsetX.value <= LEFT_DELETE_THRESHOLD) return 'delete'
  if (offsetX.value <= LEFT_EDIT_THRESHOLD) return 'edit'
  return 'none'
})

/**
 * 深滑刪除漸層進度（0 = 剛進入修改區；0 -> 1 = 平滑從藍色漸層過渡到紅色刪除區）
 */
const deleteGradientProgress = computed(() => {
  const pull = Math.abs(offsetX.value)
  const start = Math.abs(LEFT_EDIT_THRESHOLD)
  const end = Math.abs(LEFT_DELETE_THRESHOLD)
  if (pull <= start) return 0
  return Math.min(1, (pull - start) / (end - start))
})

const swipeBackgroundStyle = computed(() => {
  const pull = Math.abs(offsetX.value)
  if (pull === 0) return {}

  // 隨左滑深度從天藍平滑漸層至玫瑰紅，給予直覺的力道視覺回饋
  const p = deleteGradientProgress.value
  const r = Math.round(2 + (225 - 2) * p)
  const g = Math.round(132 + (29 - 132) * p)
  const b = Math.round(199 + (72 - 199) * p)
  const rLight = Math.round(14 + (244 - 14) * p)
  const gLight = Math.round(165 + (63 - 165) * p)
  const bLight = Math.round(233 + (94 - 233) * p)

  const alpha = Math.min(1, 0.25 + (pull / Math.abs(LEFT_EDIT_THRESHOLD)) * 0.75)

  return {
    background: `linear-gradient(90deg, rgba(${rLight}, ${gLight}, ${bLight}, ${alpha}) 0%, rgba(${r}, ${g}, ${b}, ${Math.min(1, alpha + 0.12)}) 100%)`,
  }
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

  // 取消右滑：僅允許向左滑動（offsetX <= 0）
  if (Math.abs(dx) > 10) {
    suppressNextClick = true
  }
  offsetX.value = Math.max(MAX_LEFT_PULL, Math.min(0, dx))
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
    <!-- 左滑背景：輕滑天藍修改，深滑漸層過渡為玫瑰紅刪除 -->
    <div
      v-if="offsetX < 0"
      class="absolute inset-0 flex items-center justify-end px-4 text-white"
      :style="swipeBackgroundStyle"
    >
      <div class="flex items-center gap-1.5 text-xs font-bold">
        <template v-if="pendingAction === 'delete'">
          <Trash2 class="h-4 w-4 scale-110 transition-transform" />
          <span>{{ t('swipe.releaseDelete') }}</span>
        </template>
        <template v-else>
          <Pencil class="h-4 w-4 transition-transform" />
          <span>{{
            pendingAction === 'edit'
              ? t('swipe.releaseEdit')
              : t('home.editTx')
          }}</span>
        </template>
      </div>
    </div>

    <!-- 前景帳目卡片主體 -->
    <div
      class="relative bg-white dark:bg-slate-900"
      :class="isDragging ? 'cursor-grabbing' : 'cursor-grab transition-transform duration-200 ease-out'"
      :style="{ transform: `translateX(${offsetX}px)` }"
    >
      <slot />
    </div>
  </div>
</template>
