import type { ProviderRateLimits } from '@shared/usage'
import type { TuiAgent } from '@shared/types'

/**
 * 上限に達したことの判定（副作用のない部分）。
 *
 * 1. Agent のターミナルの出力に出る上限の知らせ。各 CLI の実際の文言（2026-10 に公式の issue・資料で確かめたもの）:
 *    - Claude Code: 「5-hour limit reached ∙ resets 3pm」「You've hit your session limit · resets 3:45pm」
 *      「You've hit your weekly limit · resets Mon 12:00am」「Claude usage limit reached. Your limit will reset at 3pm」
 *      「Usage limit reached · continuing automatically at 3:45pm · esc to cancel」「Claude AI usage limit reached|1760000000」
 *    - Codex: 「You've hit your usage limit. Upgrade to Pro (…) or try again in 3 hours 2 minutes.」
 *      「You've hit your usage limit. To get more access now, send a request to your admin or try again at …」
 *    - Gemini CLI など: 「Quota exceeded for quota metric …」「RESOURCE_EXHAUSTED」「usage limit reached」
 * 2. 使用量の取得（フッターの Usage と同じ値）で、5時間・週・モデル別のどれかがしきい値以上。
 *
 * Agent が本文の中でこれらの語を書いただけ（コードやログの引用・差分）で切り替えないよう、
 * 行の頭（枠や記号を除いたところ）から始まる、短い状態行だけを見る。
 */

/** 行頭の飾り（枠・記号・箇条書き）。数字や +- は含めない（差分の行を拾わない） */
const LEAD = String.raw`^[\s│┃|>⎿●○■□▪•·✗✘⚠!*]*`

const CLAUDE_PATTERNS: RegExp[] = [
  new RegExp(`${LEAD}(?:(?:5-hour|session|weekly|opus|sonnet|fable|daily)\\s+){0,2}(?:usage\\s+)?limit reached\\b`, 'i'),
  new RegExp(`${LEAD}(?:Claude(?: AI)?\\s+)?usage limit reached\\b`, 'i'),
  new RegExp(`${LEAD}You(?:'|’)ve hit your (?:session |weekly |usage |opus |sonnet |fable )?limit\\b`, 'i')
]

const CODEX_PATTERNS: RegExp[] = [
  new RegExp(`${LEAD}You(?:'|’)ve hit your usage limit\\b`, 'i'),
  new RegExp(`${LEAD}(?:usage|rate) limit reached\\b`, 'i')
]

const GENERIC_PATTERNS: RegExp[] = [
  new RegExp(`${LEAD}(?:\\[?API Error\\]?:?\\s*)?Quota exceeded\\b`, 'i'),
  new RegExp(`${LEAD}.{0,40}\\bRESOURCE_EXHAUSTED\\b`),
  new RegExp(`${LEAD}You(?:'|’)ve (?:hit|reached) your (?:daily |usage |session |weekly )?(?:limit|quota)\\b`, 'i'),
  new RegExp(`${LEAD}(?:usage|daily) (?:limit|quota) (?:reached|exceeded)\\b`, 'i')
]

/** 状態行とみなす長さの上限（本文の長い段落は見ない） */
const MAX_STATUS_LINE = 220

function patternsFor(agent: TuiAgent): RegExp[] {
  if (agent === 'claude') return CLAUDE_PATTERNS
  if (agent === 'codex') return CODEX_PATTERNS
  return GENERIC_PATTERNS
}

/** その行が上限の知らせか */
function isLimitLine(agent: TuiAgent, line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed || trimmed.length > MAX_STATUS_LINE) return false
  return patternsFor(agent).some((re) => re.test(line))
}

/** 新しく届いた出力（ANSI を落としたもの）に、どれかの Agent の上限の知らせらしい行があるか（素早い一次判定） */
export function mentionsLimit(text: string): boolean {
  if (!/limit|quota|RESOURCE_EXHAUSTED/i.test(text)) return false
  return text.split(/\r?\n|\r/).some((line) => ['claude', 'codex', 'gemini'].some((agent) => isLimitLine(agent as TuiAgent, line)))
}

/**
 * 画面の末尾（最後の lines 行）に、その Agent の上限の知らせが出ているか。
 * 末尾だけを見るので、上へ流れていった古い知らせ（枠が戻ったあと）では切り替えない
 */
export function limitOnScreen(agent: TuiAgent, screen: string, lines = 20): boolean {
  const tail = screen.split(/\r?\n|\r/).filter((line) => line.trim()).slice(-lines)
  return tail.some((line) => isLimitLine(agent, line))
}

/** 使用量のいちばん高い枠（%）。値が無ければ null（分からない） */
export function maxUsedPercent(limits: ProviderRateLimits | null | undefined): number | null {
  if (!limits || limits.unlimited) return limits?.unlimited ? 0 : null
  const windows = [limits.session, limits.weekly, limits.fableWeekly, limits.spendLimit].filter((w): w is NonNullable<typeof w> => !!w)
  if (windows.length === 0) return null
  return Math.max(...windows.map((w) => (Number.isFinite(w.usedPercent) ? w.usedPercent : 0)))
}

/** しきい値以上の枠のうち、戻る時刻のいちばん遅いもの（そこまでは使えない）。分からなければ null */
export function limitedUntil(limits: ProviderRateLimits | null | undefined, thresholdPercent: number): number | null {
  if (!limits) return null
  const windows = [limits.session, limits.weekly, limits.fableWeekly, limits.spendLimit].filter((w): w is NonNullable<typeof w> => !!w && w.usedPercent >= thresholdPercent)
  const resets = windows.map((w) => w.resetsAt).filter((at): at is number => typeof at === 'number')
  return resets.length > 0 ? Math.max(...resets) : null
}
