/**
 * 内蔵ブラウザのログイン（Cookie・保存したサイトのデータ）の組。既定はすべてのプロジェクトで1つを共有する
 * （一度ログインすれば、どのプロジェクトでも Gmail・Google・GitHub などにログインしたまま）。
 * クライアントが違うなど分けたいプロジェクトには、設定で組の名前を付ける。同じ名前のプロジェクト同士は共有し、
 * ほかとは分かれる。画面に依存しない純粋な関数だけを置く（main の browser.ts が session の名前に使う）
 */

/** すべてのプロジェクトで共有する組（ログイン状態を残す永続の session） */
export const SHARED_BROWSER_PARTITION = 'persist:ade-browser'

/** 組の名前の長さの上限 */
export const MAX_BROWSER_PROFILE_LENGTH = 40

/** 組の名前を確かめる。空・共有と同じ意味のもの・読めない値は undefined（共有） */
export function sanitizeBrowserProfile(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/\s+/g, ' ').slice(0, MAX_BROWSER_PROFILE_LENGTH).trim()
  return name ? name : undefined
}

/** 大文字小文字・前後の空白の違いは同じ組とみなす */
function profileKey(name: string): string {
  return name.normalize('NFKC').toLowerCase()
}

/** FNV-1a（32bit）を種を変えて2回。組の名前を session の名前（フォルダ名になる）に使える英数字にする */
function hash(text: string, seed: number): string {
  let h = seed >>> 0
  for (const ch of text) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** そのプロジェクトの内蔵ブラウザの session の名前。組が無ければ共有 */
export function browserPartition(profile: string | undefined | null): string {
  const name = sanitizeBrowserProfile(profile)
  if (!name) return SHARED_BROWSER_PARTITION
  const key = profileKey(name)
  return `${SHARED_BROWSER_PARTITION}-${hash(key, 0x811c9dc5)}${hash(key, 0x01000193)}`
}

/** 設定に出す組の一覧（付いている名前を重複なく、名前の順） */
export function browserProfiles(projects: ReadonlyArray<{ browserProfile?: string }>): string[] {
  const byKey = new Map<string, string>()
  for (const p of projects) {
    const name = sanitizeBrowserProfile(p.browserProfile)
    if (name && !byKey.has(profileKey(name))) byKey.set(profileKey(name), name)
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b))
}
