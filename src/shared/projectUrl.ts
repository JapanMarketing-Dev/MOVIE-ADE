import type { ProjectUrl } from './types'

/**
 * プロジェクトのURLプリセット（local / dev / prd）を扱う純粋な関数。
 * main と renderer の両方から使い、単体テストでも読み込めるよう Electron に依存しない。
 */

// Orca由来: ~/bench/orca/src/shared/browser-url.ts の isIpv4Loopback（MIT）
function isIpv4Loopback(hostname: string): boolean {
  const octets = hostname.split('.')
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) return false
  const values = octets.map(Number)
  return values[0] === 127 && values.every((value, index) => value >= 0 && value <= 255 && octets[index] === String(value))
}

// Orca由来: ~/bench/orca/src/shared/browser-url.ts の isEligibleLocalCertificateHost（MIT）
// 証明書の判定は持ち込まず、「手元の開発サーバーか」だけを見る形に縮めた
function isLocalHost(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase()
  const host = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || isIpv4Loopback(host)
}

function parse(url: string): URL | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null
  } catch {
    return null
  }
}

/** 登録できるURLか（http / https だけ。about:blank や file: は登録しない） */
export function isPresetableUrl(url: string): boolean {
  return parse(url) !== null
}

export function isLocalDevUrl(url: string): boolean {
  const parsed = parse(url)
  return parsed !== null && isLocalHost(parsed.hostname)
}

/** 「＋」で登録するときのラベルの既定値。localhost 系は local、ホスト名から dev / stg を推し量る */
export function defaultUrlLabel(url: string): string {
  const parsed = parse(url)
  if (!parsed) return ''
  if (isLocalHost(parsed.hostname)) return 'local'
  const labels = parsed.hostname.toLowerCase().split('.')
  if (labels.some((l) => /^(dev|develop|development)(-|$)/.test(l) || l.endsWith('-dev'))) return 'dev'
  if (labels.some((l) => /^(stg|stage|staging)(-|$)/.test(l) || l.endsWith('-stg') || l.endsWith('-staging'))) return 'stg'
  return 'prd'
}

const trimSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path)

/**
 * 表示中のURLに当たるプリセット。
 * 同じオリジンで、パスがプリセットのパスの下にあるもののうち、いちばん長く一致したものを返す
 * （http://localhost:3000 を登録していれば /dashboard を見ていても local が選ばれる）。
 */
export function matchPresetUrl(urls: ProjectUrl[], current: string): ProjectUrl | null {
  const now = parse(current)
  if (!now) return null
  let best: { preset: ProjectUrl; length: number } | null = null
  for (const preset of urls) {
    // URL を持たない確認先（デスクトップアプリのウインドウなど）は対象外
    if (!preset.url) continue
    const p = parse(preset.url)
    if (!p || p.origin !== now.origin) continue
    const base = trimSlash(p.pathname)
    const path = trimSlash(now.pathname)
    const inside = base === '/' || path === base || path.startsWith(`${base}/`)
    if (inside && (!best || base.length > best.length)) best = { preset, length: base.length }
  }
  return best?.preset ?? null
}

/**
 * プリセットを押したときに開くURL。
 * 別のプリセット（例: local）の下を見ているなら、同じパスのまま押した環境（例: dev）へ切り替える。
 * 押したプリセット自身を見ているとき・どれにも当たらないときは、登録したURLそのものを開く。
 */
export function presetTarget(urls: ProjectUrl[], current: string, target: ProjectUrl & { url: string }): string {
  const from = matchPresetUrl(urls, current)
  if (!from?.url || from.id === target.id) return target.url
  const now = parse(current)
  const fromUrl = parse(from.url)
  const to = parse(target.url)
  if (!now || !fromUrl || !to) return target.url
  const rest = trimSlash(now.pathname).slice(trimSlash(fromUrl.pathname) === '/' ? 0 : trimSlash(fromUrl.pathname).length)
  const base = trimSlash(to.pathname) === '/' ? '' : trimSlash(to.pathname)
  to.pathname = `${base}${rest.startsWith('/') || rest === '' ? rest : `/${rest}`}` || '/'
  to.search = now.search
  to.hash = now.hash
  return to.toString()
}

/**
 * URL欄の入力を正規化する。
 * スキームなしのホスト名・localhost・ポート指定は http:// を補い、
 * それ以外（空白を含む、ドットがない等）は検索ではなくそのまま扱い、エラーにしない。
 * 「localhost:3000/pricing」の「localhost:」はスキームの形にも読めるので、
 * コロンの後ろがポート番号（数字）ならホストとポートとみなす。
 */
export function normalizeUrl(input: string): string {
  const value = input.trim()
  if (value.length === 0) return 'about:blank'
  if (/^[^\s/:]+:\d+(?:[/?#]|$)/.test(value)) return `http://${value}`
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  if (value.startsWith('/')) return `file://${value}`
  return `http://${value}`
}
