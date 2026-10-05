/**
 * 「指摘の整理」の提供元・モデルをアプリの中で変えたことを、ほかの画面へ知らせる。
 * settings:changed は settings.json の外からの書き換えでだけ届くので、指摘の画面の「整理」の横と設定の「指摘の整理」は
 * 保存したあとにこれを出し、受けた側は app:settings を読み直す
 */
const ORGANIZER_CHANGED_EVENT = 'ade:organizer-changed'

/** 保存が済んだあとに呼ぶ */
export function notifyOrganizerChanged(): void {
  window.dispatchEvent(new CustomEvent(ORGANIZER_CHANGED_EVENT))
}

/** 受ける。戻り値で外す */
export function onOrganizerChanged(listener: () => void): () => void {
  window.addEventListener(ORGANIZER_CHANGED_EVENT, listener)
  return () => window.removeEventListener(ORGANIZER_CHANGED_EVENT, listener)
}
