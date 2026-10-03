/**
 * アプリのバージョン比較と、更新確認の結果の形。
 * main（GitHub Releases を見る）と renderer（フッターに出す）の両方から使う。
 */

/** 更新確認の結果。dev 起動でも同じ形で返し、自動更新はしない */
export type UpdateCheckResult =
  | { state: 'latest'; current: string; latest: string }
  | { state: 'available'; current: string; latest: string; url: string }
  /** package.json に配布元（GitHub のリポジトリ）が書かれていない */
  | { state: 'no-source'; current: string }
  /** 配布元にまだリリースが無い（非公開リポジトリで gh 未ログインのときも同じ） */
  | { state: 'no-release'; current: string }
  | { state: 'error'; current: string; message: string }

// Orca由来: ~/bench/orca/src/shared/app-version.ts（MIT）。parseVersion / compareAppVersions を移植
type ParsedVersion = {
  core: [number, number, number]
  prerelease: string[]
}

function parseVersion(value: string): ParsedVersion | null {
  const normalized = value.trim().replace(/^v/i, '')
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+([0-9A-Za-z-.]+))?$/)
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split('.') ?? []
  }
}

export function isValidAppVersion(value: string): boolean {
  return parseVersion(value) !== null
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) return Number(left) - Number(right)
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left.localeCompare(right)
}

/** left < right なら負、等しければ 0、left > right なら正。読めない値は 0（＝更新ありと誤判定しない） */
export function compareAppVersions(left: string, right: string): number {
  const l = parseVersion(left)
  const r = parseVersion(right)
  if (!l || !r) return 0
  for (let i = 0; i < l.core.length; i += 1) {
    if (l.core[i] !== r.core[i]) return l.core[i] - r.core[i]
  }
  // プレリリース（-beta など）は、同じ番号の正式版より古い
  if (l.prerelease.length === 0 && r.prerelease.length === 0) return 0
  if (l.prerelease.length === 0) return 1
  if (r.prerelease.length === 0) return -1
  for (let i = 0; i < Math.max(l.prerelease.length, r.prerelease.length); i += 1) {
    const lp = l.prerelease[i]
    const rp = r.prerelease[i]
    if (lp === undefined) return -1
    if (rp === undefined) return 1
    const c = compareIdentifiers(lp, rp)
    if (c !== 0) return c
  }
  return 0
}

/**
 * アプリの版を決める。候補を前から見て、読める版番号の最初のものを使う。
 * dev 起動では app.getVersion() が Electron の版（44.x）を返すので、
 * 呼び出し側は package.json の version を先に渡す。どれも読めなければ 0.0.0（＝更新ありとは判定しない側に倒さない）。
 */
export function pickAppVersion(...candidates: Array<string | undefined | null>): string {
  for (const c of candidates) if (typeof c === 'string' && isValidAppVersion(c)) return c.trim().replace(/^v/i, '')
  return '0.0.0'
}

/**
 * package.json の repository（文字列または { url }）から GitHub の owner/repo を取り出す。
 * 書かれていない・GitHub 以外なら null（＝「配布元が未設定」）。
 */
export function githubRepoOf(repository: unknown): string | null {
  const raw = typeof repository === 'string'
    ? repository
    : repository && typeof repository === 'object' && typeof (repository as { url?: unknown }).url === 'string'
      ? (repository as { url: string }).url
      : ''
  const match = raw.match(/^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/) ??
    raw.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
  return match ? `${match[1]}/${match[2]}` : null
}
