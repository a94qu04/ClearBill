<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cloud,
  CloudOff,
  Copy,
  Link2,
  Loader2,
  RefreshCw,
  Share2,
  ShieldCheck,
  Users,
  X,
} from 'lucide-vue-next'
import type { Project } from '@/schemas/ledgerSchema'
import { useLedgerStore } from '@/stores/ledgerStore'
import { askConfirm } from '@/composables/useConfirm'
import { useModalLayer } from '@/composables/useModalLayer'
import MemberAvatar from '@/components/MemberAvatar.vue'
import { buildShareInviteUrl } from '@/core/realtimeSyncEngine'
import {
  clearCustomFirebaseConfig,
  FirestoreSyncError,
  getCustomFirebaseConfig,
  hasBuiltInFirebaseConfig,
  isFirebaseConfigured,
  parseAndSaveCustomFirebaseConfig,
} from '@/services/firestoreSyncService'

interface Props {
  open: boolean
  project: Project | null
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'toast', message: string): void
}>()

const { t, locale } = useI18n()
const store = useLedgerStore()

const dialogRef = ref<HTMLElement | null>(null)

useModalLayer(
  () => Boolean(props.open && props.project),
  () => emit('close'),
  dialogRef,
)

const humanMembers = computed(() => {
  if (!props.project) return []
  const humans = props.project.members.filter((m) => !m.isPool)
  return humans.length > 0 ? humans : props.project.members
})

const isBusy = ref(false)
const selectedMyMemberId = ref('')
const syncReceiptImages = ref(true)
const firebaseConfigInput = ref('')
const showAdvancedConfig = ref(false)
const configRevision = ref(0)

const hasBuiltInConfig = computed(() => {
  void configRevision.value
  return hasBuiltInFirebaseConfig()
})

const hasCustomConfig = computed(() => {
  void configRevision.value
  return getCustomFirebaseConfig() !== null
})

const firebaseReady = computed(() => {
  void configRevision.value
  return isFirebaseConfigured()
})

const isShared = computed(
  () =>
    props.project?.syncMeta?.mode === 'firestore' &&
    Boolean(props.project.syncMeta.shareId) &&
    Boolean(props.project.syncMeta.accessKey),
)

const syncStatus = computed(() => {
  if (!props.project) return 'local'
  return store.syncStatusByProject[props.project.id] ?? (isShared.value ? 'synced' : 'local')
})

const outboxCount = computed(() => {
  if (!props.project) return 0
  return store.outboxCountByProject[props.project.id] ?? 0
})

const syncedTxCount = computed(() => {
  if (!props.project) return 0
  return store.getProjectTransactionCount(props.project.id)
})

const formattedLastSyncedAt = computed(() => {
  if (!props.project) return ''
  const ts =
    store.lastSyncedAtByProject[props.project.id] ??
    props.project.syncMeta?.lastSyncedAt ??
    null
  if (!ts) return ''
  try {
    return new Intl.DateTimeFormat(locale.value, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ts))
  } catch {
    return new Date(ts).toLocaleTimeString()
  }
})

const inviteUrl = computed(() => {
  if (!isShared.value || !props.project?.syncMeta?.shareId || !props.project.syncMeta.accessKey) {
    return ''
  }
  const baseHref =
    typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}`
      : 'https://clearbill.app/'
  return buildShareInviteUrl(
    baseHref,
    props.project.syncMeta.shareId,
    props.project.syncMeta.accessKey,
  )
})

watch(
  () => [props.open, props.project?.id] as const,
  ([isOpen]) => {
    if (!isOpen || !props.project) return
    const humanIds = new Set(humanMembers.value.map((m) => m.id))
    const candidateMyId =
      props.project.syncMeta?.myMemberId || props.project.defaultPayerId
    selectedMyMemberId.value =
      (candidateMyId && humanIds.has(candidateMyId) ? candidateMyId : '') ||
      humanMembers.value[0]?.id ||
      ''
    syncReceiptImages.value = props.project.syncMeta?.syncReceiptImages !== false
    const custom = getCustomFirebaseConfig()
    firebaseConfigInput.value = custom ? JSON.stringify(custom, null, 2) : ''
    showAdvancedConfig.value = false
  },
  { immediate: true },
)

function resolveSyncError(err: unknown): string {
  if (err instanceof FirestoreSyncError) {
    const key = `realtime.errors.${err.code}`
    const translated = t(key)
    return translated === key ? t('realtime.errors.ERR_SYNC_FAILED') : translated
  }
  return t('realtime.errors.ERR_SYNC_FAILED')
}

function handleSaveFirebaseConfig() {
  try {
    parseAndSaveCustomFirebaseConfig(firebaseConfigInput.value)
    configRevision.value += 1
    emit('toast', t('realtime.configSavedToast'))
  } catch (err) {
    emit('toast', resolveSyncError(err))
  }
}

function handleClearCustomConfig() {
  clearCustomFirebaseConfig()
  firebaseConfigInput.value = ''
  configRevision.value += 1
  emit('toast', t('realtime.configResetToast'))
}

async function handleEnableSharing() {
  if (!props.project || isBusy.value) return
  isBusy.value = true
  try {
    const res = await store.enableProjectRealtimeSync(props.project.id, {
      myMemberId: selectedMyMemberId.value || undefined,
      syncReceiptImages: syncReceiptImages.value,
    })
    if (res.omittedImageTxCount > 0) {
      emit(
        'toast',
        t('realtime.enabledOmittedImagesToast', { count: res.omittedImageTxCount }),
      )
    } else {
      emit('toast', t('realtime.enabledToast'))
    }
  } catch (err) {
    emit('toast', resolveSyncError(err))
  } finally {
    isBusy.value = false
  }
}

async function handleSelectMyMember(memberId: string) {
  selectedMyMemberId.value = memberId
  if (!props.project || !isShared.value) return
  await store.setMyMemberForProject(props.project.id, memberId)
  emit('toast', t('realtime.identityUpdatedToast'))
}

async function copyInviteUrl() {
  if (!inviteUrl.value) return
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(inviteUrl.value)
      emit('toast', t('realtime.inviteCopiedToast'))
      return
    }
  } catch {
    // 降級複製
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = inviteUrl.value
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
    emit('toast', t('realtime.inviteCopiedToast'))
  } catch {
    emit('toast', t('share.failedToast'))
  }
}

async function shareInviteUrl() {
  if (!inviteUrl.value || !props.project) return
  const text = t('realtime.inviteShareMessage', {
    name: props.project.name,
    url: inviteUrl.value,
  })
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({
        title: `${t('app.name')} · ${props.project.name}`,
        text,
        url: inviteUrl.value,
      })
      emit('toast', t('share.sharedToast'))
      return
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
    }
  }
  await copyInviteUrl()
}

async function handleRetrySync() {
  if (!props.project || isBusy.value) return
  isBusy.value = true
  try {
    await store.startProjectRealtimeListener(props.project.id)
    await store.flushProjectOutbox(props.project.id)
    emit('toast', t('realtime.resyncedToast'))
  } finally {
    isBusy.value = false
  }
}

async function handleRotateInviteLink() {
  if (!props.project || isBusy.value) return
  const ok = await askConfirm({
    title: t('realtime.rotateLinkButton'),
    message: t('realtime.rotateLinkConfirm'),
    confirmText: t('realtime.rotateLinkButton'),
    tone: 'danger',
  })
  if (!ok) return
  isBusy.value = true
  try {
    await store.rotateProjectInviteLink(props.project.id)
    emit('toast', t('realtime.rotateLinkSuccessToast'))
  } catch (err) {
    emit('toast', resolveSyncError(err))
  } finally {
    isBusy.value = false
  }
}

async function handleStopSync() {
  if (!props.project) return
  const ok = await askConfirm({
    title: t('realtime.stopSyncButton'),
    message: t('realtime.stopSyncConfirm'),
    confirmText: t('confirm.confirmButton'),
    tone: 'danger',
  })
  if (!ok) return
  await store.stopProjectRealtimeSync(props.project.id)
  emit('toast', t('realtime.stoppedToast'))
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open && project"
      ref="dialogRef"
      role="dialog"
      aria-modal="true"
      :aria-label="t('realtime.modalTitle')"
      class="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 backdrop-blur-sm sm:items-center sm:p-4"
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
            <div>
              <h2 class="text-sm font-bold text-slate-900 dark:text-white">
                {{ t('realtime.modalTitle') }}
              </h2>
              <p class="text-[11px] text-slate-400">
                {{ project.name }}
              </p>
            </div>
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

        <!-- 尚未設定 Firebase 時的精簡設定區塊 -->
        <div v-if="!firebaseReady" class="space-y-3">
          <div
            class="rounded-2xl border border-amber-200 bg-amber-50/70 p-3.5 text-xs leading-relaxed text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-200"
          >
            <div class="font-bold">{{ t('realtime.needConfigTitle') }}</div>
            <p class="mt-1 text-[11px] opacity-90">
              {{ t('realtime.needConfigDesc') }}
            </p>
            <ol class="mt-2 list-decimal space-y-1 pl-4 text-[11px]">
              <li>{{ t('realtime.setupStep1') }}</li>
              <li>{{ t('realtime.setupStep2') }}</li>
              <li>{{ t('realtime.setupStep3') }}</li>
            </ol>
          </div>

          <div class="space-y-1.5">
            <label class="block text-xs font-semibold text-slate-600 dark:text-slate-300">
              {{ t('realtime.configInputLabel') }}
            </label>
            <textarea
              v-model="firebaseConfigInput"
              rows="5"
              :placeholder="t('realtime.configInputPlaceholder')"
              class="w-full rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-[11px] text-slate-800 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
            <button
              type="button"
              :disabled="!firebaseConfigInput.trim()"
              class="w-full rounded-xl bg-slate-900 py-2.5 text-xs font-bold text-white disabled:opacity-40 dark:bg-emerald-500 dark:text-slate-950"
              @click="handleSaveFirebaseConfig"
            >
              {{ t('realtime.saveConfigButton') }}
            </button>
          </div>
        </div>

        <!-- 已具備 Firebase 設定：未開啟共享狀態 -->
        <div v-else-if="!isShared" class="space-y-4">
          <div
            class="rounded-2xl border border-emerald-200/80 bg-emerald-50/70 p-3.5 text-xs leading-relaxed text-emerald-900 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-200"
          >
            <div class="flex items-center gap-1.5 font-bold">
              <ShieldCheck class="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <span>{{ t('realtime.introTitle') }}</span>
            </div>
            <p class="mt-1 text-[11px] opacity-90">
              {{ t('realtime.introDesc') }}
            </p>
          </div>

          <!-- 認領自己在這團的成員身分 -->
          <div class="space-y-2">
            <div class="text-xs font-semibold text-slate-600 dark:text-slate-300">
              {{ t('realtime.selectMyIdentityLabel') }}
            </div>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="m in humanMembers"
                :key="m.id"
                type="button"
                class="inline-flex items-center gap-1.5 rounded-full py-1 pl-1.5 pr-3 text-xs font-semibold transition"
                :class="
                  selectedMyMemberId === m.id
                    ? 'bg-slate-900 text-white shadow-sm dark:bg-emerald-500 dark:text-slate-950'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200'
                "
                @click="selectedMyMemberId = m.id"
              >
                <MemberAvatar
                  :name="m.name"
                  :color="m.avatarColor"
                  :image="m.avatarImage"
                  size="xs"
                  ring
                />
                <span>{{ m.name }}</span>
                <Check v-if="selectedMyMemberId === m.id" class="h-3 w-3" />
              </button>
            </div>
          </div>

          <!-- 是否同步收據圖片開關 -->
          <label
            class="flex cursor-pointer items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs dark:border-slate-800 dark:bg-slate-800/60"
          >
            <div>
              <div class="font-semibold text-slate-800 dark:text-slate-100">
                {{ t('realtime.syncImagesLabel') }}
              </div>
              <div class="text-[10px] text-slate-400">
                {{ t('realtime.syncImagesHint') }}
              </div>
            </div>
            <input
              v-model="syncReceiptImages"
              type="checkbox"
              class="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
            />
          </label>

          <button
            type="button"
            :disabled="isBusy"
            class="flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-600 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50 dark:bg-emerald-500 dark:text-slate-950"
            @click="handleEnableSharing"
          >
            <Loader2 v-if="isBusy" class="h-4 w-4 animate-spin" />
            <Cloud v-else class="h-4 w-4" />
            <span>{{ t('realtime.enableButton') }}</span>
          </button>
        </div>

        <!-- 已開啟即時共享狀態 -->
        <div v-else class="space-y-4">
          <!-- 即時連線狀態卡（含雲端同步筆數與最後同步時間） -->
          <div
            class="space-y-1.5 rounded-2xl border px-3.5 py-3 text-xs"
            :class="
              syncStatus === 'synced'
                ? 'border-emerald-200 bg-emerald-50/70 text-emerald-900 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-200'
                : syncStatus === 'offline'
                  ? 'border-amber-200 bg-amber-50/70 text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200'
                  : 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200'
            "
          >
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 font-bold">
                <CheckCircle2
                  v-if="syncStatus === 'synced'"
                  class="h-4 w-4 text-emerald-600 dark:text-emerald-400"
                />
                <CloudOff
                  v-else-if="syncStatus === 'offline'"
                  class="h-4 w-4 text-amber-600 dark:text-amber-400"
                />
                <Loader2 v-else-if="syncStatus === 'connecting'" class="h-4 w-4 animate-spin" />
                <Cloud v-else class="h-4 w-4 text-rose-500" />
                <span>
                  {{
                    syncStatus === 'synced'
                      ? t('realtime.statusSynced')
                      : syncStatus === 'offline'
                        ? t('realtime.statusOffline', { count: outboxCount })
                        : syncStatus === 'connecting'
                          ? t('realtime.statusConnecting')
                          : t('realtime.statusError')
                  }}
                </span>
              </div>

              <button
                type="button"
                :disabled="isBusy"
                class="inline-flex items-center gap-1 rounded-lg bg-white/80 px-2 py-1 text-[11px] font-bold text-slate-700 shadow-sm hover:bg-white dark:bg-slate-900 dark:text-slate-200"
                @click="handleRetrySync"
              >
                <RefreshCw class="h-3 w-3" :class="isBusy ? 'animate-spin' : ''" />
                <span>{{ t('realtime.resyncButton') }}</span>
              </button>
            </div>

            <div class="text-[11px] font-medium opacity-80">
              {{
                formattedLastSyncedAt
                  ? t('realtime.statusMetaSummary', {
                      count: syncedTxCount,
                      time: formattedLastSyncedAt,
                    })
                  : t('realtime.statusMetaCountOnly', {
                      count: syncedTxCount,
                    })
              }}
            </div>
          </div>

          <!-- 專屬邀請連結與分享按鈕 -->
          <div class="space-y-2 rounded-2xl border border-slate-200 bg-slate-50/70 p-3.5 dark:border-slate-800 dark:bg-slate-950/50">
            <div class="flex items-center gap-1.5 text-xs font-bold text-slate-700 dark:text-slate-200">
              <Link2 class="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              <span>{{ t('realtime.inviteLinkTitle') }}</span>
            </div>
            <p class="text-[11px] text-slate-500 dark:text-slate-400">
              {{ t('realtime.inviteLinkHint') }}
            </p>
            <div class="flex items-center gap-1.5">
              <input
                :value="inviteUrl"
                type="text"
                readonly
                class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-[11px] text-slate-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
              />
              <button
                type="button"
                class="inline-flex shrink-0 items-center gap-1 rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                @click="copyInviteUrl"
              >
                <Copy class="h-3.5 w-3.5" />
                <span>{{ t('realtime.copyLinkButton') }}</span>
              </button>
            </div>
            <button
              type="button"
              class="flex w-full items-center justify-center gap-1.5 rounded-xl bg-slate-900 py-2.5 text-xs font-bold text-white transition hover:bg-slate-800 dark:bg-emerald-500 dark:text-slate-950"
              @click="shareInviteUrl"
            >
              <Share2 class="h-3.5 w-3.5" />
              <span>{{ t('realtime.shareInviteButton') }}</span>
            </button>
            <div
              v-if="project.syncMeta?.role === 'owner'"
              class="pt-1 text-right"
            >
              <button
                type="button"
                :disabled="isBusy"
                class="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-600 hover:underline disabled:opacity-40 dark:text-amber-400"
                @click="handleRotateInviteLink"
              >
                <RefreshCw class="h-3 w-3" />
                <span>{{ t('realtime.rotateLinkButton') }}</span>
              </button>
            </div>
          </div>

          <!-- 切換本機認領成員身分 -->
          <div class="space-y-2">
            <div class="text-xs font-semibold text-slate-600 dark:text-slate-300">
              {{ t('realtime.myIdentityLabel') }}
            </div>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="m in humanMembers"
                :key="m.id"
                type="button"
                class="inline-flex items-center gap-1.5 rounded-full py-1 pl-1.5 pr-3 text-xs font-semibold transition"
                :class="
                  selectedMyMemberId === m.id
                    ? 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-slate-950'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200'
                "
                @click="handleSelectMyMember(m.id)"
              >
                <MemberAvatar
                  :name="m.name"
                  :color="m.avatarColor"
                  :image="m.avatarImage"
                  size="xs"
                  ring
                />
                <span>{{ m.name }}</span>
              </button>
            </div>
          </div>

          <div class="border-t border-slate-100 pt-3 text-right dark:border-slate-800">
            <button
              type="button"
              class="text-xs font-semibold text-rose-500 hover:underline"
              @click="handleStopSync"
            >
              {{ t('realtime.stopSyncButton') }}
            </button>
          </div>
        </div>

        <!-- 進階：覆寫自訂 Firebase 設定（當已內建或已設定時折疊收合） -->
        <div
          v-if="firebaseReady"
          class="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800"
        >
          <button
            type="button"
            class="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
            @click="showAdvancedConfig = !showAdvancedConfig"
          >
            <ChevronUp v-if="showAdvancedConfig" class="h-3.5 w-3.5" />
            <ChevronDown v-else class="h-3.5 w-3.5" />
            <span>{{ t('realtime.advancedConfigToggle') }}</span>
          </button>

          <div v-if="showAdvancedConfig" class="mt-2 space-y-2">
            <textarea
              v-model="firebaseConfigInput"
              rows="4"
              :placeholder="t('realtime.configInputPlaceholder')"
              class="w-full rounded-xl border border-slate-200 bg-slate-50 p-2.5 font-mono text-[11px] text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
            <div class="flex items-center justify-between gap-2">
              <button
                v-if="hasCustomConfig"
                type="button"
                class="text-[11px] font-semibold text-rose-500 hover:underline"
                @click="handleClearCustomConfig"
              >
                {{
                  hasBuiltInConfig
                    ? t('realtime.resetBuiltInConfig')
                    : t('realtime.clearCustomConfig')
                }}
              </button>
              <span v-else />
              <button
                type="button"
                :disabled="!firebaseConfigInput.trim()"
                class="rounded-xl bg-slate-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40 dark:bg-emerald-500 dark:text-slate-950"
                @click="handleSaveFirebaseConfig"
              >
                {{ t('realtime.saveConfigButton') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
