/**
 * 全体のダッシュボードに出すもの（作るのは src/main/orchestraOverview.ts）。
 * コストはインフラだけ（@shared/extraCost）。AI はサブスクで払っているので数えない。
 */

import type { CostForecast, ExtraPeriods } from './extraCost'
import type { ChecklistItem } from './humanChecklist'

export interface ProjectOverview {
  id: string
  name: string
  included: boolean
  /** まだ直していない指摘（送ったが完了していないものを含む） */
  open: number
  /** 人の確認を待っている指摘（before / after） */
  pending: number
  reviews: number
  /** 最後のレビューの id（YYYYMMDD-HHMMSS） */
  lastReview: string | null
  /** .ferret/costs.json のインフラの実績 */
  extra: ExtraPeriods
  /** 今のリソースから見た推定の月額 */
  forecast: CostForecast
}

export interface OrchestraOverview {
  projects: ProjectOverview[]
  /** 全体で共有するインフラ（全体のフォルダの .ferret/costs.json） */
  orchestraExtra: ExtraPeriods
  orchestraForecast: CostForecast
  checklist: ChecklistItem[]
  /** human.md の場所（無ければ null） */
  checklistPath: string | null
  /** ダッシュボードの並びと自由な部品（オーケストラのフォルダの .ferret/dashboard.json。無ければ今までの並び） */
  dashboard: import('./dashboardLayout').DashboardLayout
}
