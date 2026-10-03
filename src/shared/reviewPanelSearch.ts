import { quickOpenMatchIndices, rankQuickOpenFiles, QUICK_OPEN_RESULT_LIMIT } from './quickOpen'

/**
 * フィードバックの右パネルの検索欄（1つ）で、確認先・URL ツリー・ファイルをまとめて探す。
 * 一致のさせ方と並べ方は ⌘P と同じ（quickOpen.ts のあいまい一致）。強調表示のため一致した文字の位置も返す。
 */

export interface PanelSearchSource {
  id: string
  kind: 'target' | 'url' | 'file'
  /** 探す文字列（確認先は「名前 URL」、ページは「確認先の名前 パス」、ファイルは相対パス） */
  text: string
}

export interface PanelSearchHit extends PanelSearchSource {
  /** text の中で一致した文字の位置 */
  indices: number[]
}

/** 確認先・ページを先に、ファイルを後に並べる（それぞれの中は良い順）。空の問い合わせなら何も返さない */
export function searchReviewPanel(
  query: string,
  sources: readonly PanelSearchSource[],
  files: readonly string[],
  limit = QUICK_OPEN_RESULT_LIMIT
): PanelSearchHit[] {
  if (!query.trim()) return []
  const byText = new Map<string, PanelSearchSource[]>()
  for (const source of sources) byText.set(source.text, [...(byText.get(source.text) ?? []), source])
  const urlHits = rankQuickOpenFiles(query, [...byText.keys()], limit)
    .flatMap(({ path }) => byText.get(path) ?? [])
    .map((source) => ({ ...source, indices: quickOpenMatchIndices(query, source.text) }))
  const fileHits = rankQuickOpenFiles(query, files, limit)
    .map(({ path }) => ({ id: `file:${path}`, kind: 'file' as const, text: path, indices: quickOpenMatchIndices(query, path) }))
  return [...urlHits, ...fileHits]
}

/** 強調表示のために、文字列を一致した部分とそれ以外に切り分ける */
export function splitHighlight(text: string, indices: readonly number[]): Array<{ text: string; hit: boolean }> {
  const marks = new Set(indices)
  const out: Array<{ text: string; hit: boolean }> = []
  for (let i = 0; i < text.length; i++) {
    const hit = marks.has(i)
    const last = out[out.length - 1]
    if (last && last.hit === hit) last.text += text[i]
    else out.push({ text: text[i]!, hit })
  }
  return out
}
