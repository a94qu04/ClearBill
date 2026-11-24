<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Loader2, UserPlus, Users, X } from 'lucide-vue-next'
import type { Project, ShareInviteParams, Transaction } from '@/schemas/ledgerSchema'
import { useLedgerStore } from '@/stores/ledgerStore'
import {
  FirestoreSyncError,
  isFirebaseConfigured,
  parseAndSaveCustomFirebaseConfig,
} from '@/services/firestoreSyncService'

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

const isLoading = ref(false)
const isSubmitting = ref(false)
const errorText = ref('')
const needsConfig = ref(false)
const firebaseConfigInput = ref('')

const remoteProject = ref<Project | null>(null)
const remoteTransactions = ref<Transaction[]>([])
const selectedMemberId = ref<string>('')
const customNewMemberName = ref('')

function resolveSyncError(err: unknown): string {
  if (err instanceof FirestoreSyncError) {
    const key = `realtime.errors.${err.code}`
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

  if (!isFirebaseConfigured()) {
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
    selectedMemberId.value = res.project.members[0]?.id ?? ''
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
    parseAndSaveCustomFirebaseConfig(firebaseConfigInput.value)
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
      class="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/60 backdrop-blur-sm sm:items-center sm:p-4"
      @click.self="emit('close')"
    >
      <div
        class="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-3xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-800 dark:bg-slate-900 sm:rounded-3xl"
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
              {{ t('project.memberCount', { count: remoteProject.members.length }) }}
              · {{ remoteProject.baseCurrency }}
              · {{ t('stats.entryCount', { count: remoteTransactions.filter((tx) => !tx.isDeleted).length }) }}
            </div>
            <div class="mt-0.5 text-base font-bold">{{ remoteProject.name }}</div>
          </div>

          <div class="space-y-2">
            <div class="text-xs font-bold text-slate-700 dark:text-slate-200">
              {{ t('realtime.joinWhoAreYou') }}
            </div>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="m in remoteProject.members"
                :key="m.id"
                type="button"
                class="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-bold transition"
                :class="
                  selectedMemberId === m.id
                    ? 'bg-emerald-600 text-white shadow-sm dark:bg-emerald-500 dark:text-slate-950'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200'
                "
                @click="
                  selectedMemberId = m.id;
                  customNewMemberName = ''
                "
              >
                <span
                  class="h-2.5 w-2.5 rounded-full"
                  :style="{ backgroundColor: selectedMemberId === m.id ? '#ffffff' : m.avatarColor || '#10b981' }"
                />
                <span>{{ m.name }}</span>
                <Check v-if="selectedMemberId === m.id" class="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <!-- 或是新增自己成為新團員 -->
          <div class="space-y-1.5 border-t border-slate-100 pt-3 dark:border-slate-800">
            <div class="flex items-center gap-1 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
              <UserPlus class="h-3.5 w-3.5" />
              <span>{{ t('realtime.joinAsNewMemberLabel') }}</span>
            </div>
            <input
              v-model="customNewMemberName"
              type="text"
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
