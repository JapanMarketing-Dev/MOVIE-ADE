/**
 * ⌘P のクイックオープンの絞り込み（純粋関数。IO なし）。
 *
 * Orca由来: src/shared/quick-open-path-search.ts（MIT）
 * 文字を順に拾うあいまい一致で、点数は小さいほど良い。
 *   - 一致した文字の間の飛びを足す
 *   - `/` `.` `-` の直後で一致したら 5 引く（単語の頭）
 *   - ファイル名に問い合わせがそのまま含まれていれば 100 引く
 * Orca のヒープによる上位保持は、件数が数万程度なら並べ替えで十分なので単純にした。
 */

export const QUICK_OPEN_RESULT_LIMIT = 50

interface IndexedFile {
  path: string
  lowerPath: string
  lowerFilename: string
  inputIndex: number
}

export interface QuickOpenResult {
  path: string
  score: number
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/\\/g, '/').toLowerCase()
}

function prepare(path: string, inputIndex: number): IndexedFile {
  const searchPath = path.replace(/\\/g, '/')
  const lastSlash = searchPath.lastIndexOf('/')
  return {
    path,
    lowerPath: searchPath.toLowerCase(),
    lowerFilename: searchPath.slice(lastSlash + 1).toLowerCase(),
    inputIndex
  }
}

/** 一致しなければ -1 */
function fuzzyScore(query: string, file: IndexedFile): number {
  let score = 0
  let lastMatchIdx = -1
  for (let qi = 0; qi < query.length; qi++) {
    const next = lastMatchIdx + 1
    const ti = file.lowerPath[next] === query[qi] ? next : file.lowerPath.indexOf(query[qi]!, next + 1)
    if (ti === -1) return -1
    score += lastMatchIdx === -1 ? 0 : ti - lastMatchIdx - 1
    const before = file.lowerPath[ti - 1]
    if (ti > 0 && (before === '/' || before === '.' || before === '-')) score -= 5
    lastMatchIdx = ti
  }
  if (file.lowerFilename.includes(query)) score -= 100
  return score
}

/** パスを短い方・名前順で並べる（同点のときの順） */
function compareNames(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
}

/**
 * 問い合わせに合うファイルを良い順に返す。空の問い合わせなら先頭から limit 件。
 */
export function rankQuickOpenFiles(
  query: string,
  files: readonly string[],
  limit = QUICK_OPEN_RESULT_LIMIT
): QuickOpenResult[] {
  if (limit <= 0) return []
  const normalized = normalizeQuery(query)
  if (!normalized) return files.slice(0, limit).map((path) => ({ path, score: 0 }))
  const ranked: Array<QuickOpenResult & { inputIndex: number }> = []
  files.forEach((path, index) => {
    const file = prepare(path, index)
    const score = fuzzyScore(normalized, file)
    if (score !== -1) ranked.push({ path, score, inputIndex: index })
  })
  ranked.sort((a, b) => a.score - b.score || compareNames(a.path, b.path) || a.inputIndex - b.inputIndex)
  return ranked.slice(0, limit).map(({ path, score }) => ({ path, score }))
}
