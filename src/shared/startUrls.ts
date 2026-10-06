import { pageKey } from './page'
import { defaultUrlLabel, isPresetableUrl } from './projectUrl'
import { sanitizeUrlHistory } from './reviewTarget'

/**
 * 内蔵ブラウザの開始画面（「レビューする画面を開く」）に並べる候補。画面に依らない部分だけをここに置き、単体テストで確かめる。
 *
 * 1. プロジェクトに登録した URL（ツールバーの local / dev / prd などと同じもの）を、登録した順に
 * 2. 最近開いた URL（プロジェクトごとの閲覧履歴 = renderer/lib/urlHistory.ts。新しい順）。登録した URL と同じページは除く
 * 3. よく使う開発サーバー（localhost:3000 など）は、登録した URL が無いときだけの補助
 * どれも http / https だけ（プレビューの ade-preview: や about:blank は出さない）。同じページ（pageKey）は1つにまとめる。
 */

/** 最近開いた URL を出す件数の上限 */
export const START_RECENT_LIMIT = 6

/** 登録した URL が無いときに出す、よく使う開発サーバー */
export const DEV_URL_FALLBACKS: readonly string[] = ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:8080']

export interface StartUrlChoice {
  /** 登録した名前（無ければ URL から推し量った local / dev / prd） */
  label: string
  url: string
}

export interface StartUrlChoices {
  presets: StartUrlChoice[]
  recent: string[]
  fallback: string[]
}

export function startUrlChoices(input: {
  /** プロジェクトの確認先（project.urls）。URL の無いもの（ウインドウだけ）は出さない */
  targets: ReadonlyArray<{ label?: string; url?: string }>
  /** 閲覧履歴（新しい順）。壊れた値も受け取る */
  history: unknown
  limit?: number
}): StartUrlChoices {
  const seen = new Set<string>()
  const presets: StartUrlChoice[] = []
  for (const target of input.targets) {
    const url = target.url?.trim()
    if (!url || !isPresetableUrl(url)) continue
    const key = pageKey(url)
    if (seen.has(key)) continue
    seen.add(key)
    presets.push({ label: target.label?.trim() || defaultUrlLabel(url), url })
  }

  const limit = Math.max(0, Math.floor(input.limit ?? START_RECENT_LIMIT))
  const recent: string[] = []
  for (const url of sanitizeUrlHistory(input.history)) {
    if (recent.length >= limit) break
    if (!isPresetableUrl(url)) continue
    const key = pageKey(url)
    if (seen.has(key)) continue
    seen.add(key)
    recent.push(url)
  }

  const fallback = presets.length > 0 ? [] : DEV_URL_FALLBACKS.filter((url) => !seen.has(pageKey(url)))
  return { presets, recent, fallback }
}
