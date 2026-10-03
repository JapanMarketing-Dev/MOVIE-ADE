import { pageKey } from './page'
import { previewPathFromUrl, previewUrl } from './preview'
import { targetAction } from './projectTargets'
import { matchPresetUrl } from './projectUrl'
import type { ProjectKind, ProjectUrl } from './types'

/**
 * レビューの対象（URL・ファイル）。1本の録画の中で対象を切り替えながらレビューするための純粋な処理。
 *
 * - フィードバックモードの右パネルに並べる候補（登録URL・開いているファイル・最近のURL）を組み立てる
 * - 内蔵ブラウザがいまどの候補を出しているかを判定する
 * - 停止後の指摘と feedback.md を、対象ごとにまとめる
 *
 * 対象は「ページ」の単位（page.ts の pageKey。ハッシュのアンカーは同じ対象）。
 * ファイルは ade-preview:// のプレビューで内蔵ブラウザに出し、指摘ではプロジェクトからの相対パスで示す。
 */

export type ReviewTargetKind = 'url' | 'file' | 'none'

/** 指摘の対象（停止後のまとめ・feedback.md の節） */
export interface ReviewTarget {
  /** まとめるときの鍵。同じページなら同じ */
  key: string
  kind: ReviewTargetKind
  url?: string
  /** ファイルならプロジェクトからの相対パス */
  path?: string
  /** URL なら登録URLのラベル（local / dev / prd など）。当たらなければ無い */
  label?: string
  /** 見出しに出す短い名前（ファイルは相対パス、URL はホストより後ろ） */
  name: string
  /** URL のホスト（ポート込み） */
  host?: string
}

/** 指摘の URL から対象を決める。URL が無ければ「対象なし」（画面全体の録画など） */
export function targetOfUrl(url: string | undefined, presets: readonly ProjectUrl[] = []): ReviewTarget {
  if (!url) return { key: 'none', kind: 'none', name: '' }
  const path = previewPathFromUrl(url)
  if (path) return { key: `file:${path}`, kind: 'file', url, path, name: path }
  let parsed: URL | null = null
  try {
    parsed = new URL(url)
  } catch {
    parsed = null
  }
  const preset = matchPresetUrl([...presets], url)
  const name = parsed ? `${parsed.pathname}${parsed.search}` || '/' : url
  return {
    key: `url:${pageKey(url)}`,
    kind: 'url',
    url,
    name,
    ...(parsed?.host ? { host: parsed.host } : {}),
    ...(preset ? { label: preset.label } : {})
  }
}

/** 見出し1行（例「dev · example.com/pricing」「docs/a.md」） */
export function targetHeading(target: ReviewTarget): string {
  if (target.kind === 'file') return target.name
  if (target.kind === 'none') return ''
  const where = `${target.host ?? ''}${target.name === '/' ? '' : target.name}` || target.name
  return target.label ? `${target.label} · ${where}` : where
}

/**
 * 指摘を対象ごとにまとめる。対象の並びは最初に出てきた順、中の並びは元の順のまま。
 */
export function groupByTarget<T>(
  items: readonly T[],
  urlOf: (item: T) => string | undefined,
  presets: readonly ProjectUrl[] = []
): Array<{ target: ReviewTarget; items: T[] }> {
  const groups = new Map<string, { target: ReviewTarget; items: T[] }>()
  for (const item of items) {
    const target = targetOfUrl(urlOf(item), presets)
    const group = groups.get(target.key)
    if (group) group.items.push(item)
    else groups.set(target.key, { target, items: [item] })
  }
  return [...groups.values()]
}

// ───────────────────────── 右パネルの候補 ─────────────────────────

export type TargetEntryGroup = 'preset' | 'file' | 'recent'

export interface TargetEntry {
  /** 一覧の中で一意（ページの鍵か、ウインドウの確認先なら target:<id>） */
  id: string
  /**
   * window … URL を持たない（または起動コマンド・ウインドウを持つ）確認先。
   * 押したときの動きは projectTargets.ts の targetAction に従う（ツールバーの確認先と同じ）
   */
  kind: 'url' | 'file' | 'window'
  group: TargetEntryGroup
  /** 1行目 */
  title: string
  /** 2行目（URL・相対パス） */
  detail: string
  /** 登録URLのラベル（local / dev / prd） */
  label?: string
  /** 内蔵ブラウザで開く URL（ファイルは ade-preview:// のプレビュー） */
  url?: string
  /** ファイルなら相対パス */
  path?: string
  /** window の確認先：ターミナルで走らせる起動コマンド */
  launchCommand?: string
  /** window の確認先：録画の対象に選ぶウインドウの名前 */
  windowMatch?: string
}

export interface TargetEntryInput {
  /** 今のプロジェクトの確認先（URL・起動コマンド・ウインドウ） */
  presets: readonly ProjectUrl[]
  /** プロジェクトの種類。確認先のどの欄を使うかが変わる（未設定は web） */
  projectKind?: ProjectKind
  /** エディタで開いているファイルと、パネルに足したファイル（相対パス） */
  files: readonly string[]
  /** 最近開いた URL（新しい順） */
  recent: readonly string[]
  /** 内蔵ブラウザがいま出している URL（まだどの候補にも無ければ最近の先頭に足す） */
  currentUrl?: string
}

/**
 * ファイルの候補。ade-preview:// は md / Mermaid を描き、それ以外のテキストは読み取り専用のコードとして出す
 * （バイナリ・大きすぎるファイルは理由の文だけ）。どのファイルも内蔵ブラウザで開いて録画できる。
 */
function fileEntry(path: string): TargetEntry {
  const url = previewUrl(path)
  const name = path.slice(path.lastIndexOf('/') + 1)
  return { id: pageKey(url), kind: 'file', group: 'file', title: name, detail: path, path, url }
}

function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** 右パネルに並べる候補。登録URL → ファイル → 最近のURL の順で、同じページは1つにまとめる */
export function buildTargetEntries(input: TargetEntryInput): TargetEntry[] {
  const out: TargetEntry[] = []
  const seen = new Set<string>()
  const push = (entry: TargetEntry) => {
    if (seen.has(entry.id)) return
    seen.add(entry.id)
    out.push(entry)
  }
  for (const preset of input.presets) {
    // 押したときの動きはツールバーの確認先と同じ（targetAction）。何もできない確認先は出さない
    const action = targetAction(preset, input.projectKind)
    if (action.kind === 'url') {
      if (!isWebUrl(action.url)) continue
      push({ id: pageKey(action.url), kind: 'url', group: 'preset', title: preset.label || action.url, detail: action.url, label: preset.label, url: action.url })
    } else if (action.kind === 'window') {
      push({
        id: `target:${preset.id}`,
        kind: 'window',
        group: 'preset',
        title: preset.label,
        detail: [action.windowMatch, action.launchCommand, action.url].filter(Boolean).join(' · '),
        label: preset.label,
        ...(action.url ? { url: action.url } : {}),
        ...(action.launchCommand ? { launchCommand: action.launchCommand } : {}),
        ...(action.windowMatch ? { windowMatch: action.windowMatch } : {})
      })
    }
  }
  for (const path of input.files) push(fileEntry(path))
  const recent = input.currentUrl ? [input.currentUrl, ...input.recent] : [...input.recent]
  for (const url of recent) {
    const path = previewPathFromUrl(url)
    if (path) {
      push(fileEntry(path))
      continue
    }
    if (!isWebUrl(url)) continue
    const preset = matchPresetUrl([...input.presets], url)
    let title = url
    try {
      const parsed = new URL(url)
      title = `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
    } catch {
      // URL として読めないものはそのまま
    }
    push({ id: pageKey(url), kind: 'url', group: 'recent', title, detail: url, url, ...(preset ? { label: preset.label } : {}) })
  }
  return out
}

/** 検索欄の語で絞る（空白で区切った語をすべて含むもの。大文字小文字は問わない） */
export function filterTargetEntries(entries: readonly TargetEntry[], query: string): TargetEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return [...entries]
  return entries.filter((entry) => {
    const text = [entry.title, entry.detail, entry.label].filter(Boolean).join('\n').toLowerCase()
    return terms.every((term) => text.includes(term))
  })
}

/** 内蔵ブラウザがいまこの候補を出しているか（同じページか） */
export function isCurrentEntry(entry: TargetEntry, currentUrl: string | undefined): boolean {
  return !!entry.url && !!currentUrl && pageKey(entry.url) === pageKey(currentUrl)
}

/** ↑↓ で選びを動かす。端では止める。候補が無ければ -1 */
export function moveSelection(index: number, delta: number, length: number): number {
  if (length <= 0) return -1
  if (index < 0) return delta > 0 ? 0 : length - 1
  return Math.max(0, Math.min(length - 1, index + delta))
}

/** 最近開いた URL を更新する（先頭に足し、同じページは1つにし、上限で切る） */
export function pushRecentUrl(recent: readonly string[], url: string, max = 8): string[] {
  if (!url || url === 'about:blank') return [...recent]
  const key = pageKey(url)
  return [url, ...recent.filter((u) => pageKey(u) !== key)].slice(0, max)
}

// ───────────────────────── 右パネル：確認先ごとの URL ツリー ─────────────────────────

/** 確認先の下に並べるページ（見たことのある URL をパスで木にしたもの。表示の順に平らにしてある） */
export interface UrlTreeNode {
  /** 一覧の中で一意（確認先の ID ＋パス） */
  key: string
  /** 行に出す名前（パスの最後の区切り。クエリがあれば付ける） */
  name: string
  /** オリジンより後ろ（/docs/setup?tab=a） */
  path: string
  /** 押したときに開く URL。見たことのある URL ならそれ、途中の階層ならオリジン＋パス */
  url: string
  /** 確認先の下で何段目か（0 が一番上） */
  depth: number
  /** 実際に開いたことのあるページか（途中の階層だけのものは false） */
  visited: boolean
}

export interface UrlTreeGroup {
  /** 確認先の ID。登録の無いオリジンは other:<origin> */
  id: string
  label: string
  /** 確認先の URL（登録の無いオリジンはオリジン） */
  url: string
  /** 登録した確認先か（false なら、見たことのある登録外のオリジン） */
  registered: boolean
  nodes: UrlTreeNode[]
}

interface Trie {
  name: string
  path: string
  url?: string
  children: Map<string, Trie>
}

/** 1つの確認先の下に並べるページの上限（履歴が多くても一覧を重くしない） */
const MAX_NODES_PER_GROUP = 200

/**
 * 確認先（URL を持つもの）ごとに、閲覧履歴のページをパスの木にする。
 * どの確認先にも当たらない URL は、オリジンごとの「登録外」のまとまりにする（後ろに並べる）。
 * 確認先そのもののページ（登録した URL と同じパス）は確認先の行が開くので、木には入れない。
 */
/**
 * 閲覧履歴を、URL の文字列の配列に直す。
 * localStorage の値は壊れていたり古い形だったりするし、HMR の途中では渡されないこともあるので、何が来ても配列にする。
 * JSON の文字列（保存した値そのもの）も受け取る。文字列でない要素・空の要素は捨て、上限で切る。
 */
export function sanitizeUrlHistory(raw: unknown, max = 200): string[] {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return []
    }
  }
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).slice(0, max)
}

export function buildUrlTree(
  presets: readonly ProjectUrl[],
  rawHistory: unknown,
  projectKind?: ProjectKind
): UrlTreeGroup[] {
  const history = sanitizeUrlHistory(rawHistory)
  const groups: Array<UrlTreeGroup & { trie: Trie; base: string }> = []
  const urlPresets: ProjectUrl[] = []
  for (const preset of presets) {
    const action = targetAction(preset, projectKind)
    const url = action.kind === 'url' ? action.url : action.kind === 'window' ? action.url : undefined
    if (!url || !isWebUrl(url)) continue
    urlPresets.push({ ...preset, url })
    groups.push({ id: preset.id, label: preset.label || url, url, registered: true, nodes: [], trie: newTrie(), base: basePath(url) })
  }
  for (const raw of history) {
    if (!isWebUrl(raw)) continue
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      continue
    }
    const preset = matchPresetUrl(urlPresets, raw)
    let group = preset ? groups.find((g) => g.id === preset.id) : groups.find((g) => !g.registered && g.url === parsed.origin)
    if (!group) {
      group = { id: `other:${parsed.origin}`, label: parsed.host, url: parsed.origin, registered: false, nodes: [], trie: newTrie(), base: '/' }
      groups.push(group)
    }
    // 確認先そのもののページは、確認先の行で開ける
    if (trimSlash(parsed.pathname) === group.base && !parsed.search) continue
    insert(group.trie, parsed.pathname, parsed.search, raw)
  }
  return groups
    .map(({ trie, base: _base, ...group }) => ({ ...group, nodes: flatten(trie, group.id).slice(0, MAX_NODES_PER_GROUP) }))
    // 登録外のまとまりは、見たページがあるときだけ出す
    .filter((group) => group.registered || group.nodes.length > 0)
}

function newTrie(): Trie {
  return { name: '', path: '', children: new Map() }
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

function basePath(url: string): string {
  try {
    return trimSlash(new URL(url).pathname)
  } catch {
    return '/'
  }
}

function insert(trie: Trie, pathname: string, search: string, url: string): void {
  const segments = pathname.split('/').filter(Boolean)
  let node = trie
  let prefix = ''
  segments.forEach((segment, i) => {
    prefix += `/${segment}`
    const last = i === segments.length - 1
    // クエリ違いは同じ階層の別の行にする（/list?page=2）
    const key = last && search ? `${segment}${search}` : segment
    let child = node.children.get(key)
    if (!child) {
      child = { name: key, path: last ? `${prefix}${search}` : prefix, url: undefined, children: new Map() }
      node.children.set(key, child)
    }
    if (last) child.url = url
    node = child
  })
  if (segments.length === 0 && search) {
    // ルートのクエリ違い（/?tab=a）
    const key = `/${search}`
    if (!trie.children.has(key)) trie.children.set(key, { name: key, path: `/${search}`, url, children: new Map() })
  }
}

function flatten(trie: Trie, groupId: string): UrlTreeNode[] {
  const out: UrlTreeNode[] = []
  const walk = (node: Trie, depth: number, origin: string) => {
    for (const child of [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({
        key: `${groupId}:${child.path}`,
        name: child.name,
        path: child.path,
        url: child.url ?? `${origin}${child.path}`,
        depth,
        visited: child.url !== undefined
      })
      walk(child, depth + 1, origin)
    }
  }
  // 途中の階層の URL を作るため、どれか1つの訪問済み URL からオリジンを取る
  const anyUrl = findUrl(trie)
  let origin = ''
  try {
    origin = anyUrl ? new URL(anyUrl).origin : ''
  } catch {
    origin = ''
  }
  walk(trie, 0, origin)
  return out
}

function findUrl(node: Trie): string | undefined {
  if (node.url) return node.url
  for (const child of node.children.values()) {
    const found = findUrl(child)
    if (found) return found
  }
  return undefined
}

// ───────────────────────── 右パネル：まとめた検索 ─────────────────────────

/** ファイルを押したときに開く対象（md / Mermaid はプレビュー、それ以外のテキストは読み取り専用のコード） */
export function fileTargetEntry(path: string): TargetEntry {
  return fileEntry(path)
}
