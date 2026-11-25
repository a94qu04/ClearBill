import { reactive } from 'vue'

export type ConfirmDialogTone = 'danger' | 'primary'

export interface ConfirmDialogOptions {
  title?: string
  message: string
  confirmText?: string
  cancelText?: string
  tone?: ConfirmDialogTone
}

interface ConfirmDialogState {
  open: boolean
  title: string
  message: string
  confirmText: string
  cancelText: string
  tone: ConfirmDialogTone
}

const state = reactive<ConfirmDialogState>({
  open: false,
  title: '',
  message: '',
  confirmText: '',
  cancelText: '',
  tone: 'danger',
})

let resolver: ((result: boolean) => void) | null = null

/**
 * 全域自製確認對話框（全面取代原生 window.confirm，避免瀏覽器／App 出現醜陋系統框）
 */
export function askConfirm(options: ConfirmDialogOptions): Promise<boolean> {
  if (resolver) {
    resolver(false)
    resolver = null
  }
  state.title = options.title ?? ''
  state.message = options.message
  state.confirmText = options.confirmText ?? ''
  state.cancelText = options.cancelText ?? ''
  state.tone = options.tone ?? 'danger'
  state.open = true

  return new Promise<boolean>((resolve) => {
    resolver = resolve
  })
}

export function resolveConfirm(accepted: boolean): void {
  state.open = false
  if (resolver) {
    const fn = resolver
    resolver = null
    fn(accepted)
  }
}

export function useConfirmDialogState() {
  return {
    state,
    resolveConfirm,
  }
}
