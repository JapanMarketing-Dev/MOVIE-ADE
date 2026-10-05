/**
 * ポップアップの上の書き込み（ペン・四角の枠・文字で指摘）の純粋な処理。Electron に依存させない（main・単体テストで共用）。
 *
 * ポップアップは2種類ある:
 * - 拡張機能のポップアップ（browserExtensions.ts）。内蔵ブラウザのビューの右上に重ねる別の WebContentsView。
 *   録画（タブ録画の合成）と静止画（overlayStillSource）にはビューの上の同じ位置で重なるので、別のトラックにはしない。
 *   書き込みはポップアップの中で引き、記録の座標は内蔵ブラウザのビューの座標へ直す（mapPopupBox）
 * - ログインのポップアップ（window.open に大きさを指定したもの。Google でログインなど。browser.ts の子ウインドウ）。
 *   別の窓なので、録画中は映像を1本足し（タブ録画。OS の画面収録の許可は要らない）、前に出たらそちらへ切り替えて書き込む
 */

/** 書き込みの道具（録画中） */
export type PopupAnnotationMode = 'off' | 'pen' | 'rect'

/** いまの書き込みの状態 */
export interface AnnotationActivity {
  /** 録画中（一時停止を含む） */
  capturing: boolean
  /** 録画の書き込みの道具 */
  mode: PopupAnnotationMode
  /** 文字で指摘が入（録画していないとき） */
  note: boolean
}

/** 書き込みの最中か（録画中に道具を選んでいる・文字で指摘が入） */
export function annotatingNow(activity: AnnotationActivity): boolean {
  return (activity.capturing && activity.mode !== 'off') || activity.note
}

/**
 * 拡張機能のポップアップを閉じるきっかけ（Chrome と同じく、ほかを押す・Esc で閉じる）。
 *   escape … ポップアップの中で Esc
 *   page   … 内蔵ブラウザのページを押した
 *   app    … アプリの画面（ツールバーなど）を押した
 */
export type PopupDismissCause = 'escape' | 'page' | 'app'

/**
 * そのきっかけでポップアップを閉じるか。
 * 書き込みの最中は閉じない（ペン・枠・文字で指摘を引き始めた・Esc で道具を切った、でポップアップが消えないように）。
 * 録画中・文字で指摘の間は、アプリの画面（ツールバーで道具や色を選ぶ）を押しても閉じない
 */
export function shouldCloseExtensionPopup(cause: PopupDismissCause, activity: AnnotationActivity): boolean {
  if (cause === 'app') return !activity.capturing && !activity.note
  return !annotatingNow(activity)
}

/**
 * 拡張機能のポップアップに書き込みの注入スクリプト（preload/review）を入れるか。
 * ふだんは入れない（Ferret の IPC を一切持たせない）。録画中・文字で指摘の間に開いたものだけに入れる。
 * 入れても、main が受けるのは内蔵ブラウザのページと同じ書き込みのチャネルだけで、送り主（そのポップアップ）を確かめる
 */
export function extensionPopupGetsReviewPreload(activity: Pick<AnnotationActivity, 'capturing' | 'note'>): boolean {
  return activity.capturing || activity.note
}

export interface ViewSize {
  width: number
  height: number
}

/** ビューの中の割合（0〜1）の矩形 */
export interface FractionRect {
  x: number
  y: number
  width: number
  height: number
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const positive = (n: unknown): n is number => finite(n) && n > 0

/**
 * 拡張機能のポップアップの中で引いた書き込みの枠（ポップアップの CSS px）を、内蔵ブラウザのビューの CSS px へ直す。
 *
 * @param popupView ポップアップの innerWidth・innerHeight（注入スクリプトが添える）
 * @param rect      ポップアップの、ビューの中の位置（0〜1 の割合。録画の合成と同じもの）
 * @param browserView 内蔵ブラウザのページの innerWidth・innerHeight（分かっていれば）。
 *                    分からなければ、ポップアップとページの倍率が同じ（DIP = CSS px）として割合から求める
 * @returns 直した枠とビューの大きさ。値が壊れていれば null
 */
export function mapPopupBox(
  bbox: unknown,
  popupView: ViewSize | undefined,
  rect: FractionRect,
  browserView?: ViewSize
): { bbox: [number, number, number, number]; view: ViewSize } | null {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(finite)) return null
  if (!popupView || !positive(popupView.width) || !positive(popupView.height)) return null
  if (!finite(rect.x) || !finite(rect.y) || !positive(rect.width) || !positive(rect.height)) return null
  const width = browserView && positive(browserView.width) ? browserView.width : popupView.width / rect.width
  const height = browserView && positive(browserView.height) ? browserView.height : popupView.height / rect.height
  // ポップアップの 1 CSS px が、ページの何 CSS px にあたるか
  const sx = (rect.width * width) / popupView.width
  const sy = (rect.height * height) / popupView.height
  const [x, y, w, h] = bbox as [number, number, number, number]
  return {
    bbox: [Math.round(rect.x * width + x * sx), Math.round(rect.y * height + y * sy), Math.round(w * sx), Math.round(h * sy)],
    view: { width: Math.round(width), height: Math.round(height) }
  }
}

/** 書き込みの注入スクリプトから届いた IPC の送り主が、どの面のものか */
export type ReviewSurface = 'review' | 'overlay'

/**
 * 送り主が、いま書き込みを受けている面か。
 *   review  … いま映しているトラックの面（内蔵ブラウザ・映したウインドウ・前に出ているログインのポップアップ）
 *   overlay … 内蔵ブラウザを映しているときの、その上の拡張機能のポップアップ
 * ほか（隠れたビュー・閉じたポップアップ・別のページ）は null で、何も受けない
 */
export function reviewSurfaceOf<T>(sender: T, surfaces: { review: T | null; overlay: T | null }): ReviewSurface | null {
  if (sender === null || sender === undefined) return null
  if (sender === surfaces.review) return 'review'
  if (sender === surfaces.overlay) return 'overlay'
  return null
}

/**
 * ログインのポップアップのトラックの名前に使うホスト名（http・https だけ。読めない・ほかのスキームは空）。
 * 名前は指摘をまとめる鍵にもなるので、パスやクエリ（ログインの一時的な値）は入れない
 */
export function popupHost(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.slice(0, 200) : ''
  } catch {
    // 読めない URL（about:blank など）は名前を付けない（想定内）
    return ''
  }
}

/**
 * ログインのポップアップから戻るときに映すトラック。ポップアップへ切り替える前に映していたものが録り続けていればそれ、無ければ main
 */
export function popupReturnTrack(returnId: string | null, liveIds: readonly string[]): string {
  return returnId && liveIds.includes(returnId) ? returnId : 'main'
}
