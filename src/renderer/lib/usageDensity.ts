/**
 * フッターの使用量表示を、空きに合わせて段階的に短くするための純粋関数。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/status-bar/status-bar-density.ts（MIT, Copyright 2026 Lovecast Inc.）
 */

export type UsageMode = 'verbose' | 'compact'

/**
 * フッターが狭いときの段階（Orca の STATUS_BAR_DENSITY_LEVELS と同じく、広い順に並べ、役に立たないものから捨てる）。
 * 0: 選んだ表示のまま → 1: 「used」を省く → 2: Fable などの副次の枠を省く → 3: バーと％だけ → 4: ％だけ（それでも溢れれば末尾を省略記号）
 * 捨てたものは Usage のポップオーバーで全部見られる。
 */
export const USAGE_DENSITY_LEVELS = 5
export type SegmentDetail = { used: boolean; secondary: boolean; labels: boolean; bar: boolean; allSections: boolean }

export function segmentDetail(mode: UsageMode, level: number): SegmentDetail {
  if (level >= 4) return { used: false, secondary: false, labels: false, bar: false, allSections: false }
  if (level === 3) return { used: false, secondary: false, labels: false, bar: mode === 'verbose', allSections: false }
  if (mode === 'compact') return { used: level === 0, secondary: false, labels: true, bar: false, allSections: false }
  return { used: level === 0, secondary: level <= 1, labels: true, bar: true, allSections: true }
}

export const WIDTH_TOLERANCE_PX = 1

export function pickUsageDensityLevel(widths: ReadonlyArray<number | undefined>, available: number): number {
  for (let level = 0; level < USAGE_DENSITY_LEVELS - 1; level++) {
    const width = widths[level]
    if (width === undefined || width <= available + WIDTH_TOLERANCE_PX) return level
  }
  return USAGE_DENSITY_LEVELS - 1
}

