import { getLocale, translate, type SupportedLocale } from './i18n'

/**
 * Agentへ渡す1行の指示（「Agentへ送信」「Agent向けにコピー」）。
 * 文面は設定（Settings.agentPrompt）で変えられ、空なら既定文を使う。
 * main（送信・コピー）と renderer（設定画面のプレビュー）で同じ結果になるよう、ここだけで組み立てる。
 *
 * 使える変数:
 *   {{path}}    … feedback.md の絶対パス（ターミナルで cd していても読める）
 *   {{relpath}} … feedback.md の相対パス（プロジェクトフォルダから）
 *   {{decisionCheck}} … 判定モデルでの受け入れ確認の1文（設定の「判定モデル」が有効なときだけ。無効なら空）。
 *                       書かなければ、有効なときは文末に足す
 *   {{threshold}} … 合格のしきい値（設定の decision.passThreshold、既定 0.7）
 *   {{progress}} … 進み具合を書く progress.json のパス（feedback.md と同じフォルダ。@shared/findingProgress）。
 *                  既定文はこれを使って、指摘ごとに in_progress / human_review を書かせる。利用者の文に無くても feedback.md の「進み具合」の節で伝わる
 * キーなどの秘密は指示文に入れない（判定モデルの URL・モデルは環境変数で Agent に渡る。src/main/decision/）
 */

/**
 * 既定文。パスは空白を含みうるので引用符で囲む（従来の送信文と同じ形）。
 * 画面の言語に合わせる（辞書の agentPrompt.default）。利用者が書き換えた文はそのまま使う
 */
export function defaultAgentPrompt(locale: SupportedLocale = getLocale()): string {
  return translate(locale, 'agentPrompt.default')
}

interface AgentPromptTarget {
  /** レビューのフォルダ（プロジェクトからの相対。例: .ferret/reviews/20261003-101500） */
  relativeDir: string
  /** feedback.md の絶対パス。分からない呼び出し元では省略でき、そのときは相対パスで代える */
  feedbackMd?: string
  /**
   * デザイン・設計書の確認先で撮った指摘を含むか（@shared/reviewTarget の purpose）。
   * true なら「コードではなくデザイン・文書を直す」1文を文末に足す（利用者が書き換えた文でも足す）
   */
  nonCode?: boolean
  /**
   * 参考に見た外部サイト（競合・お手本。区分 reference）で撮った指摘を含むか。
   * true なら「そのサイトは直さず、自分のアプリに取り入れるか避けるかを決める」1文を文末に足す（利用者が書き換えた文でも足す）
   */
  reference?: boolean
  /**
   * 引き継ぎのファイル（プロジェクトの .ferret/handoff.md の絶対パス）。渡すと「区切りごと・上限が近づいたら更新する」1文を
   * 文末に足す（利用者が書き換えた文でも足す）。上限での自動切り替え（src/main/failover）が次の Agent に読ませる
   */
  handoff?: string
}

/** 判定モデルでの受け入れ確認（有効なときだけ渡す） */
interface AgentPromptDecision {
  /** 合格のしきい値（P(done)） */
  threshold: number
}

export function renderAgentPrompt(target: AgentPromptTarget, template?: string | null, locale?: SupportedLocale, decision?: AgentPromptDecision | null): string {
  const relpath = `${target.relativeDir.replace(/\/+$/, '')}/feedback.md`
  const path = target.feedbackMd ?? relpath
  let body = template?.trim() ? template.trim() : defaultAgentPrompt(locale)
  const check = decision ? translate(locale ?? getLocale(), 'agentPrompt.decisionCheck') : ''
  if (body.includes('{{decisionCheck}}')) body = body.replace(/\{\{decisionCheck\}\}/g, check).replace(/[ \t]+$/gm, '').trim()
  else if (check) body = `${body} ${check}`
  if (target.nonCode) body = `${body} ${translate(locale ?? getLocale(), 'agentPrompt.nonCode')}`
  if (target.reference) body = `${body} ${translate(locale ?? getLocale(), 'agentPrompt.reference')}`
  if (target.handoff) body = `${body} ${translate(locale ?? getLocale(), 'agentPrompt.handoff', { handoff: target.handoff })}`
  const threshold = String(decision?.threshold ?? 0.7)
  const progress = path.replace(/feedback\.md$/, 'progress.json')
  return body.replace(/\{\{path\}\}/g, path).replace(/\{\{relpath\}\}/g, relpath).replace(/\{\{threshold\}\}/g, threshold).replace(/\{\{progress\}\}/g, progress)
}

/** 人のコメント（NG・Comment）の1件の長さの上限。ターミナルへ1回で書き込める長さに収める（agent/sanitize.ts の fitsSingleWrite） */
export const REPLY_MAX = 1200

/** まとめて送るときのコメントの合計の上限（文面の残りの分を空けて、送信の上限 20,000 字に収める） */
export const NG_TOTAL_MAX = 15_000

/** 人が NG を付けた指摘（Findings の確認で、コメントが必須） */
interface AgentNg {
  n: number
  id: string
  comment: string
}

/**
 * 「NG をまとめて送る」（と1件だけ送る操作）で Agent へ送る1行。NG の指摘の番号・ID・コメントだけを載せ、
 * それぞれを直して AFTER を撮り直し、human_review に戻させる（並列で進めてよい）。
 * コメントの改行は空白にまとめ、1件ごとに REPLY_MAX で切る（ターミナルへ1回で書き込める長さに収める）
 */
export function renderNgPrompt(target: AgentPromptTarget, items: readonly AgentNg[], locale?: SupportedLocale, decision?: AgentPromptDecision | null): string {
  const lang = locale ?? getLocale()
  const path = target.feedbackMd ?? `${target.relativeDir.replace(/\/+$/, '')}/feedback.md`
  // 件数が多くても送信の上限（@shared/sendTarget の MAX_SEND_TEXT）に収まるよう、1件の長さを割り当てる
  const cap = Math.min(REPLY_MAX, Math.floor(NG_TOTAL_MAX / Math.max(1, items.length)))
  const list = items.map((it) => translate(lang, 'agentPrompt.ngItem', { n: it.n, id: it.id, comment: it.comment.replace(/\s+/g, ' ').trim().slice(0, cap) }))
    .join(translate(lang, 'agentPrompt.ngSeparator'))
  const body = translate(lang, 'agentPrompt.ngBatch', { count: items.length, items: list, path, progress: path.replace(/feedback\.md$/, 'progress.json') })
  return decision ? `${body}${translate(lang, 'agentPrompt.ngDecision')}` : body
}
