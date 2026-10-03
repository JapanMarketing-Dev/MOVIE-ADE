/**
 * ファイルツリーの開閉の状態（どのフォルダを開いているか）の保存形式。
 * プロジェクトごとにこの端末へ覚える（renderer の localStorage）。壊れた値は空として読む。
 */

/** 覚えておくフォルダの上限。開きっぱなしが溜まっても読み込みを重くしない */
export const MAX_EXPANDED = 300

export function expandedStorageKey(scope: string, projectId: string): string {
  return `ade.${scope}.expanded.${projectId}`
}

export function parseExpanded(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set()
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return new Set()
    return new Set(value.filter((v): v is string => typeof v === 'string' && v.length > 0 && !v.startsWith('/') && !v.split('/').includes('..')).slice(0, MAX_EXPANDED))
  } catch {
    return new Set()
  }
}

/** 浅い順に並べて上限で切る（親を先に残す） */
export function serializeExpanded(paths: Iterable<string>): string {
  const list = [...new Set(paths)].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)).slice(0, MAX_EXPANDED)
  return JSON.stringify(list)
}
