<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronLeft, ChevronRight, X } from 'lucide-vue-next'

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

const currentIndex = ref(0)

const isOpen = computed(() => props.photos.length > 0)
const hasMultiple = computed(() => props.photos.length > 1)
const currentPhotoUrl = computed(
  () => props.photos[currentIndex.value] ?? props.photos[0] ?? null,
)

watch(
  () => [props.photos, props.initialIndex] as const,
  ([list, initIdx]) => {
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
  currentIndex.value =
    (currentIndex.value - 1 + props.photos.length) % props.photos.length
}

function showNext() {
  if (!hasMultiple.value) return
  currentIndex.value = (currentIndex.value + 1) % props.photos.length
}

function handleKeydown(event: KeyboardEvent) {
  if (!isOpen.value) return
  if (event.key === 'Escape') {
    emit('close')
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
      <!-- 頂部頁碼與關閉按鈕 -->
      <div class="absolute inset-x-0 top-0 flex items-center justify-between px-4 py-4">
        <span
          v-if="hasMultiple"
          class="rounded-full bg-white/15 px-3 py-1 text-xs font-bold tabular-nums text-white"
        >
          {{ currentIndex + 1 }} / {{ photos.length }}
        </span>
        <span v-else />
        <button
          type="button"
          :aria-label="t('settings.close')"
          class="rounded-full bg-white/15 p-2 text-white transition hover:bg-white/25"
          @click="emit('close')"
        >
          <X class="h-6 w-6" />
        </button>
      </div>

      <!-- 主圖與左右切換箭頭（點擊圖片本體或周圍空白處皆可關閉） -->
      <div
        class="relative flex max-h-[76vh] w-full max-w-3xl items-center justify-center"
        @click.self="emit('close')"
      >
        <button
          v-if="hasMultiple"
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
          class="max-h-[76vh] max-w-full cursor-pointer rounded-2xl object-contain shadow-2xl"
          @click.stop="emit('close')"
        />

        <button
          v-if="hasMultiple"
          type="button"
          :aria-label="t('photo.next')"
          class="absolute right-1 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full bg-slate-900/70 text-white shadow-lg ring-1 ring-white/20 transition hover:bg-slate-800 active:scale-95 sm:right-3"
          @click.stop="showNext"
        >
          <ChevronRight class="h-6 w-6" />
        </button>
      </div>

      <!-- 多張縮圖快速切換列 -->
      <div
        v-if="hasMultiple"
        class="mt-4 flex items-center gap-2 rounded-2xl bg-white/10 p-2 backdrop-blur-md"
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
          @click.stop="currentIndex = idx"
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
