import { defineStore, storeToRefs } from 'pinia'
import {
  CurrencyCodeSchema,
  type Project,
  type Transaction,
} from '@/schemas/ledgerSchema'
import {
  buildNextSettlementViewForCurrencyChange,
  buildNextSettlementViewForRateConfig,
  migrateLegacyProjectSettlementViews,
  resolveCustomRatesForTarget,
  resolveSettlementCurrency,
  resolveSettlementOptions,
  resolveSettlementRateMode,
  type LocalSettlementViewPrefs,
  type ResolvedSettlementOptions,
  type SettlementRateMode,
} from '@/core/settlementRateResolver'
import { useUserPrefsStore } from '@/stores/userPrefsStore'

export type { LocalSettlementViewPrefs }

export interface SettlementViewDataSource {
  findNonDeletedProject: (projectId: string) => Project | undefined
  getVisibleProjectTransactions: (projectId: string) => Transaction[]
}

export const useSettlementViewStore = defineStore('settlementView', () => {
  const userPrefsStore = useUserPrefsStore()
  const { settlementViewByProject } = storeToRefs(userPrefsStore)

  let dataSource: SettlementViewDataSource | null = null

  function bindDataSource(source: SettlementViewDataSource): void {
    dataSource = source
  }

  /** 取得專案目前於此裝置結算頁使用的結帳幣別（優先讀取本機視角偏好，未設定時回退專案設定／記帳主幣別） */
  function getProjectSettlementCurrency(
    project: Pick<Project, 'baseCurrency' | 'settlementCurrency'> & { id?: string },
  ): string {
    const localView = project.id
      ? settlementViewByProject.value[project.id]
      : undefined
    return resolveSettlementCurrency(project, localView)
  }

  /** 取得專案目前於此裝置結算頁使用的匯率模式（本機偏好獨立保存，不與旅伴透過 Firestore 互蓋） */
  function getProjectSettlementRateMode(
    project: Pick<Project, 'id' | 'settlementRateMode'>,
  ): SettlementRateMode {
    return resolveSettlementRateMode(
      project,
      settlementViewByProject.value[project.id],
    )
  }

  function getProjectCustomRatesForTarget(
    project: Project,
    targetCurrency: string,
  ): Record<string, number> | undefined {
    return resolveCustomRatesForTarget(
      project,
      settlementViewByProject.value[project.id],
      targetCurrency,
    )
  }

  function getProjectSettlementOptions(
    project: Project,
    projectTxs?: Transaction[],
  ): ResolvedSettlementOptions {
    const txs =
      projectTxs ?? dataSource?.getVisibleProjectTransactions(project.id) ?? []
    return resolveSettlementOptions(
      project,
      settlementViewByProject.value[project.id],
      txs,
      userPrefsStore.getEffectiveExchangeRateWithSource,
    )
  }

  /**
   * 依據專案設定的結帳幣別與匯率模式（per_tx / live / custom）產出結算幣別與匯率覆寫設定
   */
  function getProjectSettlementRateOverrides(
    project: Project,
    projectTxs?: Transaction[],
  ): Record<string, number> | undefined {
    return getProjectSettlementOptions(project, projectTxs).options
      .overrideRatesByCurrency
  }

  /**
   * 切換此裝置上的結帳幣別（純本機視角偏好，不推送 Firestore 避免多人結帳時互相覆寫打架）
   */
  async function updateProjectSettlementCurrency(
    projectId: string,
    currency: string,
  ): Promise<Project | null> {
    const existing = dataSource?.findNonDeletedProject(projectId)
    if (!existing) return null

    const normalized = CurrencyCodeSchema.parse(currency)
    const prevLocal = settlementViewByProject.value[projectId]
    const prevSettleCurrency = getProjectSettlementCurrency(existing)
    if (
      normalized === prevSettleCurrency &&
      prevLocal?.settlementCurrency === normalized
    ) {
      return existing
    }

    settlementViewByProject.value = {
      ...settlementViewByProject.value,
      [projectId]: buildNextSettlementViewForCurrencyChange(
        existing,
        prevLocal,
        normalized,
      ),
    }
    userPrefsStore.saveUserPrefs()
    return existing
  }

  /**
   * 切換此裝置上的結算匯率模式／自訂結算匯率（純本機視角偏好，不推送 Firestore）
   */
  async function updateProjectSettlementRateConfig(
    projectId: string,
    mode: SettlementRateMode,
    customRates?: Record<string, number>,
  ): Promise<Project | null> {
    const existing = dataSource?.findNonDeletedProject(projectId)
    if (!existing) return null

    const prevLocal = settlementViewByProject.value[projectId]
    settlementViewByProject.value = {
      ...settlementViewByProject.value,
      [projectId]: buildNextSettlementViewForRateConfig(
        existing,
        prevLocal,
        mode,
        customRates,
      ),
    }
    userPrefsStore.saveUserPrefs()
    return existing
  }

  /**
   * 一次性遷移：將專案上殘留的舊版結算欄位搬移至本機 `settlementViewByProject`，
   * 之後統一以本機裝置視角為唯一真相來源。
   */
  function migrateLegacyProjectViews(projects: ReadonlyArray<Project>): number {
    const result = migrateLegacyProjectSettlementViews(
      projects,
      settlementViewByProject.value,
    )
    if (!result.changed) return 0
    settlementViewByProject.value = result.nextLocalViews
    userPrefsStore.saveUserPrefs()
    return result.migratedProjectIds.length
  }

  return {
    settlementViewByProject,
    bindDataSource,
    migrateLegacyProjectViews,
    getProjectSettlementCurrency,
    getProjectSettlementRateMode,
    getProjectCustomRatesForTarget,
    getProjectSettlementOptions,
    getProjectSettlementRateOverrides,
    updateProjectSettlementCurrency,
    updateProjectSettlementRateConfig,
  }
})
