<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { X } from 'lucide-vue-next'

interface Props {
  photoUrl: string | null
}

defineProps<Props>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const { t } = useI18n()
</script>

<template>
  <Teleport to="body">
    <div
      v-if="photoUrl"
      class="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/90 p-4 backdrop-blur-sm"
      @click.self="emit('close')"
    >
      <button
        type="button"
        :aria-label="t('settings.close')"
        class="absolute right-4 top-4 rounded-full bg-white/15 p-2 text-white hover:bg-white/25"
        @click="emit('close')"
      >
        <X class="h-6 w-6" />
      </button>
      <img
        :src="photoUrl"
        :alt="t('photo.viewerTitle')"
        class="max-h-[85vh] max-w-full rounded-2xl object-contain shadow-2xl"
      />
    </div>
  </Teleport>
</template>
