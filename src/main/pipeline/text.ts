/** 日本語テキストの正規化と類似度。二重取りの除去と引用の実在チェックで使う。 */
import { getLocale, translate, type SupportedLocale } from '@shared/i18n'

/** 全角英数→半角、カタカナの半角→全角、記号・空白・長音の揺れを落とす */
export function normalizeJa(s: string): string {
  let out = s.normalize('NFKC').toLowerCase();
  // 句読点・記号・空白を落とす（日本語は語境界が無いので区切りを捨てても比較できる）
  out = out.replace(/[\s　]+/g, '')
  out = out.replace(/[、。，．,.!?！？「」『』（）()[\]【】~〜ー…・:;:；"'`]/g, '');
  // ひらがな→カタカナに寄せる（「えっと」/「エット」の揺れ）
  out = out.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
  return out
}

/** 文字bigramのDice係数。0〜1 */
export function similarity(a: string, b: string): number {
  const na = normalizeJa(a)
  const nb = normalizeJa(b)
  if (na.length === 0 || nb.length === 0) return na === nb ? 1 : 0
  if (na === nb) return 1
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>()
    if (s.length === 1) {
      m.set(s, 1)
      return m
    }
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    return m
  }
  const ga = grams(na)
  const gb = grams(nb)
  let inter = 0
  let total = 0
  for (const [, c] of ga) total += c
  for (const [g, c] of gb) {
    total += c
    const o = ga.get(g)
    if (o !== undefined) inter += Math.min(o, c)
  }
  return (2 * inter) / total
}

/** a が b に（正規化後に）含まれるか。短い発話が長い発話に飲まれる二重取りの判定用 */
export function containsNormalized(haystack: string, needle: string): boolean {
  const h = normalizeJa(haystack)
  const n = normalizeJa(needle)
  return n.length > 0 && h.includes(n)
}

/** mm:ss 形式。feedback.md の見出しで使う */
export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 「4分12秒」形式。feedback.md のヘッダで使う */
export function formatDurationJa(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}分${s}秒` : `${s}秒`
}

/** 収録の長さを画面の言語で書く（「4分12秒」／「4m 12s」）。feedback.md のヘッダで使う */
export function formatDuration(ms: number, locale: SupportedLocale = getLocale()): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? translate(locale, 'feedbackMd.duration', { m, s }) : translate(locale, 'feedbackMd.durationSeconds', { s })
}
