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

const ZOOM_SCALE = 2.2
const SWIPE_THRESHOLD = 48

const currentIndex = ref(0)
const isZoomed = ref(false)
const panX = ref(0)
const panY = ref(0)
const swipeOffsetX = ref(0)
const isInteracting = ref(false)

let activePointerId: number | null = null
let startClientX = 0
let startClientY = 0
let startPanX = 0
let startPanY = 0
let movedDistance = 0

const isOpen = computed(() => props.photos.length > 0)
const hasMultiple = computed(() => props.photos.length > 1)
const currentPhotoUrl = computed(
  () => props.photos[currentIndex.value] ?? props.photos[0] ?? null,
)

function resetZoomAndPan() {
  isZoomed.value = false
  panX.value = 0
  panY.value = 0
  swipeOffsetX.value = 0
  isInteracting.value = false
  activePointerId = null
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

function toggleZoom() {
  if (isZoomed.value) {
    resetZoomAndPan()
  } else {
    isZoomed.value = true
    panX.value = 0
    panY.value = 0
    swipeOffsetX.value = 0
  }
}

function clampPan(val: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, val))
}

function onImagePointerDown(event: PointerEvent) {
  if (event.pointerType === 'mouse' && event.button !== 0) return
  event.stopPropagation()
  activePointerId = event.pointerId
  isInteracting.value = true
  startClientX = event.clientX
  startClientY = event.clientY
  startPanX = panX.value
  startPanY = panY.value
  movedDistance = 0
  try {
    ;(event.currentTarget as HTMLElement)?.setPointerCapture(event.pointerId)
  } catch {
    // 忽略不支援環境
  }
}

function onImagePointerMove(event: PointerEvent) {
  if (!isInteracting.value || activePointerId !== event.pointerId) return
  const dx = event.clientX - startClientX
  const dy = event.clientY - startClientY
  movedDistance = Math.max(movedDistance, Math.hypot(dx, dy))

  if (isZoomed.value) {
    // 放大狀態：支援自由拖曳平移檢視收據小字
    const maxPanX = typeof window !== 'undefined' ? window.innerWidth * 0.65 : 320
    const maxPanY = typeof window !== 'undefined' ? window.innerHeight * 0.65 : 420
    panX.value = clampPan(startPanX + dx, maxPanX)
    panY.value = clampPan(startPanY + dy, maxPanY)
  } else if (hasMultiple.value && Math.abs(dx) > Math.abs(dy)) {
    // 未放大且多張照片：左右滑動預覽切換上一張／下一張
    swipeOffsetX.value = Math.max(-140, Math.min(140, dx))
  }
}

function onImagePointerUp(event: PointerEvent) {
  if (!isInteracting.value || activePointerId !== event.pointerId) return
  event.stopPropagation()
  try {
    ;(event.currentTarget as HTMLElement)?.releasePointerCapture(event.pointerId)
  } catch {
    // 忽略
  }

  const dx = event.clientX - startClientX
  const wasTap = movedDistance < 8

  isInteracting.value = false
  activePointerId = null

  if (wasTap) {
    // 點擊圖片：未放大時放大，放大時點一下還原
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

function onImagePointerCancel() {
  isInteracting.value = false
  activePointerId = null
  swipeOffsetX.value = 0
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
      transform: `translate3d(${panX.value}px, ${panY.value}px, 0) scale(${ZOOM_SCALE})`,
    }
  }
  return {
    transform: `translate3d(${swipeOffsetX.value}px, 0, 0) scale(1)`,
  }
})

function handleKeydown(event: KeyboardEvent) {
  if (!isOpen.value) return
  if (event.key === 'Escape') {
    if (isZoomed.value) {
      resetZoomAndPan()
    } else {
      emit('close')
    }
  } else if (event.key === 'ArrowLeft') {
    showPrev()
  } else if (event.key === 'ArrowRight') {
    showNext()
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
      class="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-slate-950/92 p-4 backdrop-blur-sm"
      @click.self="emit('close')"
    >
      <!-- 頂部頁碼、縮放、下載與關閉按鈕 -->
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
            class="hidden rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/80 sm:inline"
          >
            {{
              isZoomed ? t('photo.zoomedHint') : t('photo.tapToZoomHint')
            }}
          </span>
        </div>

        <div class="pointer-events-auto flex items-center gap-2">
          <button
            type="button"
            :aria-label="isZoomed ? t('photo.zoomOut') : t('photo.zoomIn')"
            :title="isZoomed ? t('photo.zoomOut') : t('photo.zoomIn')"
            class="rounded-full bg-white/15 p-2 text-white transition hover:bg-white/25"
            @click.stop="toggleZoom"
          >
            <ZoomOut v-if="isZoomed" class="h-5 w-5" />
            <ZoomIn v-else class="h-5 w-5" />
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

      <!-- 主圖與左右切換箭頭（點擊圖片可放大／拖曳；點擊圖片外空白處可關閉） -->
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

      <!-- 手機提示語（未放大顯示「點擊放大 · 左右滑切換」，放大時顯示「拖曳移動 · 點擊還原」） -->
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
