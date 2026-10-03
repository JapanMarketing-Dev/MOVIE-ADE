import type { FeedbackKind } from '@shared/feedback'

/**
 * フィードバックの画面を開く窓口。サイドバー・ヘルプのメニュー・エラーのトーストの「報告する」・声かけのトーストから使う。
 * ui/ の部品（Toast）からも呼べるよう、components に依存しない小さなファイルにしている。
 */

export interface FeedbackPrefill {
  kind?: FeedbackKind
  /** エラーの種類など。エラーの全文やパスは入れない */
  title?: string
}

const OPEN_EVENT = 'ade:open-feedback'

export function requestFeedback(prefill: FeedbackPrefill = {}): void {
  window.dispatchEvent(new CustomEvent<FeedbackPrefill>(OPEN_EVENT, { detail: prefill }))
}

export function onFeedbackRequest(listener: (prefill: FeedbackPrefill) => void): () => void {
  const wrapped = (event: Event) => listener((event as CustomEvent<FeedbackPrefill>).detail ?? {})
  window.addEventListener(OPEN_EVENT, wrapped)
  return () => window.removeEventListener(OPEN_EVENT, wrapped)
}
