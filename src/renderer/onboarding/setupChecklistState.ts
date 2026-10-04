import type { PlatformName } from '@shared/types'
import type { MediaAccessStatus } from '@shared/onboarding'

/**
 * セットアップのチェックリスト（設定の一番上の「Setup」と、サイドバーの「Setup n/7」）。
 * 手でチェックする形にせず、設定・Agent の検出・文字起こしの準備・権限・レビューの一覧から、済んだかを自動で決める。
 * 画面に依存しない純粋な関数だけを置く（単体テストの対象）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/sidebar/SetupGuideSidebarEntry.tsx の
 *           「全部済むまでサイドバーに進み具合を出し、済んだら消える」使い心地（MIT）。
 */

export type SetupItemId = 'agent' | 'agentSkill' | 'project' | 'transcription' | 'decision' | 'permissions' | 'firstRecording' | 'firstSend'

export interface SetupChecklistInput {
  platform: PlatformName
  /** プロジェクトを開いたら自動で開く Agent（設定の agents.startupAgents） */
  startupAgents: readonly string[]
  /** インストール済みの Agent の id（agents:list）。探している途中なら null */
  installedAgents: readonly string[] | null
  /** Ferret の設定を変える skill をどれかの Agent に入れてあるか（agentSkill:status）。読めていなければ null */
  agentSkillInstalled: boolean | null
  projectCount: number
  /** 端末内の whisper のモデルがある、または自分のキーの提供元が使える（capture:availability） */
  transcriptionReady: boolean
  /** 判定モデルが有効で、接続先とキーが揃っている */
  decisionReady: boolean
  /** OS の許可（permissions:status）。読めていなければ null */
  permissions: { microphone: MediaAccessStatus; screen: MediaAccessStatus } | null
  /** 全プロジェクトのレビューの数と、そのうち Agent へ送ったもの（sentAt がある）の数 */
  reviewCount: number
  sentCount: number
}

export interface SetupItem {
  id: SetupItemId
  done: boolean
}

/** 並びは使う順（Agent → 設定の skill → プロジェクト → 文字起こし → 判定モデル → 許可 → 録る → 送る） */
const ORDER: readonly SetupItemId[] = ['agent', 'agentSkill', 'project', 'transcription', 'decision', 'permissions', 'firstRecording', 'firstSend']

/**
 * 項目と済んだか。許可は macOS だけ（ほかの OS は許可が要らないので項目を出さない）。
 * 許可はマイクだけを見る（画面収録は画面全体・別のウインドウを録るときだけ要り、内蔵ブラウザなら要らないため）
 */
export function setupChecklist(input: SetupChecklistInput): SetupItem[] {
  const installed = new Set(input.installedAgents ?? [])
  const done: Record<SetupItemId, boolean> = {
    agent: input.installedAgents !== null && input.startupAgents.some((id) => installed.has(id)),
    agentSkill: input.agentSkillInstalled === true,
    project: input.projectCount > 0,
    transcription: input.transcriptionReady,
    decision: input.decisionReady,
    permissions: input.permissions?.microphone === 'granted',
    firstRecording: input.reviewCount > 0,
    firstSend: input.sentCount > 0
  }
  return ORDER.filter((id) => id !== 'permissions' || input.platform === 'darwin').map((id) => ({ id, done: done[id] }))
}

export function setupProgress(items: readonly SetupItem[]): { done: number; total: number; complete: boolean } {
  const doneCount = items.filter((item) => item.done).length
  return { done: doneCount, total: items.length, complete: doneCount === items.length }
}
