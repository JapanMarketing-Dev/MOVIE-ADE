import { DEFAULT_URL, type Project, type ProjectSession } from './types'

/**
 * プロジェクトごとの作業の状態（内蔵ブラウザの URL・中央のタブ・開いていたファイル・表示中のレビュー）。
 * プロジェクトを切り替えたら前の状態を覚え、戻ってきたら元に戻す。設定に保存するので再起動しても戻る。
 * 保存するのはパスと URL まで。ファイルの中身や戻る・進むの履歴は持たない。
 *
 * main（URL の記録と切り替え時の遷移）と renderer（タブとファイル）の両方から使う純粋な関数だけを置く。
 */

/** 開いていたファイルとして覚える上限（設定ファイルを肥大させない） */
export const MAX_SESSION_FILES = 50

const isText = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/** 相対パスとして安全なものだけ（絶対パス・親へ出るパスは捨てる） */
function isRelativePath(path: string): boolean {
  return !path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path) && !path.split(/[\\/]/).includes('..')
}

/** 設定ファイルから読んだ値を型どおりに直す。中身が何も無ければ undefined */
export function sanitizeProjectSession(raw: unknown): ProjectSession | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Partial<ProjectSession>
  const session: ProjectSession = {}
  if (isText(r.url) && r.url !== DEFAULT_URL) session.url = r.url
  if (isText(r.centerTab)) session.centerTab = r.centerTab
  if (Array.isArray(r.openFiles)) {
    const files = [...new Set(r.openFiles.filter((p): p is string => isText(p) && isRelativePath(p)))].slice(0, MAX_SESSION_FILES)
    if (files.length) session.openFiles = files
  }
  if (isText(r.reviewId, 200)) session.reviewId = r.reviewId
  return Object.keys(session).length ? session : undefined
}

/** id のプロジェクトの状態に patch を重ねる（undefined の項目は消す）。一覧の他は変えない */
export function withProjectSession(projects: Project[], id: string, patch: Partial<ProjectSession>): Project[] {
  return projects.map((project) => {
    if (project.id !== id) return project
    const merged = { ...project.session, ...patch }
    for (const key of Object.keys(merged) as Array<keyof ProjectSession>) if (merged[key] === undefined || merged[key] === null) delete merged[key]
    const session = sanitizeProjectSession(merged)
    const { session: _old, ...rest } = project
    return session ? { ...rest, session } : rest
  })
}

/**
 * プロジェクトを開いたときに内蔵ブラウザで開く URL。
 * 前に開いていた URL → 登録 URL の先頭 → 空の画面 の順。
 */
export function sessionUrl(project: Pick<Project, 'urls' | 'session'>): string {
  return project.session?.url ?? project.urls.find((u) => u.url)?.url ?? DEFAULT_URL
}

/** URL の記録に使ってよいか（空の画面や読み込み途中は覚えない） */
export function isRecordableUrl(url: string | undefined | null): url is string {
  return !!url && url !== DEFAULT_URL
}

/*
 * 中央のタブの選択。ファイルのタブは `file:<プロジェクトの根>/<相対パス>` なので、
 * 根を外した `file:<相対パス>` で覚え、戻すときに今の根を付け直す（フォルダを動かしても戻せる）。
 */
const FILE_PREFIX = 'file:'

export function encodeCenterTab(tab: string, root: string | null): string | undefined {
  if (!tab.startsWith(FILE_PREFIX)) return tab
  if (!root) return undefined
  const base = `${FILE_PREFIX}${root.replace(/[\\/]+$/, '')}/`
  return tab.startsWith(base) ? `${FILE_PREFIX}${tab.slice(base.length)}` : undefined
}

export function decodeCenterTab(saved: string | undefined, root: string | null): string | undefined {
  if (!saved) return undefined
  if (!saved.startsWith(FILE_PREFIX)) return saved
  const rel = saved.slice(FILE_PREFIX.length)
  if (!root || !rel || !isRelativePath(rel)) return undefined
  return `${FILE_PREFIX}${root.replace(/[\\/]+$/, '')}/${rel}`
}
