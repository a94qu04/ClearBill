<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Loader2, UserPlus, Users, X } from 'lucide-vue-next'
import type { Project, ShareInviteParams, Transaction } from '@/schemas/ledgerSchema'
import { useLedgerStore } from '@/stores/ledgerStore'
import { useModalLayer } from '@/composables/useModalLayer'
import MemberAvatar from '@/components/MemberAvatar.vue'

interface Props {
  invite: ShareInviteParams | null
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'joined', projectId: string): void
  (e: 'toast', message: string): void
}>()

const { t } = useI18n()
const store = useLedgerStore()

const dialogRef = ref<HTMLElement | null>(null)

useModalLayer(
  () => Boolean(props.invite),
  () => emit('close'),
  dialogRef,
)

const isLoading = ref(false)
const isSubmitting = ref(false)
const errorText = ref('')
const needsConfig = ref(false)
const firebaseConfigInput = ref('')

const remoteProject = ref<Project | null>(null)
const remoteTransactions = ref<Transaction[]>([])
const selectedMemberId = ref<string>('')
const customNewMemberName = ref('')
const applyMyProfileOnJoin = ref(false)

const hasCustomUserProfile = computed(() =>
  Boolean(store.userProfile.displayName || store.userProfile.avatarImage),
)

const remoteHumanMembers = computed(() => {
  if (!remoteProject.value) return []
  const humans = remoteProject.value.members.filter((m) => !m.isPool)
  return humans.length > 0 ? humans : remoteProject.value.members
})

function resolveSyncError(err: unknown): string {
  const code = store.getRealtimeSyncErrorCode(err)
  if (code) {
    const key = `realtime.errors.${code}`
    const translated = t(key)
    return translated === key ? t('realtime.errors.ERR_SYNC_FAILED') : translated
  }
  return t('realtime.errors.ERR_SYNC_FAILED')
}

async function loadInvitePreview() {
  if (!props.invite) return
  errorText.value = ''
  remoteProject.value = null
  remoteTransactions.value = []
  selectedMemberId.value = ''
  customNewMemberName.value = ''
  applyMyProfileOnJoin.value = false

  if (!store.isFirebaseConfigured()) {
    needsConfig.value = true
    return
  }

  needsConfig.value = false
  isLoading.value = true
  try {
    const res = await store.fetchSharedProjectForJoin(
      props.invite.shareId,
      props.invite.accessKey,
    )
    remoteProject.value = res.project
    remoteTransactions.value = res.transactions
    const humans = res.project.members.filter((m) => !m.isPool)
    const claimable = humans.length > 0 ? humans : res.project.members
    const myName = store.userProfile.displayName.trim().toLowerCase()
    const matched = myName
      ? claimable.find((m) => m.name.trim().toLowerCase() === myName)
      : undefined
    selectedMemberId.value = matched?.id ?? claimable[0]?.id ?? ''
    // 僅在預選成員與使用者個人名稱一致時才預設勾選套用頭像，避免不小心覆寫別人名字
    applyMyProfileOnJoin.value = Boolean(matched && hasCustomUserProfile.value)
  } catch (err) {
    errorText.value = resolveSyncError(err)
  } finally {
    isLoading.value = false
  }
}

watch(
  () => props.invite,
  (next) => {
    if (next) {
      void loadInvitePreview()
    }
  },
  { immediate: true },
)

async function handleSaveConfigAndRetry() {
  try {
    store.saveCustomFirebaseConfig(firebaseConfigInput.value)
    needsConfig.value = false
    await loadInvitePreview()
  } catch (err) {
    errorText.value = resolveSyncError(err)
  }
}

async function handleConfirmJoin() {
  if (!props.invite || !remoteProject.value || isSubmitting.value) return
  const useNewMember = !selectedMemberId.value && customNewMemberName.value.trim()
  if (!selectedMemberId.value && !useNewMember) {
    errorText.value = t('realtime.joinSelectMemberError')
    return
  }
  if (useNewMember) {
    const newKey = customNewMemberName.value.trim().toLowerCase()
    const duplicated = remoteProject.value.members.some(
      (m) => m.name.trim().toLowerCase() === newKey,
    )
    if (duplicated) {
      errorText.value = t('validation.duplicateMemberName', {
        name: customNewMemberName.value.trim(),
      })
      return
    }
  }

  isSubmitting.value = true
  errorText.value = ''
  try {
    const joined = await store.finalizeJoinSharedProject({
      shareId: props.invite.shareId,
      accessKey: props.invite.accessKey,
      remoteProject: remoteProject.value,
      remoteTransactions: remoteTransactions.value,
      selectedMemberId: selectedMemberId.value || undefined,
      newMemberName: useNewMember ? customNewMemberName.value.trim() : undefined,
      applyMyProfile: Boolean(selectedMemberId.value && applyMyProfileOnJoin.value),
    })
    emit('toast', t('realtime.joinedToast', { name: joined.name }))
    emit('joined', joined.id)
  } catch (err) {
    errorText.value = resolveSyncError(err)
  } finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="invite"
      ref="dialogRef"
      role="dialog"
      aria-modal="true"
      :aria-label="t('realtime.joinModalTitle')"
      class="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/60 backdrop-blur-sm sm:items-center sm:p-4"
      @click.self="emit('close')"
    >
      <div
        class="safe-sheet-pb max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-3xl border border-slate-200 bg-white px-5 pt-5 shadow-2xl dark:border-slate-800 dark:bg-slate-900 sm:rounded-3xl sm:pb-5"
      >
        <div class="mb-4 flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <span
              class="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 dark:bg-emerald-950/70 dark:text-emerald-400"
            >
              <Users class="h-4 w-4" />
            </span>
            <h2 class="text-base font-bold text-slate-900 dark:text-white">
              {{ t('realtime.joinModalTitle') }}
            </h2>
          </div>
          <button
            type="button"
            :aria-label="t('settings.close')"
            class="rounded-full p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            @click="emit('close')"
          >
            <X class="h-5 w-5" />
          </button>
        </div>

        <!-- 尚未設定 Firebase 時提示貼上設定 -->
        <div v-if="needsConfig" class="space-y-3">
          <p class="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
            {{ t('realtime.needConfigDesc') }}
          </p>
          <textarea
            v-model="firebaseConfigInput"
            rows="4"
            :placeholder="t('realtime.configInputPlaceholder')"
            class="w-full rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-[11px] dark:border-slate-700 dark:bg-slate-800 dark:text-white"
          />
          <p v-if="errorText" class="text-xs font-medium text-rose-500">
            {{ errorText }}
          </p>
          <button
            type="button"
            :disabled="!firebaseConfigInput.trim()"
            class="w-full rounded-2xl bg-emerald-600 py-3 text-sm font-bold text-white disabled:opacity-40 dark:bg-emerald-500 dark:text-slate-950"
            @click="handleSaveConfigAndRetry"
          >
            {{ t('realtime.saveConfigButton') }}
          </button>
        </div>

        <!-- 載入專案中 -->
        <div v-else-if="isLoading" class="flex flex-col items-center gap-3 py-10">
          <Loader2 class="h-7 w-7 animate-spin text-emerald-600 dark:text-emerald-400" />
          <span class="text-xs font-semibold text-slate-500 dark:text-slate-400">
            {{ t('realtime.joiningLoading') }}
          </span>
        </div>

        <!-- 錯誤顯示 -->
        <div v-else-if="errorText && !remoteProject" class="space-y-3 py-4">
          <p
            class="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-medium text-rose-700 dark:border-rose-800/60 dark:bg-rose-950/40 dark:text-rose-300"
          >
            {{ errorText }}
          </p>
          <button
            type="button"
            class="w-full rounded-xl border border-slate-200 py-2.5 text-xs font-bold text-slate-700 dark:border-slate-700 dark:text-slate-200"
            @click="loadInvitePreview"
          >
            {{ t('realtime.resyncButton') }}
          </button>
        </div>

        <!-- 成功讀取共享專案：請旅伴認領身分 -->
        <div v-else-if="remoteProject" class="space-y-4">
          <div class="rounded-2xl bg-slate-900 px-4 py-3.5 text-white dark:border dark:border-slate-800">
            <div class="text-xs font-semibold text-emerald-400">
              {{ t('project.memberCount', { count: remoteHumanMembers.length }) }}
              · {{ remoteProject.baseCurrency }}
              · {{ t('stats.entryCount', { count: remoteTransactions.filter((tx) => !tx.isDeleted).length }) }}
            </div>
            <div class="mt-0.5 text-base font-bold">{{ remoteProject.name }}</div>
          </div>

          <div class="space-y-2">
            <div class="text-xs font-bold text-slate-700 dark:text-slate-200">
              {{ t('realtime.joinWhoAreYou') }}
            </div>
            <p class="text-[11px] text-slate-500 dark:text-slate-400">
              {{ t('realtime.joinWhoAreYouHint') }}
            </p>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="m in remoteHumanMembers"
                :key="m.id"
                type="button"
                class="inline-flex items-center gap-1.5 rounded-full py-1 pl-1.5 pr-3 text-xs font-bold transition"
                :class="
                  selectedMemberId === m.id
                    ? 'bg-emerald-600 text-white shadow-sm ring-2 ring-emerald-500/30 dark:bg-emerald-500 dark:text-slate-950'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200'
                "
                @click="
                  selectedMemberId = m.id;
                  customNewMemberName = '';
                  applyMyProfileOnJoin =
                    Boolean(
                      store.userProfile.displayName &&
                      m.name.trim().toLowerCase() ===
                        store.userProfile.displayName.trim().toLowerCase(),
                    )
                "
              >
                <MemberAvatar
                  :name="m.name"
                  :color="m.avatarColor"
                  :image="m.avatarImage"
                  size="xs"
                  ring
                />
                <span>{{ m.name }}</span>
                <Check v-if="selectedMemberId === m.id" class="h-3.5 w-3.5" />
              </button>
            </div>

            <!-- 認領既有成員時可一併套用自己的個人名稱與大頭貼 -->
            <label
              v-if="selectedMemberId && hasCustomUserProfile"
              class="mt-1.5 flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-300"
            >
              <input
                v-model="applyMyProfileOnJoin"
                type="checkbox"
                class="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
              />
              <MemberAvatar
                :name="store.userProfile.displayName || t('project.defaultMember1')"
                :color="store.userProfile.avatarColor"
                :image="store.userProfile.avatarImage"
                size="xs"
              />
              <span>{{ t('realtime.joinApplyMyProfile') }}</span>
            </label>
          </div>

          <!-- 或是新增自己成為新團員 -->
          <div class="space-y-1.5 border-t border-slate-100 pt-3 dark:border-slate-800">
            <div class="flex items-center justify-between gap-2 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
              <span class="flex items-center gap-1">
                <UserPlus class="h-3.5 w-3.5" />
                <span>{{ t('realtime.joinAsNewMemberLabel') }}</span>
              </span>
              <button
                v-if="store.userProfile.displayName && customNewMemberName !== store.userProfile.displayName"
                type="button"
                class="text-emerald-600 hover:underline dark:text-emerald-400"
                @click="
                  customNewMemberName = store.userProfile.displayName;
                  selectedMemberId = ''
                "
              >
                {{ t('realtime.joinUseMyName', { name: store.userProfile.displayName }) }}
              </button>
            </div>
            <input
              v-model="customNewMemberName"
              type="text"
              maxlength="50"
              :placeholder="t('project.addMemberPlaceholder')"
              class="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              @input="customNewMemberName.trim() && (selectedMemberId = '')"
            />
          </div>

          <p v-if="errorText" class="text-xs font-medium text-rose-500">
            {{ errorText }}
          </p>

          <button
            type="button"
            :disabled="isSubmitting || (!selectedMemberId && !customNewMemberName.trim())"
            class="flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-600 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-40 dark:bg-emerald-500 dark:text-slate-950"
            @click="handleConfirmJoin"
          >
            <Loader2 v-if="isSubmitting" class="h-4 w-4 animate-spin" />
            <span>{{ t('realtime.joinConfirmButton') }}</span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
