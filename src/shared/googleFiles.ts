/**
 * Google ドライブ（パソコン版）が置くショートカット（.gdoc・.gsheet・.gslides など）を、内蔵ブラウザで開く URL にする。
 * 中身は小さな JSON（{"doc_id": "...", "resource_key": "", "email": "..."}。古い版は "url" も持つ）。
 * 内蔵ブラウザで docs.google.com を開くので、そのまま見て編集できる（ログインは内蔵ブラウザの Google）。
 * URL は Google の決まったホストだけにする（ファイルの中の url をそのまま開かない）。
 */

const GOOGLE_KINDS: Record<string, { path: string } | null> = {
  '.gdoc': { path: 'document' },
  '.gsheet': { path: 'spreadsheets' },
  '.gslides': { path: 'presentation' },
  '.gdraw': { path: 'drawings' },
  '.gform': { path: 'forms' },
  // 決まった編集画面の無いもの（マイマップ・サイト・Jamboard・Apps Script）は、ドライブで開く
  '.gmap': null,
  '.gsite': null,
  '.gjam': null,
  '.gscript': null,
  '.gtable': null
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

export function isGoogleFile(path: string): boolean {
  return extensionOf(path) in GOOGLE_KINDS
}

const ID = /^[A-Za-z0-9_-]{10,200}$/
const RESOURCE_KEY = /^[A-Za-z0-9_-]{1,200}$/
const EMAIL = /^[^\s@/?#&]{1,128}@[A-Za-z0-9.-]{1,253}$/
const GOOGLE_HOSTS = new Set(['docs.google.com', 'drive.google.com'])

/** 古い版の "url" から id を取り出す（https://docs.google.com/open?id=… や …/d/<id>/edit） */
function idFromUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || !GOOGLE_HOSTS.has(url.hostname)) return null
  const id = url.searchParams.get('id') ?? /\/d\/([^/]+)/.exec(url.pathname)?.[1] ?? null
  return id && ID.test(id) ? id : null
}

/** ショートカットの中身 → 開く URL。読めない・形の違うものは null */
export function googleFileUrl(path: string, content: string): string | null {
  const ext = extensionOf(path)
  if (!(ext in GOOGLE_KINDS)) return null
  let data: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object') return null
    data = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const id = typeof data.doc_id === 'string' && ID.test(data.doc_id) ? data.doc_id : idFromUrl(data.url)
  if (!id) return null
  const kind = GOOGLE_KINDS[ext]
  const url = kind ? new URL(`https://docs.google.com/${kind.path}/d/${id}/edit`) : new URL(`https://drive.google.com/open?id=${id}`)
  if (typeof data.resource_key === 'string' && RESOURCE_KEY.test(data.resource_key)) url.searchParams.set('resourcekey', data.resource_key)
  // 複数の Google アカウントでログインしていても、そのファイルのアカウントで開く
  if (typeof data.email === 'string' && EMAIL.test(data.email)) url.searchParams.set('authuser', data.email)
  return url.toString()
}
