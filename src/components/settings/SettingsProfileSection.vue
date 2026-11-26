<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Camera, Globe, Moon, Palette, Sun, User } from 'lucide-vue-next'
import MemberAvatar from '@/components/MemberAvatar.vue'
import { compressAvatarImageFileToDataUrl } from '@/platform/imageCompressor'
import { SUPPORTED_LOCALES, setAppLocale, type SupportedLocale } from '@/i18n'
import { AVATAR_PALETTE, useLedgerStore } from '@/stores/ledgerStore'

interface Props {
  isDark: boolean
}

defineProps<Props>()

const emit = defineEmits<{
  (e: 'setTheme', dark: boolean): void
  (e: 'toast', message: string): void
}>()

const { t, locale } = useI18n()
const store = useLedgerStore()

// 我的成員檔案（預設成員名稱、大頭貼與收款帳號）
const profileDisplayName = ref(store.userProfile.displayName)
const profileAvatarColor = ref(
  store.userProfile.avatarColor || AVATAR_PALETTE[0],
)
const profileAvatarImage = ref<string | undefined>(
  store.userProfile.avatarImage,
)
const profilePaymentInfo = ref(store.userProfile.paymentInfo ?? '')
const applyProfileToExisting = ref(true)
const isSavingProfile = ref(false)

watch(
  () => store.userProfile,
  (next) => {
    profileDisplayName.value = next.displayName
    profileAvatarColor.value = next.avatarColor || AVATAR_PALETTE[0]
    profileAvatarImage.value = next.avatarImage
    profilePaymentInfo.value = next.paymentInfo ?? ''
  },
  { deep: true },
)

function handleLocale(code: SupportedLocale) {
  setAppLocale(code)
}

async function handleProfileAvatarUpload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    profileAvatarImage.value = await compressAvatarImageFileToDataUrl(
      file,
      160,
      0.78,
    )
  } catch {
    emit('toast', t('photo.uploadError'))
  } finally {
    input.value = ''
  }
}

function handleRemoveProfileAvatar() {
  profileAvatarImage.value = undefined
}

async function handleSaveProfile() {
  if (isSavingProfile.value) return
  isSavingProfile.value = true
  try {
    await store.updateUserProfile(
      {
        displayName: profileDisplayName.value,
        avatarColor: profileAvatarColor.value,
        avatarImage: profileAvatarImage.value ?? null,
        paymentInfo: profilePaymentInfo.value.trim() || null,
      },
      { applyToExistingProjects: applyProfileToExisting.value },
    )
    emit('toast', t('profile.savedToast'))
  } finally {
    isSavingProfile.value = false
  }
}
</script>

<template>
  <div class="space-y-6">
    <!-- 我的成員名稱與大頭貼設定 -->
    <section
      class="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-950/50"
    >
      <div
        class="flex items-center gap-1.5 text-xs font-bold text-slate-800 dark:text-slate-100"
      >
        <User class="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
        <span>{{ t('profile.sectionTitle') }}</span>
      </div>
      <p class="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
        {{ t('profile.sectionDesc') }}
      </p>

      <div class="flex items-center gap-3.5">
        <div class="relative shrink-0">
          <MemberAvatar
            :name="profileDisplayName || t('project.defaultMember1')"
            :color="profileAvatarColor"
            :image="profileAvatarImage"
            size="lg"
          />
          <label
            class="absolute -bottom-1 -right-1 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border-2 border-white bg-slate-900 text-white shadow transition hover:bg-emerald-600 dark:border-slate-900 dark:bg-emerald-500 dark:text-slate-950"
            :title="t('profile.uploadAvatar')"
          >
            <Camera class="h-3 w-3" />
            <input
              type="file"
              accept="image/*"
              class="hidden"
              @change="handleProfileAvatarUpload"
            />
          </label>
        </div>

        <div class="min-w-0 flex-1 space-y-1.5">
          <input
            v-model="profileDisplayName"
            type="text"
            maxlength="32"
            :placeholder="t('profile.namePlaceholder')"
            class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
            @keyup.enter="handleSaveProfile"
          />
          <div class="flex items-center gap-2">
            <label
              class="cursor-pointer text-[11px] font-semibold text-emerald-600 hover:underline dark:text-emerald-400"
            >
              <span>{{ t('profile.uploadAvatar') }}</span>
              <input
                type="file"
                accept="image/*"
                class="hidden"
                @change="handleProfileAvatarUpload"
              />
            </label>
            <button
              v-if="profileAvatarImage"
              type="button"
              class="text-[11px] font-semibold text-rose-500 hover:underline"
              @click="handleRemoveProfileAvatar"
            >
              {{ t('profile.removeAvatar') }}
            </button>
          </div>
        </div>
      </div>

      <!-- 頭像預設色票 -->
      <div class="flex items-center gap-1.5 pt-0.5">
        <button
          v-for="color in AVATAR_PALETTE"
          :key="color"
          type="button"
          class="h-5 w-5 rounded-full transition"
          :style="{ backgroundColor: color }"
          :class="
            profileAvatarColor === color
              ? 'ring-2 ring-slate-900 ring-offset-2 dark:ring-white dark:ring-offset-slate-900'
              : 'opacity-70 hover:opacity-100'
          "
          @click="profileAvatarColor = color"
        />
      </div>

      <!-- 選填：我的收款帳號／轉帳資訊（結算與一鍵分享時自動帶出） -->
      <div class="space-y-1">
        <label
          class="block text-[11px] font-semibold text-slate-600 dark:text-slate-300"
        >
          {{ t('profile.paymentInfoLabel') }}
        </label>
        <input
          v-model="profilePaymentInfo"
          type="text"
          maxlength="120"
          :placeholder="t('profile.paymentInfoPlaceholder')"
          class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
          @keyup.enter="handleSaveProfile"
        />
      </div>

      <label
        v-if="store.allNonDeletedProjects.length > 0"
        class="flex cursor-pointer items-center gap-2 text-[11px] text-slate-600 dark:text-slate-300"
      >
        <input
          v-model="applyProfileToExisting"
          type="checkbox"
          class="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 dark:border-slate-600 dark:bg-slate-800"
        />
        <span>{{ t('profile.applyToExistingProjects') }}</span>
      </label>

      <button
        type="button"
        :disabled="isSavingProfile"
        class="w-full rounded-xl bg-slate-900 py-2 text-xs font-bold text-white transition hover:bg-slate-800 disabled:opacity-50 dark:bg-emerald-500 dark:text-slate-950 dark:hover:bg-emerald-400"
        @click="handleSaveProfile"
      >
        {{ t('profile.saveButton') }}
      </button>
    </section>

    <!-- 插槽：插入雲端同步區塊，維持原有介面順序 -->
    <slot name="after-profile" />

    <!-- 外觀深淺色 -->
    <section>
      <div
        class="mb-2.5 flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400"
      >
        <Palette class="h-3.5 w-3.5" />
        <span>{{ t('settings.appearance') }}</span>
      </div>
      <div class="grid grid-cols-2 gap-2.5">
        <button
          type="button"
          class="flex items-center justify-center gap-2 rounded-xl border py-3 text-xs font-semibold transition"
          :class="
            !isDark
              ? 'border-emerald-500 bg-emerald-50 text-emerald-900 dark:border-emerald-500 dark:bg-emerald-950/60 dark:text-emerald-200'
              : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
          "
          @click="emit('setTheme', false)"
        >
          <Sun class="h-4 w-4" />
          <span>{{ t('settings.themeLight') }}</span>
        </button>
        <button
          type="button"
          class="flex items-center justify-center gap-2 rounded-xl border py-3 text-xs font-semibold transition"
          :class="
            isDark
              ? 'border-emerald-500 bg-emerald-50 text-emerald-900 dark:border-emerald-500 dark:bg-emerald-950/60 dark:text-emerald-200'
              : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
          "
          @click="emit('setTheme', true)"
        >
          <Moon class="h-4 w-4" />
          <span>{{ t('settings.themeDark') }}</span>
        </button>
      </div>
    </section>

    <!-- 介面語言 -->
    <section>
      <div
        class="mb-2.5 flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400"
      >
        <Globe class="h-3.5 w-3.5" />
        <span>{{ t('settings.language') }}</span>
      </div>
      <div class="grid grid-cols-3 gap-2">
        <button
          v-for="item in SUPPORTED_LOCALES"
          :key="item.code"
          type="button"
          class="rounded-xl border py-2.5 text-xs font-semibold transition"
          :class="
            locale === item.code
              ? 'border-emerald-500 bg-emerald-50 text-emerald-900 dark:border-emerald-500 dark:bg-emerald-950/60 dark:text-emerald-200'
              : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
          "
          @click="handleLocale(item.code)"
        >
          {{ item.label }}
        </button>
      </div>
    </section>
  </div>
</template>
