<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Check,
  ChevronDown,
  Palette,
  Pencil,
  Plus,
  RotateCcw,
  Tag,
  Trash2,
  X,
} from 'lucide-vue-next'
import CategoryIconBadge from '@/components/CategoryIconBadge.vue'
import {
  isValidCategoryIconKey,
  resolveDefaultCategoryIcon,
  SELECTABLE_CATEGORY_ICONS,
  type CategoryIconKey,
} from '@/core/categoryIcons'
import {
  AVATAR_PALETTE,
  useLedgerStore,
  type ManagedCategory,
} from '@/stores/ledgerStore'

const emit = defineEmits<{
  (e: 'toast', message: string): void
}>()

const { t } = useI18n()
const store = useLedgerStore()

// 分類新增與編輯狀態（顏色與圖案皆預設收合，點擊後再展開挑選面板）
const newCategoryName = ref('')
const newCategoryColor = ref<string>(AVATAR_PALETTE[0])
const newCategoryIcon = ref<CategoryIconKey>('tag')
const newCategoryPicker = ref<'color' | 'icon' | null>(null)
const editingCatKey = ref<string | null>(null)
const editingCatName = ref('')
const editingCatColor = ref<string>(AVATAR_PALETTE[0])
const editingCatIcon = ref<CategoryIconKey>('tag')
const editingCatPicker = ref<'color' | 'icon' | null>(null)

function resolveCategoryDisplayName(cat: ManagedCategory): string {
  if (cat.customLabel) return cat.customLabel
  const translated = t(`categories.${cat.key}`)
  return translated === `categories.${cat.key}` ? cat.key : translated
}

function handleAddCategory() {
  const name = newCategoryName.value.trim()
  if (!name) return
  store.addCategory(name, newCategoryColor.value, newCategoryIcon.value)
  newCategoryName.value = ''
  newCategoryPicker.value = null
  emit('toast', t('settings.categoryAddedToast'))
}

function toggleNewCategoryPicker(mode: 'color' | 'icon') {
  newCategoryPicker.value = newCategoryPicker.value === mode ? null : mode
}

function toggleEditingCategoryPicker(mode: 'color' | 'icon') {
  editingCatPicker.value = editingCatPicker.value === mode ? null : mode
}

function startEditCategory(
  cat: ManagedCategory,
  initialPicker: 'color' | 'icon' | null = null,
) {
  newCategoryPicker.value = null
  editingCatKey.value = cat.key
  editingCatName.value = resolveCategoryDisplayName(cat)
  editingCatColor.value = cat.color || AVATAR_PALETTE[0]
  editingCatIcon.value = isValidCategoryIconKey(cat.icon)
    ? cat.icon
    : resolveDefaultCategoryIcon(cat.key)
  editingCatPicker.value = initialPicker
}

function handleSaveCategoryEdit() {
  if (!editingCatKey.value) return
  const trimmed = editingCatName.value.trim()
  if (!trimmed) return
  store.updateCategory(editingCatKey.value, {
    customLabel: trimmed,
    color: editingCatColor.value,
    icon: editingCatIcon.value,
  })
  editingCatKey.value = null
  editingCatPicker.value = null
  emit('toast', t('settings.categoryUpdatedToast'))
}

function handleDeleteCategory(key: string) {
  const ok = store.removeCategory(key)
  if (!ok) {
    emit('toast', t('settings.categoryMinOneError'))
    return
  }
  if (editingCatKey.value === key) {
    editingCatKey.value = null
    editingCatPicker.value = null
  }
  emit('toast', t('settings.categoryDeletedToast'))
}

function handleResetCategories() {
  store.resetDefaultCategories()
  editingCatKey.value = null
  editingCatPicker.value = null
  emit('toast', t('settings.categoriesResetToast'))
}
</script>

<template>
  <div class="space-y-4">
    <div class="space-y-2.5">
      <div class="flex items-center justify-between">
        <span
          class="flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400"
        >
          <Tag class="h-3.5 w-3.5" />
          <span>{{ t('settings.customCategories') }}</span>
        </span>
        <button
          type="button"
          class="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500 hover:text-emerald-600 dark:text-slate-400"
          @click="handleResetCategories"
        >
          <RotateCcw class="h-3 w-3" />
          <span>{{ t('settings.resetCategories') }}</span>
        </button>
      </div>

      <!-- 新增分類卡片：左側圖示底色預覽 ＋ 名稱輸入 ＋ 點擊才展開之底色／圖案選單 -->
      <div
        class="space-y-2.5 rounded-2xl bg-slate-100/80 p-3 dark:bg-slate-800/70"
      >
        <div class="flex items-center gap-2">
          <button
            type="button"
            :title="t('settings.categoryIconLabel')"
            class="shrink-0 rounded-xl transition active:scale-95"
            @click="toggleNewCategoryPicker('icon')"
          >
            <CategoryIconBadge
              :icon="newCategoryIcon"
              :color="newCategoryColor"
              size="md"
            />
          </button>
          <input
            v-model="newCategoryName"
            type="text"
            maxlength="24"
            :placeholder="t('settings.addCategoryPlaceholder')"
            class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
            @keyup.enter="handleAddCategory"
          />
          <button
            type="button"
            :disabled="!newCategoryName.trim()"
            class="inline-flex shrink-0 items-center gap-1 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-40 dark:bg-emerald-500 dark:text-slate-950"
            @click="handleAddCategory"
          >
            <Plus class="h-3.5 w-3.5" />
            <span>{{ t('settings.add') }}</span>
          </button>
        </div>

        <!-- 底色／圖案觸發膠囊（預設收合，點擊後展開對應品項） -->
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
            :class="
              newCategoryPicker === 'color'
                ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-950'
                : 'bg-white text-slate-600 shadow-xs hover:text-slate-900 dark:bg-slate-900 dark:text-slate-300'
            "
            @click="toggleNewCategoryPicker('color')"
          >
            <span
              class="h-3 w-3 rounded-full ring-1 ring-black/15"
              :style="{ backgroundColor: newCategoryColor }"
            />
            <span>{{ t('settings.categoryColorLabel') }}</span>
            <ChevronDown
              class="h-3 w-3 transition-transform"
              :class="newCategoryPicker === 'color' ? 'rotate-180' : ''"
            />
          </button>

          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
            :class="
              newCategoryPicker === 'icon'
                ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-950'
                : 'bg-white text-slate-600 shadow-xs hover:text-slate-900 dark:bg-slate-900 dark:text-slate-300'
            "
            @click="toggleNewCategoryPicker('icon')"
          >
            <CategoryIconBadge :icon="newCategoryIcon" size="xs" plain />
            <span>{{ t('settings.categoryIconLabel') }}</span>
            <ChevronDown
              class="h-3 w-3 transition-transform"
              :class="newCategoryPicker === 'icon' ? 'rotate-180' : ''"
            />
          </button>
        </div>

        <!-- 點擊「底色」後展開之色票與自訂調色盤 -->
        <div
          v-if="newCategoryPicker === 'color'"
          class="flex flex-wrap items-center gap-2 rounded-xl bg-white p-2.5 shadow-xs dark:bg-slate-900"
        >
          <button
            v-for="color in AVATAR_PALETTE"
            :key="color"
            type="button"
            class="h-6 w-6 rounded-full transition"
            :style="{ backgroundColor: color }"
            :class="
              newCategoryColor.toLowerCase() === color.toLowerCase()
                ? 'scale-110 ring-2 ring-slate-900 ring-offset-2 dark:ring-white dark:ring-offset-slate-900'
                : 'opacity-80 hover:opacity-100'
            "
            @click="newCategoryColor = color"
          />
          <label
            class="inline-flex cursor-pointer items-center gap-1 rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:border-emerald-500 hover:text-emerald-600 dark:border-slate-600 dark:text-slate-300"
          >
            <Palette class="h-3 w-3" />
            <span>{{ t('settings.customColorPicker') }}</span>
            <input v-model="newCategoryColor" type="color" class="sr-only" />
          </label>
        </div>

        <!-- 點擊「圖案」後展開之 24 款圖示選單 -->
        <div
          v-else-if="newCategoryPicker === 'icon'"
          class="grid grid-cols-6 gap-1.5 rounded-xl bg-white p-2.5 shadow-xs dark:bg-slate-900"
        >
          <button
            v-for="iconKey in SELECTABLE_CATEGORY_ICONS"
            :key="iconKey"
            type="button"
            class="flex h-9 items-center justify-center rounded-xl transition active:scale-95"
            :style="
              newCategoryIcon === iconKey
                ? { backgroundColor: newCategoryColor }
                : undefined
            "
            :class="
              newCategoryIcon === iconKey
                ? 'text-white shadow-sm'
                : 'bg-slate-100/80 text-slate-600 hover:bg-slate-200/80 dark:bg-slate-800 dark:text-slate-300'
            "
            @click="newCategoryIcon = iconKey"
          >
            <CategoryIconBadge :icon="iconKey" size="md" plain />
          </button>
        </div>
      </div>
    </div>

    <ul class="divide-y divide-slate-100 dark:divide-slate-800">
      <li v-for="cat in store.categories" :key="cat.key" class="py-2.5">
        <div
          v-if="editingCatKey === cat.key"
          class="space-y-2.5 rounded-2xl bg-slate-100/80 p-3 dark:bg-slate-800/70"
        >
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              :title="t('settings.categoryIconLabel')"
              class="shrink-0 rounded-xl transition active:scale-95"
              @click="toggleEditingCategoryPicker('icon')"
            >
              <CategoryIconBadge
                :icon="editingCatIcon"
                :color="editingCatColor"
                size="md"
              />
            </button>
            <input
              v-model="editingCatName"
              type="text"
              maxlength="24"
              class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
              @keyup.enter="handleSaveCategoryEdit"
            />
            <button
              type="button"
              :aria-label="t('daily.saveButton')"
              class="rounded-xl bg-emerald-600 px-2.5 py-1.5 text-xs font-bold text-white"
              @click="handleSaveCategoryEdit"
            >
              <Check class="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              :aria-label="t('confirm.cancelButton')"
              class="rounded-xl bg-white px-2 py-1.5 text-slate-500 shadow-xs dark:bg-slate-900 dark:text-slate-400"
              @click="
                editingCatKey = null;
                editingCatPicker = null
              "
            >
              <X class="h-3.5 w-3.5" />
            </button>
          </div>

          <!-- 編輯模式：點擊「底色」或「圖案」才顯示選單 -->
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
              :class="
                editingCatPicker === 'color'
                  ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-950'
                  : 'bg-white text-slate-600 shadow-xs hover:text-slate-900 dark:bg-slate-900 dark:text-slate-300'
              "
              @click="toggleEditingCategoryPicker('color')"
            >
              <span
                class="h-3 w-3 rounded-full ring-1 ring-black/15"
                :style="{ backgroundColor: editingCatColor }"
              />
              <span>{{ t('settings.categoryColorLabel') }}</span>
              <ChevronDown
                class="h-3 w-3 transition-transform"
                :class="editingCatPicker === 'color' ? 'rotate-180' : ''"
              />
            </button>

            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
              :class="
                editingCatPicker === 'icon'
                  ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-950'
                  : 'bg-white text-slate-600 shadow-xs hover:text-slate-900 dark:bg-slate-900 dark:text-slate-300'
              "
              @click="toggleEditingCategoryPicker('icon')"
            >
              <CategoryIconBadge :icon="editingCatIcon" size="xs" plain />
              <span>{{ t('settings.categoryIconLabel') }}</span>
              <ChevronDown
                class="h-3 w-3 transition-transform"
                :class="editingCatPicker === 'icon' ? 'rotate-180' : ''"
              />
            </button>
          </div>

          <div
            v-if="editingCatPicker === 'color'"
            class="flex flex-wrap items-center gap-2 rounded-xl bg-white p-2.5 shadow-xs dark:bg-slate-900"
          >
            <button
              v-for="color in AVATAR_PALETTE"
              :key="color"
              type="button"
              class="h-6 w-6 rounded-full transition"
              :style="{ backgroundColor: color }"
              :class="
                editingCatColor.toLowerCase() === color.toLowerCase()
                  ? 'scale-110 ring-2 ring-slate-900 ring-offset-2 dark:ring-white dark:ring-offset-slate-900'
                  : 'opacity-80 hover:opacity-100'
              "
              @click="editingCatColor = color"
            />
            <label
              class="inline-flex cursor-pointer items-center gap-1 rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:border-emerald-500 hover:text-emerald-600 dark:border-slate-600 dark:text-slate-300"
            >
              <Palette class="h-3 w-3" />
              <span>{{ t('settings.customColorPicker') }}</span>
              <input v-model="editingCatColor" type="color" class="sr-only" />
            </label>
          </div>

          <div
            v-else-if="editingCatPicker === 'icon'"
            class="grid grid-cols-6 gap-1.5 rounded-xl bg-white p-2.5 shadow-xs dark:bg-slate-900"
          >
            <button
              v-for="iconKey in SELECTABLE_CATEGORY_ICONS"
              :key="iconKey"
              type="button"
              class="flex h-9 items-center justify-center rounded-xl transition active:scale-95"
              :style="
                editingCatIcon === iconKey
                  ? { backgroundColor: editingCatColor }
                  : undefined
              "
              :class="
                editingCatIcon === iconKey
                  ? 'text-white shadow-sm'
                  : 'bg-slate-100/80 text-slate-600 hover:bg-slate-200/80 dark:bg-slate-800 dark:text-slate-300'
              "
              @click="editingCatIcon = iconKey"
            >
              <CategoryIconBadge :icon="iconKey" size="md" plain />
            </button>
          </div>
        </div>

        <div v-else class="flex items-center justify-between gap-2">
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-3 text-left transition hover:opacity-85"
            @click="startEditCategory(cat)"
          >
            <CategoryIconBadge
              :icon="cat.icon"
              :category-key="cat.key"
              :color="cat.color"
              size="md"
            />
            <span
              class="truncate text-sm font-medium text-slate-800 dark:text-slate-100"
            >
              {{ resolveCategoryDisplayName(cat) }}
            </span>
          </button>
          <div class="flex shrink-0 items-center gap-1">
            <button
              type="button"
              :aria-label="t('home.editTx')"
              class="rounded-lg p-1.5 text-slate-400 hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-950/60"
              @click="startEditCategory(cat)"
            >
              <Pencil class="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              :aria-label="t('home.deleteTx')"
              class="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/60"
              @click="handleDeleteCategory(cat.key)"
            >
              <Trash2 class="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>
