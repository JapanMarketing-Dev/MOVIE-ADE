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
 *                  既定文はこれを使って、指摘ごとに in_progress / done を書かせる。利用者の文に無くても feedback.md の「進み具合」の節で伝わる
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
  const threshold = String(decision?.threshold ?? 0.7)
  const progress = path.replace(/feedback\.md$/, 'progress.json')
  return body.replace(/\{\{path\}\}/g, path).replace(/\{\{relpath\}\}/g, relpath).replace(/\{\{threshold\}\}/g, threshold).replace(/\{\{progress\}\}/g, progress)
}

/** 返答の長さの上限。ターミナルへ1回で書き込める長さに収める（agent/sanitize.ts の fitsSingleWrite） */
export const REPLY_MAX = 1200

/** Agent が人間へ戻した指摘（progress.json の needs_human）への返答 */
interface AgentReply {
  /** 画面の通し番号（feedback.md の見出しの番号） */
  n: number
  /** 指摘のID（progress.json のキー） */
  id: string
  reply: string
}

/**
 * 「返答を送る」で Agent へ送る1行。その指摘だけを返答つきで進めさせる。
 * 返答の改行は空白にまとめる（貼り付けが複数行の入力にならないように）。文面は設定のテンプレートに依らず固定
 */
export function renderReplyPrompt(target: AgentPromptTarget, reply: AgentReply, locale?: SupportedLocale, decision?: AgentPromptDecision | null): string {
  const lang = locale ?? getLocale()
  const path = target.feedbackMd ?? `${target.relativeDir.replace(/\/+$/, '')}/feedback.md`
  const body = translate(lang, 'agentPrompt.reply', {
    n: reply.n,
    id: reply.id,
    reply: reply.reply.replace(/\s+/g, ' ').trim().slice(0, REPLY_MAX),
    path,
    progress: path.replace(/feedback\.md$/, 'progress.json')
  })
  return decision ? `${body}${translate(lang, 'agentPrompt.replyDecision')}` : body
}

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
