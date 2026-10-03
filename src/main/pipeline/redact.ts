import { t } from '@shared/i18n'
/**
 * 出力の安全性（要件 NF-14）。
 *
 * `feedback.md` には画面から取った文字列（URL・要素のテキスト・ページタイトル）が入る。
 * そこに含まれうる秘密を、**出力の直前に**伏せる。
 *
 * 方針:
 * - URL は「パラメータ名は残し、値だけ伏せる」。何のパラメータが付いていたかは
 *   Agentが状況を理解する手がかりになるため、名前は消さない。
 * - 伏せるかどうかは「名前が怪しい」か「値が秘密に見える」かのどちらかで決める。
 *   名前だけで判断すると `?t=<JWT>` のような短い名前を見逃す。
 * - パスの一部（`/reset/abc123…`）は、IDとトークンを機械的に区別できないので伏せない。
 *   ただし JWT は形が一意なので、URLのどこにあっても伏せる。
 */

/** 値を伏せたことが分かる置き換え文字列 */
/** 伏せ字の目印。feedback.md に入るので画面の言語に合わせる */
export function redactedMark(): string {
  return t('feedbackMd.redacted')
}

/**
 * URL を組み立て直す間だけ使う目印。
 * 伏せ字の目印をそのまま入れると `URLSearchParams` が %エンコードしてしまうため、
 * ASCIIだけの目印を通し、最後に目印へ戻す。
 */
const SENTINEL = 'ADE-REDACTED-VALUE'

/** 名前が怪しいパラメータ */
const SENSITIVE_KEY =
  /(^|[_\-.])(token|access[_-]?token|id[_-]?token|refresh[_-]?token|auth|authorization|bearer|key|api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|pwd|pass|session|sessionid|sid|jsessionid|phpsessid|signature|sig|hmac|credential|cred|otp|code|state|nonce|jwt|assertion|ticket|saml|sso)($|[_\-.])/i

/**
 * JWT（3つの base64url をドットで繋いだ形）。URLのどこにあっても伏せる。
 * `.test()` と `.replace()` で `lastIndex` を共有しないよう、判定用と置換用を分ける。
 */
const JWT_SOURCE = String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b`
const JWT_TEST = new RegExp(JWT_SOURCE)
const JWT_ALL = new RegExp(JWT_SOURCE, 'g')

/**
 * 名前が怪しくても、これに当てはまる値は伏せない。
 * `token_type=bearer` のような、秘密ではない付随情報を消すと手がかりが減るだけなので残す。
 */
const HARMLESS_VALUE = /^[A-Za-z]{1,7}$/

/** 値そのものが秘密に見えるか（長い16進・base64url・一般的な鍵の前置き） */
function looksSecret(value: string): boolean {
  const v = value.trim()
  if (v.length < 16) return false
  if (/^[0-9a-f]{32,}$/i.test(v)) return true // 16進のハッシュ・セッションID
  if (/^[A-Za-z0-9_-]{24,}$/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v)) return true
  if (/^(sk|pk|rk|ghp|gho|ghs|xox[bpsar]|AKIA|ASIA|AIza)[-_A-Za-z0-9]{10,}/.test(v)) return true
  if (JWT_TEST.test(v)) return true
  return false
}

/** パラメータ1つを伏せるか */
function shouldRedact(key: string, value: string): boolean {
  if (value.length === 0) return false
  if (looksSecret(value)) return true
  return SENSITIVE_KEY.test(key) && !HARMLESS_VALUE.test(value)
}

/**
 * URL の秘密を伏せる。
 * URLとして解釈できない文字列は、JWTだけ伏せてそのまま返す。
 */
export function redactUrl(raw: string): string {
  if (!raw) return raw
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    // URL として読めない文字列（想定内）。JWT だけ伏せる
    return raw.replace(JWT_ALL, redactedMark())
  }

  // user:pass@host のパスワード
  if (url.password) url.password = '***'

  // パスに紛れた JWT。IDとの区別がつかない一般の値は伏せない（名前が無く判断材料がないため）
  if (JWT_TEST.test(url.pathname)) url.pathname = url.pathname.replace(JWT_ALL, SENTINEL)

  for (const key of [...url.searchParams.keys()]) {
    const values = url.searchParams.getAll(key)
    const redacted = values.map((v) => (shouldRedact(key, v) ? SENTINEL : v))
    if (redacted.some((v, i) => v !== values[i])) {
      url.searchParams.delete(key)
      for (const v of redacted) url.searchParams.append(key, v)
    }
  }

  // フラグメント。`#access_token=…&state=…` の形も、ただの秘密文字列も扱う
  if (url.hash.length > 1) {
    const body = url.hash.slice(1)
    if (body.includes('=')) {
      const params = new URLSearchParams(body)
      let changed = false
      for (const key of [...params.keys()]) {
        const v = params.get(key) ?? ''
        if (shouldRedact(key, v)) {
          params.set(key, SENTINEL)
          changed = true
        }
      }
      if (changed) url.hash = `#${params.toString()}`
    } else if (looksSecret(body)) {
      url.hash = `#${SENTINEL}`
    }
  }

  return url.toString().split(SENTINEL).join(redactedMark())
}

/** 画面から取った表示テキスト。パスワード欄などの入力値は出力しない */
export function redactElementText(
  text: string | undefined,
  options: { sensitive?: boolean; selector?: string } = {}
): string | undefined {
  if (text === undefined) return undefined
  // 注入スクリプトが「入力欄の値である」と印を付けていれば、中身は出さない
  if (options.sensitive) return undefined
  // 印が無い場合の保険: セレクタからパスワード欄らしさを見る
  if (options.selector && /password|passwd|\bpwd\b|type=["']?password/i.test(options.selector)) {
    return undefined
  }
  return text.replace(JWT_ALL, redactedMark())
}

/** ページタイトルなど、画面由来のそのほかの文字列 */
export function redactText(text: string): string {
  return text.replace(JWT_ALL, redactedMark())
}
