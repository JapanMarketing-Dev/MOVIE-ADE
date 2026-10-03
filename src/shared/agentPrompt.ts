import { getLocale, translate, type SupportedLocale } from './i18n'

/**
 * Agentへ渡す1行の指示（「Agentへ送信」「Agent向けにコピー」）。
 * 文面は設定（Settings.agentPrompt）で変えられ、空なら既定文を使う。
 * main（送信・コピー）と renderer（設定画面のプレビュー）で同じ結果になるよう、ここだけで組み立てる。
 *
 * 使える変数:
 *   {{path}}    … feedback.md の絶対パス（ターミナルで cd していても読める）
 *   {{relpath}} … feedback.md の相対パス（プロジェクトフォルダから）
 */

/**
 * 既定文。パスは空白を含みうるので引用符で囲む（従来の送信文と同じ形）。
 * 画面の言語に合わせる（辞書の agentPrompt.default）。利用者が書き換えた文はそのまま使う
 */
export function defaultAgentPrompt(locale: SupportedLocale = getLocale()): string {
  return translate(locale, 'agentPrompt.default')
}

export interface AgentPromptTarget {
  /** レビューのフォルダ（プロジェクトからの相対。例: .ade-movie/reviews/20261003-101500） */
  relativeDir: string
  /** feedback.md の絶対パス。分からない呼び出し元では省略でき、そのときは相対パスで代える */
  feedbackMd?: string
}

export function renderAgentPrompt(target: AgentPromptTarget, template?: string | null, locale?: SupportedLocale): string {
  const relpath = `${target.relativeDir.replace(/\/+$/, '')}/feedback.md`
  const path = target.feedbackMd ?? relpath
  const body = template?.trim() ? template.trim() : defaultAgentPrompt(locale)
  return body.replace(/\{\{path\}\}/g, path).replace(/\{\{relpath\}\}/g, relpath)
}
