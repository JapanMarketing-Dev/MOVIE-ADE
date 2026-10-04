/**
 * ファイルツリー（FileExplorer.tsx）の行をドラッグするときのデータ。
 * ツリーの中に落とせば移動・コピー、ターミナルに落とせばパスの挿入、エディタの領域に落とせば開く。
 * 中身はプロジェクトの根からの相対パス（'/' 区切り）の JSON の配列
 */
export const TREE_DRAG_TYPE = 'application/x-ferret-tree-paths'

/** 一度に受け取る数の上限 */
const MAX_TREE_PATHS = 200

export function hasTreePaths(dataTransfer: DataTransfer | null | undefined): boolean {
  return !!dataTransfer && Array.from(dataTransfer.types ?? []).includes(TREE_DRAG_TYPE)
}

/**
 * drop のときに相対パスを読む（dragover の間は読めない）。形の合わないもの
 * （絶対パス・..・NUL・ドライブ指定）は除く。ツリーのドラッグでなければ null
 */
export function treeDragPaths(dataTransfer: DataTransfer): string[] | null {
  if (!hasTreePaths(dataTransfer)) return null
  return parseTreePaths(dataTransfer.getData(TREE_DRAG_TYPE))
}

export function parseTreePaths(raw: string): string[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    // 壊れたデータ（想定内。何も受けない）
    return []
  }
  if (!Array.isArray(value)) return []
  return value
    .slice(0, MAX_TREE_PATHS)
    .filter((p): p is string => typeof p === 'string' && !p.includes('\0') && !p.startsWith('/') && !p.includes('\\') && !/^[a-zA-Z]:/.test(p) && !p.split('/').includes('..'))
}
