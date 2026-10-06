/**
 * 中央のタブ列の右クリックの「閉じる」の対象（純粋な関数。単体テストの対象）。
 *
 * VS Code のタブのメニューと同じ並び: 閉じる / ほかを閉じる / 右側を閉じる / 保存済みを閉じる / すべて閉じる。
 * 閉じるのはファイルのタブ（file:…）だけ。ブラウザ・指摘・設定のタブは同じ列に並んでいても残す（「右側」の数え方には入る）。
 * 未保存の変更があるタブは対象に入れ、確認は呼び出し側（useOpenFiles.requestCloseMany）が1つずつ出す。
 */

export type CloseTabsAction = 'close' | 'closeOthers' | 'closeRight' | 'closeSaved' | 'closeAll'

export const CLOSE_TABS_ACTIONS: readonly CloseTabsAction[] = ['close', 'closeOthers', 'closeRight', 'closeSaved', 'closeAll']

function isFileTabId(tab: string): boolean {
  return tab.startsWith('file:')
}

/**
 * 閉じるタブ（タブの並びのうちのファイルのタブ）。order は画面の並び（ドラッグで並べ替えた後）、target は右クリックしたタブ。
 * dirty は未保存の変更があるか（保存済みを閉じる、で使う）
 */
export function tabsToClose(action: CloseTabsAction, target: string, order: readonly string[], dirty: (tab: string) => boolean): string[] {
  const files = order.filter(isFileTabId)
  switch (action) {
    case 'close': return files.includes(target) ? [target] : []
    case 'closeOthers': return files.filter((tab) => tab !== target)
    case 'closeRight': {
      const at = order.indexOf(target)
      return at === -1 ? [] : order.slice(at + 1).filter(isFileTabId)
    }
    case 'closeSaved': return files.filter((tab) => !dirty(tab))
    case 'closeAll': return files
  }
}

/**
 * タブを閉じた後に選ぶファイル。閉じたのが選択中なら、残ったものの右隣、無ければ左隣。全部閉じたら null（ブラウザへ戻す）。
 * order はファイルの並び、active は選択中のファイル（閉じる中に含まれていること）
 */
export function nextActiveAfterClose(order: readonly string[], active: string, closed: ReadonlySet<string>): string | null {
  const at = order.indexOf(active)
  const after = order.slice(at + 1).find((id) => !closed.has(id))
  if (after !== undefined) return after
  const before = order.slice(0, Math.max(0, at)).filter((id) => !closed.has(id))
  return before.at(-1) ?? null
}
