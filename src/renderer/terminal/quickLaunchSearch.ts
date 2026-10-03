import type { TuiAgent } from '@shared/types'

/**
 * 「＋」メニューの検索欄（純粋関数だけ。QuickLaunchButton と単体テストから使う）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/tab-bar/TabBarCreateEntry.tsx,
 *           ~/bench/orca/src/renderer/src/components/tab-bar/tab-create-entry-classifier.ts,
 *           ~/bench/orca/src/renderer/src/components/tab-bar/tab-create-entry-url-classification.ts（MIT, Copyright 2026 Lovecast Inc.）
 *
 * Orca の「開いているタブ・履歴・ファイル・URL・Agent をまとめて探す」入口から、本システムにある
 * ものだけを抜き出した。履歴（ブラウザの閲覧履歴）は本システムに無いので出さない。
 * ドメインの判定に使う tldts（公開サフィックス一覧）は持ち込まず、ドメインらしい形かどうかだけを見る。
 */


export type QuickLaunchEntry =
  | { kind: 'shell' }
  | { kind: 'agent'; agent: TuiAgent; label: string }
  | { kind: 'settings' }
  | { kind: 'tab'; tabKey: string; title: string }
  | { kind: 'url'; url: string; label: string; project: string }
  /** 入力そのものがURLだったとき */
  | { kind: 'open-url'; url: string }
  | { kind: 'file'; path: string }

export interface QuickLaunchSources {
  /** メニューに出すエージェント（インストール済みか登録したもので、無効にしていないもの） */
  agents: ReadonlyArray<{ id: TuiAgent; label: string }>
  /** 「Agent設定…」を出すか */
  settings: boolean
  tabs: ReadonlyArray<{ key: string; title: string }>
  urls: ReadonlyArray<{ label: string; url: string; project: string }>
  /** fs:search で見つかったファイル（相対パス）。検索できないときは空 */
  files: readonly string[]
}

/** 1種類あたりに出す上限。多すぎると選びにくい */
const MAX_PER_KIND = 8

export function entryId(entry: QuickLaunchEntry): string {
  switch (entry.kind) {
    case 'shell':
    case 'settings':
      return entry.kind
    case 'agent':
      return `agent:${entry.agent}`
    case 'tab':
      return `tab:${entry.tabKey}`
    case 'url':
      return `url:${entry.project}:${entry.url}`
    case 'open-url':
      return `open-url:${entry.url}`
    case 'file':
      return `file:${entry.path}`
  }
}

/** 空白で区切った語が、どれも含まれていれば一致（大文字小文字は区別しない） */
export function matchesQuery(query: string, ...texts: string[]): boolean {
  const haystack = texts.join(' ').toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term))
}

const IPV4_PATTERN =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i
/** ファイル名に見える拡張子。`index.ts` をドメインと取り違えない（Orca の HOST_FILE_EXTENSIONS） */
const HOST_FILE_EXTENSIONS = new Set(['css', 'html', 'js', 'jsx', 'json', 'md', 'py', 'toml', 'ts', 'tsx', 'yaml', 'yml'])

/** LAN・手元の開発サーバーは TLS を使わないことが多いので http にする（Orca と同じ） */
function isPrivateIpv4(host: string): boolean {
  if (!IPV4_PATTERN.test(host)) return false
  const [first = 0, second = 0] = host.split('.').map(Number)
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 169 && second === 254) ||
    (first === 192 && second === 168)
  )
}

/**
 * 入力がURLとして開けるなら、開くURLを返す。
 * http(s):// 付きはそのまま。スキーム無しは localhost・IPv4・ドメインの形のときだけ補う。
 */
export function classifyUrlQuery(input: string): string | null {
  const query = input.trim()
  if (!query || /\s/.test(query)) return null
  if (/^https?:\/\//i.test(query)) {
    try {
      const url = new URL(query)
      return url.hostname ? url.href : null
    } catch {
      return null
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(query)) return null
  const authorityEnd = query.search(/[/?#]/)
  const authority = authorityEnd === -1 ? query : query.slice(0, authorityEnd)
  const colon = authority.indexOf(':')
  const host = colon === -1 ? authority : authority.slice(0, colon)
  const port = colon === -1 ? null : authority.slice(colon + 1)
  if (port !== null && !/^\d+$/.test(port)) return null
  if (HOST_FILE_EXTENSIONS.has(host.split('.').pop()?.toLowerCase() ?? '')) return null
  const local = host.toLowerCase() === 'localhost' || isPrivateIpv4(host)
  if (!local && !IPV4_PATTERN.test(host) && !DOMAIN_PATTERN.test(host)) return null
  try {
    const url = new URL(`${local ? 'http' : 'https'}://${query}`)
    return url.hostname ? url.href : null
  } catch {
    return null
  }
}

// 検索語は画面の言語によらず、英語でも日本語でも当たるようにする（入力欄のプレースホルダは辞書の quickLaunch.placeholder）
const SHELL_KEYWORDS = ['new terminal', '新しいターミナル', 'terminal', 'shell', 'シェル']
const SETTINGS_KEYWORDS = ['agent settings', 'Agent設定', 'settings', '設定']

/**
 * 入力に合う項目を並べる。空のときはメニューの項目（新しいターミナル／Agent／設定）だけ。
 * 並びは「入力したURL → 操作 → 開いているタブ → 登録したURL → ファイル」。
 */
export function buildQuickLaunchEntries(query: string, sources: QuickLaunchSources): QuickLaunchEntry[] {
  const q = query.trim()
  const actions: QuickLaunchEntry[] = [
    { kind: 'shell' },
    ...sources.agents.map((agent): QuickLaunchEntry => ({ kind: 'agent', agent: agent.id, label: agent.label })),
    ...(sources.settings ? [{ kind: 'settings' } as const] : [])
  ]
  if (!q) return actions

  const matchedActions = actions.filter((entry) => {
    if (entry.kind === 'shell') return matchesQuery(q, ...SHELL_KEYWORDS)
    if (entry.kind === 'agent') return matchesQuery(q, entry.label, entry.agent)
    return matchesQuery(q, ...SETTINGS_KEYWORDS)
  })
  const tabs = sources.tabs
    .filter((tab) => matchesQuery(q, tab.title))
    .slice(0, MAX_PER_KIND)
    .map((tab): QuickLaunchEntry => ({ kind: 'tab', tabKey: tab.key, title: tab.title }))
  const typedUrl = classifyUrlQuery(q)
  const urls = sources.urls
    .filter((u) => matchesQuery(q, u.label, u.url, u.project))
    .slice(0, MAX_PER_KIND)
    .map((u): QuickLaunchEntry => ({ kind: 'url', ...u }))
  const files = sources.files.slice(0, MAX_PER_KIND).map((path): QuickLaunchEntry => ({ kind: 'file', path }))

  return [
    ...(typedUrl ? [{ kind: 'open-url', url: typedUrl } as const] : []),
    ...matchedActions,
    ...tabs,
    ...urls,
    ...files
  ]
}
