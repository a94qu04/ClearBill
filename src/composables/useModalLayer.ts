import { nextTick, onBeforeUnmount, watch, type Ref, type WatchSource } from 'vue'

interface ModalLayerEntry {
  id: number
  onEscape?: () => void
  containerRef?: Ref<HTMLElement | null>
  previousActiveElement: HTMLElement | null
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

const modalStack: ModalLayerEntry[] = []
let nextLayerId = 1
let savedBodyOverflow: string | null = null
let keydownBound = false

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => {
      if (el.getAttribute('aria-hidden') === 'true') return false
      return el.offsetParent !== null || el === document.activeElement
    },
  )
}

function handleGlobalKeydown(event: KeyboardEvent) {
  if (modalStack.length === 0) return
  const top = modalStack[modalStack.length - 1]
  if (!top) return

  if (event.key === 'Escape') {
    event.preventDefault()
    top.onEscape?.()
    return
  }

  if (event.key === 'Tab') {
    const container = top.containerRef?.value
    if (!container) return
    const focusables = getFocusableElements(container)
    if (focusables.length === 0) {
      event.preventDefault()
      return
    }
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement as HTMLElement | null

    if (!active || !container.contains(active)) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
      return
    }
    if (event.shiftKey && active === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }
}

function syncBodyScrollLock() {
  if (typeof document === 'undefined') return
  if (modalStack.length > 0) {
    if (savedBodyOverflow === null) {
      savedBodyOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }
    if (!keydownBound && typeof window !== 'undefined') {
      window.addEventListener('keydown', handleGlobalKeydown)
      keydownBound = true
    }
  } else {
    if (savedBodyOverflow !== null) {
      document.body.style.overflow = savedBodyOverflow
      savedBodyOverflow = null
    }
    if (keydownBound && typeof window !== 'undefined') {
      window.removeEventListener('keydown', handleGlobalKeydown)
      keydownBound = false
    }
  }
}

function pushLayer(entry: ModalLayerEntry) {
  const existingIdx = modalStack.findIndex((item) => item.id === entry.id)
  if (existingIdx !== -1) {
    modalStack.splice(existingIdx, 1)
  }
  modalStack.push(entry)
  syncBodyScrollLock()

  if (typeof document !== 'undefined' && entry.containerRef) {
    void nextTick(() => {
      const container = entry.containerRef?.value
      if (!container) return
      const active = document.activeElement as HTMLElement | null
      if (active && container.contains(active)) return
      const focusables = getFocusableElements(container)
      if (focusables.length > 0) {
        focusables[0].focus({ preventScroll: true })
      } else {
        container.setAttribute('tabindex', '-1')
        container.focus({ preventScroll: true })
      }
    })
  }
}

function removeLayer(id: number) {
  const idx = modalStack.findIndex((item) => item.id === id)
  if (idx !== -1) {
    const [removed] = modalStack.splice(idx, 1)
    syncBodyScrollLock()
    if (
      removed?.previousActiveElement &&
      typeof document !== 'undefined' &&
      document.contains(removed.previousActiveElement)
    ) {
      try {
        removed.previousActiveElement.focus({ preventScroll: true })
      } catch {
        // 忽略無法聚焦之元素
      }
    }
  }
}

/**
 * 統一管理全站彈窗堆疊層級：
 * 1. 鎖定背景頁面捲動（Body Scroll Lock），多層彈窗完全關閉後才還原
 * 2. Escape 鍵永遠僅觸發最頂層彈窗，徹底避免連環誤關或確認框死循環
 * 3. 提供 Tab 鍵焦點循環鎖定（Focus Trap）與關閉後焦點歸還（A11y）
 */
export function useModalLayer(
  isOpen: WatchSource<boolean>,
  onEscape?: () => void,
  containerRef?: Ref<HTMLElement | null>,
) {
  const layerId = nextLayerId++

  watch(
    isOpen,
    (open) => {
      if (open) {
        const prev =
          typeof document !== 'undefined' &&
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null
        pushLayer({
          id: layerId,
          onEscape,
          containerRef,
          previousActiveElement: prev,
        })
      } else {
        removeLayer(layerId)
      }
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    removeLayer(layerId)
  })
}
