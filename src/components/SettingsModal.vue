<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Moon, Sun, X } from 'lucide-vue-next'
import SettingsBackupSection from '@/components/settings/SettingsBackupSection.vue'
import SettingsCategoriesSection from '@/components/settings/SettingsCategoriesSection.vue'
import SettingsCloudSyncSection from '@/components/settings/SettingsCloudSyncSection.vue'
import SettingsProfileSection from '@/components/settings/SettingsProfileSection.vue'
import SettingsRatesSection from '@/components/settings/SettingsRatesSection.vue'
import SettingsTrashSection from '@/components/settings/SettingsTrashSection.vue'
import { useModalLayer } from '@/composables/useModalLayer'

export type SettingsTab = 'profile' | 'rates' | 'categories' | 'data'

interface Props {
  open: boolean
  isDark: boolean
  initialTab?: SettingsTab
}

const props = withDefaults(defineProps<Props>(), {
  initialTab: 'profile',
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'setTheme', dark: boolean): void
  (e: 'toast', message: string): void
  (e: 'restored', projectId?: string): void
  (e: 'selectProject', projectId: string): void
}>()

const { t } = useI18n()

const appVersionLabel = __APP_COMMIT__
  ? `v${__APP_VERSION__} · ${__APP_COMMIT__}`
  : `v${__APP_VERSION__}`

const dialogRef = ref<HTMLElement | null>(null)

useModalLayer(
  () => props.open,
  () => emit('close'),
  dialogRef,
)

const activeTab = ref<SettingsTab>(props.initialTab)

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      activeTab.value = props.initialTab
    }
  },
)
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        ref="dialogRef"
        role="dialog"
        aria-modal="true"
        :aria-label="t('settings.title')"
        class="fixed inset-0 z-50 flex justify-end bg-slate-950/50 backdrop-blur-sm"
        @click.self="emit('close')"
      >
        <aside
          class="safe-top flex h-full w-full max-w-sm flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900"
        >
          <!-- 標題列（與標題同排提供深淺色圖示切換、版本號與關閉鈕） -->
          <div
            class="flex items-center justify-between gap-2 border-b border-slate-200 px-5 py-4 dark:border-slate-800"
          >
            <h2
              class="truncate text-base font-bold text-slate-900 dark:text-white"
            >
              {{ t('settings.title') }}
            </h2>
            <div class="flex shrink-0 items-center gap-1.5">
              <!-- 外觀主題純圖示切換 -->
              <div
                role="group"
                :aria-label="t('settings.appearance')"
                class="inline-flex items-center rounded-full bg-slate-100 p-0.5 dark:bg-slate-800"
              >
                <button
                  type="button"
                  :aria-label="t('settings.themeLight')"
                  :title="t('settings.themeLight')"
                  :aria-pressed="!isDark"
                  class="inline-flex h-6 w-6 items-center justify-center rounded-full transition"
                  :class="
                    !isDark
                      ? 'bg-white text-amber-500 shadow-xs'
                      : 'text-slate-400 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                  "
                  @click="emit('setTheme', false)"
                >
                  <Sun class="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  :aria-label="t('settings.themeDark')"
                  :title="t('settings.themeDark')"
                  :aria-pressed="isDark"
                  class="inline-flex h-6 w-6 items-center justify-center rounded-full transition"
                  :class="
                    isDark
                      ? 'bg-slate-700 text-emerald-400 shadow-xs'
                      : 'text-slate-400 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                  "
                  @click="emit('setTheme', true)"
                >
                  <Moon class="h-3.5 w-3.5" />
                </button>
              </div>
              <span
                class="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-tight text-slate-500 dark:bg-slate-800 dark:text-slate-400"
              >
                {{ appVersionLabel }}
              </span>
              <button
                type="button"
                :aria-label="t('settings.close')"
                class="rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                @click="emit('close')"
              >
                <X class="h-5 w-5" />
              </button>
            </div>
          </div>

          <!-- 四大同級分頁導覽：個人 / 匯率 / 分類 / 資料 -->
          <nav
            class="grid grid-cols-4 gap-1 border-b border-slate-100 bg-slate-50 p-1.5 text-xs font-semibold dark:border-slate-800 dark:bg-slate-950/60"
          >
            <button
              type="button"
              class="rounded-lg py-1.5 transition"
              :class="
                activeTab === 'profile'
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
              "
              @click="activeTab = 'profile'"
            >
              {{ t('settings.tabProfile') }}
            </button>
            <button
              type="button"
              class="rounded-lg py-1.5 transition"
              :class="
                activeTab === 'rates'
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
              "
              @click="activeTab = 'rates'"
            >
              {{ t('settings.tabRates') }}
            </button>
            <button
              type="button"
              class="rounded-lg py-1.5 transition"
              :class="
                activeTab === 'categories'
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
              "
              @click="activeTab = 'categories'"
            >
              {{ t('settings.tabCategories') }}
            </button>
            <button
              type="button"
              class="rounded-lg py-1.5 transition"
              :class="
                activeTab === 'data'
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
              "
              @click="activeTab = 'data'"
            >
              {{ t('settings.tabData') }}
            </button>
          </nav>

          <!-- 分頁內容區 -->
          <div class="safe-sheet-pb flex-1 overflow-y-auto px-5 pt-5">
            <!-- 分頁 1：個人（我的成員檔案 ＋ Google 雲端同步 ＋ 介面語言） -->
            <SettingsProfileSection
              v-if="activeTab === 'profile'"
              @toast="emit('toast', $event)"
            >
              <template #after-profile>
                <SettingsCloudSyncSection @toast="emit('toast', $event)" />
              </template>
            </SettingsProfileSection>

            <!-- 分頁 2：消費分類管理 -->
            <SettingsCategoriesSection
              v-else-if="activeTab === 'categories'"
              @toast="emit('toast', $event)"
            />

            <!-- 分頁 3：匯率（每小時即時匯率看板 ＋ 常用幣別管理） -->
            <SettingsRatesSection
              v-else-if="activeTab === 'rates'"
              @toast="emit('toast', $event)"
            />

            <!-- 分頁 4：資料（本地備份 ＋ 已封存專案 ＋ 最近刪除回收桶） -->
            <div v-else-if="activeTab === 'data'" class="space-y-6">
              <SettingsBackupSection @toast="emit('toast', $event)" />
              <SettingsTrashSection
                @toast="emit('toast', $event)"
                @restored="emit('restored', $event)"
                @select-project="emit('selectProject', $event)"
                @close="emit('close')"
              />
            </div>
          </div>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>
