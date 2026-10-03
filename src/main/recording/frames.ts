/**
 * 静止画の重複判定と名前付け（設計4章「画面が変化した時のみ保存」）。
 *
 * Electron に依存しない純粋な処理だけを置く。撮影そのものは stills.ts。
 */

/** 変化なしとみなす差の割合（0〜1）。アンチエイリアスのゆらぎを拾わない程度 */
export const DEFAULT_SAME_RATIO = 0.012

/** 1画素を「違う」とみなす輝度差の合計（BGRAの3成分の絶対差の和） */
export const DEFAULT_PIXEL_DELTA = 24

/**
 * 縮小画像どうしを比べて、画面が変わったかを返す。
 *
 * 全画素を比べると0.5秒ごとの判定には重いので、呼び出し側が
 * 32px幅へ縮めた生画素（BGRA）を渡す前提。
 *
 * @param previous 直前に保存した画像の縮小画素。無ければ null（＝必ず変化扱い）
 */
export function hasChanged(
  previous: Uint8Array | null,
  current: Uint8Array,
  options: { sameRatio?: number; pixelDelta?: number } = {}
): boolean {
  if (!previous || previous.length === 0 || current.length === 0) return true
  if (previous.length !== current.length) return true

  const pixelDelta = options.pixelDelta ?? DEFAULT_PIXEL_DELTA
  const sameRatio = options.sameRatio ?? DEFAULT_SAME_RATIO

  let differing = 0
  for (let i = 0; i < previous.length; i += 4) {
    const delta =
      Math.abs(previous[i] - current[i]) +
      Math.abs(previous[i + 1] - current[i + 1]) +
      Math.abs(previous[i + 2] - current[i + 2])
    if (delta > pixelDelta) differing++
  }
  const pixels = previous.length / 4
  return differing / pixels >= sameRatio
}

/**
 * 縮小画像（BGRA）がほぼ一色か。読み込み途中の白いページや、上の帯しか描かれていない画面を見分ける。
 * いちばん多い色から外れた画素が `minInkRatio` 未満なら一色とみなす。
 */
export function isNearlyBlank(bitmap: Uint8Array, options: { minInkRatio?: number; pixelDelta?: number } = {}): boolean {
  const pixels = Math.floor(bitmap.length / 4)
  if (pixels === 0) return true
  const minInkRatio = options.minInkRatio ?? 0.03
  const pixelDelta = options.pixelDelta ?? DEFAULT_PIXEL_DELTA
  // 地の色: 量子化した色の最頻値
  const counts = new Map<number, number>()
  for (let i = 0; i < pixels * 4; i += 4) {
    const key = ((bitmap[i]! >> 4) << 8) | ((bitmap[i + 1]! >> 4) << 4) | (bitmap[i + 2]! >> 4)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let base = 0
  let best = -1
  for (const [key, n] of counts) if (n > best) { best = n; base = key }
  const [b0, g0, r0] = [((base >> 8) & 15) * 16 + 8, ((base >> 4) & 15) * 16 + 8, (base & 15) * 16 + 8]
  let ink = 0
  for (let i = 0; i < pixels * 4; i += 4) {
    if (Math.abs(bitmap[i]! - b0) + Math.abs(bitmap[i + 1]! - g0) + Math.abs(bitmap[i + 2]! - r0) > pixelDelta) ink++
  }
  return ink / pixels < minInkRatio
}

/** 連番のファイル名。時刻順に並ぶように0埋めする */
export function frameFileName(sequence: number, format: 'jpeg' | 'png'): string {
  return `${String(sequence).padStart(5, '0')}.${format}`
}

/**
 * 保存する幅を決める。
 * Retina の原寸は1枚100KB超になり、長時間の録画で作業フォルダが膨らむ。
 * 最終出力は長辺1568pxへ縮めるので（設計5章④）、作業用もその少し上で足りる。
 *
 * @returns 縮小が要らなければ null
 */
export function targetWidth(sourceWidth: number, maxWidth: number): number | null {
  if (maxWidth <= 0 || sourceWidth <= maxWidth) return null
  return maxWidth
}
