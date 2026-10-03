import type { AccountLoginRequest, AgentAccountsState } from '@shared/accounts'

/**
 * アカウントの画面（フッターの切り替え・設定のアカウント欄）と、ほかの部品をつなぐ窓口。
 *
 * - ログインのタブを開く依頼：TerminalPane が購読し、`terminal:create` に accountLogin を渡してタブを開く
 * - 一覧が変わった知らせ：フッターと設定の両方が同じ一覧を見せるように配る
 *
 * 部品どうしを props でつながず window のイベントにしたのは、フッター・設定・ターミナルが
 * App の別々の枝にあり、それぞれ別の担当が組み込むため。
 */

const LOGIN_EVENT = 'ade:account-login'
const CHANGED_EVENT = 'ade:accounts-changed'

/** 内蔵ターミナルでアカウントのログインを始めるよう頼む */
export function requestAccountLogin(req: AccountLoginRequest): void {
  window.dispatchEvent(new CustomEvent<AccountLoginRequest>(LOGIN_EVENT, { detail: req }))
}

/** ログインのタブを開く側（TerminalPane）が購読する。戻り値で購読をやめる */
export function onAccountLoginRequest(listener: (req: AccountLoginRequest) => void): () => void {
  const wrapped = (event: Event) => listener((event as CustomEvent<AccountLoginRequest>).detail)
  window.addEventListener(LOGIN_EVENT, wrapped)
  return () => window.removeEventListener(LOGIN_EVENT, wrapped)
}

export function publishAccountsState(state: AgentAccountsState): void {
  window.dispatchEvent(new CustomEvent<AgentAccountsState>(CHANGED_EVENT, { detail: state }))
}

export function onAccountsStateChanged(listener: (state: AgentAccountsState) => void): () => void {
  const wrapped = (event: Event) => listener((event as CustomEvent<AgentAccountsState>).detail)
  window.addEventListener(CHANGED_EVENT, wrapped)
  return () => window.removeEventListener(CHANGED_EVENT, wrapped)
}
