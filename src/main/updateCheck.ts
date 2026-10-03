import { app, net } from 'electron'
import { compareAppVersions, isValidAppVersion, pickAppVersion, type UpdateCheckResult } from '@shared/appVersion'
// package.json はビルド時に埋め込む（dev 起動では app.getAppPath() がプロジェクト直下を指さないことがある）
import { version } from '../../package.json'
import { t } from '@shared/i18n'
import { reportHandled } from '@shared/report'
import { SMALL_JSON_MAX_BYTES, readBoundedJson } from './boundedResponse'

/**
 * 更新の確認（フッターの「更新を確認」）。
 *
 * Orca は electron-updater で配布フィードを見て、ダウンロード・再起動まで行う
 * （~/bench/orca/src/main/updater.ts, updater/updater-setup.ts）。
 * このアプリは electron-updater を入れていない（署名・配布フィードも未整備）ので、
 * 配信元（R2）の latest.json と package.json の version を比べて案内するだけにする。
 * dev 起動でも同じで、自動で入れ替えることはしない。
 * latest.json は Cache-Control: max-age=300 で配られ、GitHub API のような回数の上限も認証も要らない。
 */

/** 配信元。独自ドメインへ移すときはここだけ変える（今は r2.dev の開発用 URL） */
export const RELEASE_BASE_URL = 'https://pub-588d93b3e875464f98d6cf98dc711a0c.r2.dev/'
const MANIFEST_URL = new URL('latest.json', RELEASE_BASE_URL).toString()
/** ダウンロードサイト（Workers の静的配信）。空にすると R2 上の自分の OS・CPU 向けファイルを直接開く */
export const DOWNLOAD_PAGE_URL = 'https://ferretade.dev/download'

const TIMEOUT_MS = 8000

/**
 * アプリの版。フッターの表示と更新確認の比較の両方で使う。
 * dev 起動の app.getVersion() は Electron の版を返すので、package.json の version を優先する。
 */
export function appVersion(): string {
  return pickAppVersion(version, app.getVersion())
}

/** latest.json の1ファイル（download-site と合意した形） */
export interface ReleaseFile {
  name: string
  path: string
  size: number
  sha256: string
  os: 'mac' | 'win' | 'linux'
  arch: 'arm64' | 'x64'
  kind: 'dmg' | 'exe' | 'AppImage' | 'deb'
  preview?: true
}

export interface ReleaseManifest {
  schema: 1
  version: string
  date: string
  prerelease: boolean
  notes: string
  notesUrl?: string
  files: ReleaseFile[]
}

const OS_OF: Partial<Record<NodeJS.Platform, ReleaseFile['os']>> = { darwin: 'mac', win32: 'win', linux: 'linux' }
/** Linux は AppImage を先に勧める（どの配布でも動く） */
const KIND_ORDER: ReleaseFile['kind'][] = ['dmg', 'exe', 'AppImage', 'deb']

/** 取得した JSON を確かめる。形が違えば null（単体テストから使うため export） */
export function parseManifest(raw: unknown): ReleaseManifest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<ReleaseManifest>
  if (r.schema !== 1 || typeof r.version !== 'string' || !Array.isArray(r.files)) return null
  const files = r.files.filter((f): f is ReleaseFile =>
    !!f && typeof f === 'object' && typeof f.path === 'string' && typeof f.name === 'string' &&
    (f.os === 'mac' || f.os === 'win' || f.os === 'linux') && (f.arch === 'arm64' || f.arch === 'x64'))
  return {
    schema: 1,
    version: r.version,
    date: typeof r.date === 'string' ? r.date : '',
    prerelease: r.prerelease === true,
    notes: typeof r.notes === 'string' ? r.notes : '',
    ...(typeof r.notesUrl === 'string' ? { notesUrl: r.notesUrl } : {}),
    files
  }
}

/** 自分の OS・CPU に合うファイル。正式版を先に、種類は KIND_ORDER の順で選ぶ */
export function pickReleaseFile(files: readonly ReleaseFile[], platform: NodeJS.Platform, arch: string): ReleaseFile | null {
  const os = OS_OF[platform]
  if (!os) return null
  const candidates = files.filter((f) => f.os === os && f.arch === arch)
  candidates.sort((a, b) => Number(!!a.preview) - Number(!!b.preview) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
  return candidates[0] ?? null
}

/**
 * 版を比べて結果にする。新しい版なら開く先を決める：
 * ダウンロードサイトが決まっていればそこ、無ければ R2 上の自分向けファイル、それも無ければ latest.json の notesUrl。
 */
export function judgeManifest(
  current: string,
  manifest: ReleaseManifest,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  downloadPage: string = DOWNLOAD_PAGE_URL
): UpdateCheckResult {
  const latest = manifest.version.trim().replace(/^v/i, '')
  if (!isValidAppVersion(latest)) return { state: 'error', current, message: t('update.errors.badVersion', { tag: manifest.version }) }
  if (compareAppVersions(latest, current) <= 0) return { state: 'latest', current, latest }
  const file = pickReleaseFile(manifest.files, platform, arch)
  // path に別のサイトの絶対URLが入っていても開かない（配信元の下だけ）
  const fileUrl = file ? new URL(file.path.replace(/^\/+/, ''), RELEASE_BASE_URL).toString() : ''
  const url = downloadPage ||
    (fileUrl.startsWith(RELEASE_BASE_URL) ? fileUrl : '') ||
    (manifest.notesUrl?.startsWith('https://') ? manifest.notesUrl : RELEASE_BASE_URL)
  return { state: 'available', current, latest, url }
}

/**
 * 確認できなかったことを Sentry へ warning（area: update）で知らせる。理由の種類だけを付ける（URL・本文は付けない）。
 * 確認は利用者が押したときだけなので、件数は少ない。オフライン（network / timeout）も、配信元の不調に気づけるよう送る。
 */
function reportCheckFailure(reason: 'http' | 'bad-manifest' | 'bad-version' | 'network' | 'timeout', err?: unknown): void {
  // net の失敗の文（net::ERR_…）は手がかりになるので残す。URL は送る前の除去で落ちる
  reportHandled(err instanceof Error ? err : new Error(`update check failed: ${reason}`), { area: 'update', op: `check update: ${reason}` })
}

export async function checkForUpdate(fetcher: typeof net.fetch = net.fetch): Promise<UpdateCheckResult> {
  const current = appVersion()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetcher(MANIFEST_URL, { headers: { Accept: 'application/json' }, signal: controller.signal })
    // まだ latest.json を置いていない。失敗ではなく案内として出す
    if (res.status === 404 || res.status === 403) return { state: 'no-release', current }
    if (!res.ok) {
      reportCheckFailure('http', new Error(`update check failed: HTTP ${res.status}`))
      return { state: 'error', current, message: t('update.errors.http', { status: res.status }) }
    }
    const manifest = parseManifest(await readBoundedJson(res, SMALL_JSON_MAX_BYTES).catch(() => null))
    if (!manifest) {
      reportCheckFailure('bad-manifest')
      return { state: 'error', current, message: t('update.errors.badManifest') }
    }
    const result = judgeManifest(current, manifest)
    if (result.state === 'error') reportCheckFailure('bad-version')
    return result
  } catch (err) {
    const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
    reportCheckFailure(aborted ? 'timeout' : 'network', err)
    return { state: 'error', current, message: aborted ? t('update.errors.timeout') : t('update.errors.network') }
  } finally {
    clearTimeout(timer)
  }
}
