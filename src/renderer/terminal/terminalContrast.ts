/**
 * ターミナルの文字と地の最低コントラスト（xterm の minimumContrastRatio。純粋な関数）。
 *
 * Orca の terminal-contrast-correction.ts と同じ値: 明るい地は 4.5（WCAG AA）、暗い地は 3。
 * Agent が白や明るい色で書いた文字がライト配色の白地で消える（Orca #2830）、
 * 暗い地に暗い文字で読めない（Orca #10104）のを防ぐ。xterm の既定は 1（補正なし）
 */
export const LIGHT_BG_MIN_CONTRAST = 4.5
export const DARK_BG_MIN_CONTRAST = 3

/** #rgb / #rrggbb の相対輝度（0〜1）。読めなければ null */
export function relativeLuminance(color: string): number | null {
  const hex = color.trim().replace(/^#/, '')
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex
  if (!/^[0-9a-f]{6}$/i.test(full)) return null
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = Number.parseInt(full.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

export function minimumContrastFor(background: string): number {
  const luminance = relativeLuminance(background)
  return luminance !== null && luminance > 0.5 ? LIGHT_BG_MIN_CONTRAST : DARK_BG_MIN_CONTRAST
}
