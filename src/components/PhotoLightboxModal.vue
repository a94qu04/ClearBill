<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-vue-next'
import { getTodayIso } from '@/core/ledgerHelpers'
import { useModalLayer } from '@/composables/useModalLayer'

interface Props {
  photos: string[]
  initialIndex?: number
}

const props = withDefaults(defineProps<Props>(), {
  initialIndex: 0,
})

const emit = defineEmits<{
  (e: 'close'): void
}>()

const { t } = useI18n()

const MIN_SCALE = 1
const MAX_SCALE = 4.5
const TAP_ZOOM_SCALE = 2.5
const SWIPE_THRESHOLD = 48

const dialogRef = ref<HTMLElement | null>(null)
const imgElRef = ref<HTMLImageElement | null>(null)
const currentIndex = ref(0)
const scale = ref(1)
const panX = ref(0)
const panY = ref(0)
const swipeOffsetX = ref(0)
const isInteracting = ref(false)

const activePointers = new Map<number, { x: number; y: number }>()
let singlePointerId: number | null = null
let startClientX = 0
let startClientY = 0
let startPanX = 0
let startPanY = 0
let movedDistance = 0
let isPinching = false
let pinchStartDistance = 0
let pinchStartScale = 1

const isOpen = computed(() => props.photos.length > 0)
const isZoomed = computed(() => scale.value > 1.02)
const hasMultiple = computed(() => props.photos.length > 1)
const currentPhotoUrl = computed(
  () => props.photos[currentIndex.value] ?? props.photos[0] ?? null,
)
const formattedScaleLabel = computed(() => `${scale.value.toFixed(1)}×`)

function resetZoomAndPan() {
  scale.value = 1
  panX.value = 0
  panY.value = 0
  swipeOffsetX.value = 0
  isInteracting.value = false
  isPinching = false
  singlePointerId = null
  activePointers.clear()
}

watch(
  () => [props.photos, props.initialIndex] as const,
  ([list, initIdx]) => {
    resetZoomAndPan()
    if (list.length === 0) {
      currentIndex.value = 0
      return
    }
    const clamped = Math.max(0, Math.min(list.length - 1, initIdx))
    currentIndex.value = clamped
  },
  { immediate: true },
)

function showPrev() {
  if (!hasMultiple.value) return
  resetZoomAndPan()
  currentIndex.value =
    (currentIndex.value - 1 + props.photos.length) % props.photos.length
}

function showNext() {
  if (!hasMultiple.value) return
  resetZoomAndPan()
  currentIndex.value = (currentIndex.value + 1) % props.photos.length
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val))
}

/** 依圖片實際渲染尺寸與視口大小動態計算平移上限，確保細長熱感紙收據可完整拖曳至頂底 */
function getDynamicPanLimits(targetScale: number): { maxX: number; maxY: number } {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 400
  const vh = typeof window !== 'undefined' ? window.innerHeight : 700
  const el = imgElRef.value
  if (!el || targetScale <= 1) {
    return { maxX: 0, maxY: 0 }
  }
  const baseW = el.clientWidth || vw * 0.8
  const baseH = el.clientHeight || vh * 0.65
  const scaledW = baseW * targetScale
  const scaledH = baseH * targetScale
  const maxX = Math.max(80, (scaledW - vw * 0.72) / 2 + 80)
  const maxY = Math.max(80, (scaledH - vh * 0.68) / 2 + 120)
  return { maxX, maxY }
}

function applyScale(nextScale: number) {
  const clamped = clamp(Number(nextScale.toFixed(2)), MIN_SCALE, MAX_SCALE)
  if (clamped <= 1.02) {
    scale.value = 1
    panX.value = 0
    panY.value = 0
    return
  }
  scale.value = clamped
  swipeOffsetX.value = 0
  const { maxX, maxY } = getDynamicPanLimits(clamped)
  panX.value = clamp(panX.value, -maxX, maxX)
  panY.value = clamp(panY.value, -maxY, maxY)
}

function toggleZoom() {
  if (isZoomed.value) {
    resetZoomAndPan()
  } else {
    applyScale(TAP_ZOOM_SCALE)
  }
}

function stepZoom(delta: number) {
  applyScale(scale.value + delta)
}

function getTwoPointerDistance(): number {
  const pts = Array.from(activePointers.values())
  if (pts.length < 2) return 0
  return Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
}

function onImagePointerDown(event: PointerEvent) {
  if (event.pointerType === 'mouse' && event.button !== 0) return
  event.stopPropagation()

  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  isInteracting.value = true
  try {
    ;(event.currentTarget as HTMLElement)?.setPointerCapture(event.pointerId)
  } catch {
    // 忽略不支援環境
  }

  if (activePointers.size >= 2) {
    // 進入雙指捏合縮放模式（Pinch-to-Zoom）
    isPinching = true
    singlePointerId = null
    swipeOffsetX.value = 0
    pinchStartDistance = Math.max(10, getTwoPointerDistance())
    pinchStartScale = scale.value
    movedDistance = 999
    return
  }

  isPinching = false
  singlePointerId = event.pointerId
  startClientX = event.clientX
  startClientY = event.clientY
  startPanX = panX.value
  startPanY = panY.value
  movedDistance = 0
}

function onImagePointerMove(event: PointerEvent) {
  if (!activePointers.has(event.pointerId)) return
  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY })

  if (isPinching && activePointers.size >= 2) {
    const dist = getTwoPointerDistance()
    if (pinchStartDistance > 0 && dist > 0) {
      applyScale(pinchStartScale * (dist / pinchStartDistance))
    }
    return
  }

  if (!isInteracting.value || singlePointerId !== event.pointerId) return
  const dx = event.clientX - startClientX
  const dy = event.clientY - startClientY
  movedDistance = Math.max(movedDistance, Math.hypot(dx, dy))

  if (isZoomed.value) {
    const { maxX, maxY } = getDynamicPanLimits(scale.value)
    panX.value = clamp(startPanX + dx, -maxX, maxX)
    panY.value = clamp(startPanY + dy, -maxY, maxY)
  } else if (hasMultiple.value && Math.abs(dx) > Math.abs(dy)) {
    swipeOffsetX.value = clamp(dx, -140, 140)
  }
}

function onImagePointerUp(event: PointerEvent) {
  if (!activePointers.has(event.pointerId)) return
  event.stopPropagation()
  try {
    ;(event.currentTarget as HTMLElement)?.releasePointerCapture(event.pointerId)
  } catch {
    // 忽略
  }

  activePointers.delete(event.pointerId)

  if (isPinching) {
    if (activePointers.size === 0) {
      isPinching = false
      isInteracting.value = false
    } else if (activePointers.size === 1) {
      // 雙指放開一指後平滑轉為單指平移
      const [[remainId, pos]] = Array.from(activePointers.entries())
      isPinching = false
      singlePointerId = remainId
      startClientX = pos.x
      startClientY = pos.y
      startPanX = panX.value
      startPanY = panY.value
    }
    return
  }

  if (singlePointerId !== event.pointerId) return

  const dx = event.clientX - startClientX
  const wasTap = movedDistance < 8

  isInteracting.value = false
  singlePointerId = null

  if (wasTap) {
    toggleZoom()
    return
  }

  if (!isZoomed.value && hasMultiple.value) {
    if (dx <= -SWIPE_THRESHOLD) {
      showNext()
    } else if (dx >= SWIPE_THRESHOLD) {
      showPrev()
    } else {
      swipeOffsetX.value = 0
    }
  }
}

function onImagePointerCancel(event: PointerEvent) {
  activePointers.delete(event.pointerId)
  if (activePointers.size === 0) {
    isInteracting.value = false
    isPinching = false
    singlePointerId = null
    swipeOffsetX.value = 0
  }
}

function onImageWheel(event: WheelEvent) {
  if (!isOpen.value) return
  const delta = event.deltaY < 0 ? 0.35 : -0.35
  stepZoom(delta)
}

function handleDownloadPhoto() {
  if (!currentPhotoUrl.value || typeof document === 'undefined') return
  const link = document.createElement('a')
  link.href = currentPhotoUrl.value
  link.download = `clearbill-receipt-${getTodayIso()}-${currentIndex.value + 1}.jpg`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

const imageTransformStyle = computed(() => {
  if (isZoomed.value) {
    return {
      transform: `translate3d(${panX.value}px, ${panY.value}px, 0) scale(${scale.value})`,
    }
  }
  return {
    transform: `translate3d(${swipeOffsetX.value}px, 0, 0) scale(1)`,
  }
})

useModalLayer(
  isOpen,
  () => {
    if (isZoomed.value) {
      resetZoomAndPan()
    } else {
      emit('close')
    }
  },
  dialogRef,
)

function handleKeydown(event: KeyboardEvent) {
  if (!isOpen.value) return
  if (event.key === 'ArrowLeft') {
    showPrev()
  } else if (event.key === 'ArrowRight') {
    showNext()
  } else if (event.key === '+' || event.key === '=') {
    stepZoom(0.5)
  } else if (event.key === '-') {
    stepZoom(-0.5)
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', handleKeydown)
  }
})

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', handleKeydown)
  }
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="isOpen && currentPhotoUrl"
      ref="dialogRef"
      role="dialog"
      aria-modal="true"
      :aria-label="t('photo.viewerTitle')"
      class="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-slate-950/92 p-4 backdrop-blur-sm"
      @click.self="emit('close')"
    >
      <!-- 頂部頁碼、縮放倍率、下載與關閉按鈕 -->
      <div
        class="safe-top pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between px-4 py-4"
      >
        <div class="pointer-events-auto flex items-center gap-2">
          <span
            v-if="hasMultiple"
            class="rounded-full bg-white/15 px-3 py-1 text-xs font-bold tabular-nums text-white"
          >
            {{ currentIndex + 1 }} / {{ photos.length }}
          </span>
          <span
            v-if="isZoomed"
            class="rounded-full bg-emerald-500/25 px-2.5 py-1 text-xs font-bold tabular-nums text-emerald-200"
          >
            {{ formattedScaleLabel }}
          </span>
          <span
            class="hidden rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/80 sm:inline"
          >
            {{
              isZoomed ? t('photo.zoomedHint') : t('photo.tapToZoomHint')
            }}
          </span>
        </div>

        <div class="pointer-events-auto flex items-center gap-2">
          <button
            v-if="isZoomed"
            type="button"
            :aria-label="t('photo.zoomOut')"
            :title="t('photo.zoomOut')"
            class="rounded-full bg-white/15 p-2 text-white transition hover:bg-white/25"
            @click.stop="resetZoomAndPan"
          >
            <ZoomOut class="h-5 w-5" />
          </button>
          <button
            type="button"
            :disabled="scale >= MAX_SCALE"
            :aria-label="t('photo.zoomIn')"
            :title="t('photo.zoomIn')"
            class="rounded-full bg-white/15 p-2 text-white transition hover:bg-white/25 disabled:opacity-35"
            @click.stop="isZoomed ? stepZoom(0.8) : toggleZoom()"
          >
            <ZoomIn class="h-5 w-5" />
          </button>
          <button
            type="button"
            :aria-label="t('photo.download')"
            :title="t('photo.download')"
            class="rounded-full bg-white/15 p-2 text-white transition hover:bg-white/25"
            @click.stop="handleDownloadPhoto"
          >
            <Download class="h-5 w-5" />
          </button>
          <button
            type="button"
            :aria-label="t('settings.close')"
            class="rounded-full bg-white/15 p-2 text-white transition hover:bg-white/25"
            @click.stop="emit('close')"
          >
            <X class="h-6 w-6" />
          </button>
        </div>
      </div>

      <!-- 主圖與左右切換箭頭（支援雙指縮放、滾輪縮放、點擊縮放與長圖自由平移） -->
      <div
        class="relative flex max-h-[76vh] w-full max-w-3xl items-center justify-center"
        @click.self="emit('close')"
      >
        <button
          v-if="hasMultiple && !isZoomed"
          type="button"
          :aria-label="t('photo.prev')"
          class="absolute left-1 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full bg-slate-900/70 text-white shadow-lg ring-1 ring-white/20 transition hover:bg-slate-800 active:scale-95 sm:left-3"
          @click.stop="showPrev"
        >
          <ChevronLeft class="h-6 w-6" />
        </button>

        <img
          ref="imgElRef"
          :src="currentPhotoUrl"
          :alt="t('photo.viewerTitle')"
          draggable="false"
          class="max-h-[76vh] max-w-full select-none rounded-2xl object-contain shadow-2xl touch-none"
          :class="[
            isZoomed
              ? isInteracting
                ? 'cursor-grabbing'
                : 'cursor-grab'
              : 'cursor-zoom-in',
            isInteracting ? '' : 'transition-transform duration-200 ease-out',
          ]"
          :style="imageTransformStyle"
          @pointerdown="onImagePointerDown"
          @pointermove="onImagePointerMove"
          @pointerup="onImagePointerUp"
          @pointercancel="onImagePointerCancel"
          @wheel.prevent="onImageWheel"
        />

        <button
          v-if="hasMultiple && !isZoomed"
          type="button"
          :aria-label="t('photo.next')"
          class="absolute right-1 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full bg-slate-900/70 text-white shadow-lg ring-1 ring-white/20 transition hover:bg-slate-800 active:scale-95 sm:right-3"
          @click.stop="showNext"
        >
          <ChevronRight class="h-6 w-6" />
        </button>
      </div>

      <!-- 手機提示語 -->
      <p class="mt-3 text-[11px] font-medium text-white/65 sm:hidden">
        {{ isZoomed ? t('photo.zoomedHint') : t('photo.tapToZoomHint') }}
      </p>

      <!-- 多張縮圖快速切換列 -->
      <div
        v-if="hasMultiple && !isZoomed"
        class="mt-3 flex items-center gap-2 rounded-2xl bg-white/10 p-2 backdrop-blur-md"
        @click.stop
      >
        <button
          v-for="(url, idx) in photos"
          :key="idx"
          type="button"
          class="h-12 w-12 overflow-hidden rounded-xl border-2 transition"
          :class="
            idx === currentIndex
              ? 'border-emerald-400 scale-105'
              : 'border-transparent opacity-60 hover:opacity-100'
          "
          @click.stop="
            resetZoomAndPan();
            currentIndex = idx
          "
        >
          <img
            :src="url"
            :alt="`${t('photo.viewerTitle')} ${idx + 1}`"
            class="h-full w-full object-cover"
          />
        </button>
      </div>
    </div>
  </Teleport>
</template>
