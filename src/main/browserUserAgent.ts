/**
 * 内蔵ブラウザの User-Agent（純粋な関数とクラス。単体テストの対象）。
 *
 * Electron の既定の UA には「ferret/0.4.0 Electron/44.x」が入り、Google などのログインが
 * 「安全でないブラウザ」として断る（Orca #6711 #10468 #18562。2026-10-07 も Google は Electron の UA を簡易版のログイン WebLiteSignIn に落とした）。
 * そこで既定は Chrome と同じ形（cleanElectronUserAgent）にする。
 *
 * ただし Cloudflare の人間チェック（managed challenge / Turnstile）は、Chrome を名乗るのに Client Hints の
 * ブランドが Chromium だけの UA を通さない（チェックしても同じ確認の画面に戻り続ける）。
 * Electron の印を残した UA なら自動で通る（2026-10-07 に nyusatsu-open.ai で確認）。
 * そこで、Cloudflare の確認を返したホスト（応答の cf-mitigated: challenge）だけは、以後 Electron の印を残した UA で開き、
 * その場で1回だけ読み直す（BrowserIdentity）。ページの JS から見える navigator.userAgent と、送るヘッダーの UA は同じにする
 * （食い違うと、それ自体が自動化の印として断られる）。
 * Orca由来: ~/bench/orca/src/main/browser/browser-process-user-agent.ts の cleanElectronUserAgent（MIT）。
 * Chromium の形（"(KHTML, like Gecko)" を含む）のときだけ手を入れ、それ以外はそのまま返す
 */
const CHROMIUM_ENGINE_COMMENT = '(KHTML, like Gecko)'

/** エンジンの注記と Chrome/ の間にあるアプリの印（「ferret/0.4.0」「Ferret Dev/1.0」のような空白入りも） */
const APP_TOKEN = /(\)\s+)(?:[^)\s]+\s+)*?(Chrome\/)/

export function cleanElectronUserAgent(userAgent: string): string {
  if (!userAgent.includes(CHROMIUM_ENGINE_COMMENT)) return userAgent
  return userAgent.replace(/\s+Electron\/\S+/, '').replace(APP_TOKEN, '$1$2')
}

/** Electron の印は残し、アプリの印（製品名と版）だけを外す。Cloudflare の確認を返したホストで使う */
export function electronUserAgent(userAgent: string): string {
  if (!userAgent.includes(CHROMIUM_ENGINE_COMMENT)) return userAgent
  return userAgent.replace(APP_TOKEN, '$1$2')
}

/** 応答の見出しが Cloudflare の確認（managed challenge・JS challenge）か。名前の大小文字は問わない */
export function isCloudflareChallenge(headers: Record<string, string | string[] | undefined> | undefined): boolean {
  if (!headers) return false
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'cf-mitigated') continue
    const values = Array.isArray(value) ? value : [value ?? '']
    if (values.some((v) => v.toLowerCase().includes('challenge'))) return true
  }
  return false
}

/** Electron の UA で開くホストを覚える上限（アプリを開いている間だけ。古いものから忘れる） */
export const ELECTRON_UA_HOSTS_MAX = 500

function hostOf(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : ''
  } catch {
    // 読めない URL は既定の UA（想定内）
    return ''
  }
}

/**
 * 内蔵ブラウザがページごとに名乗る UA を決める。
 * 既定は Chrome の形。Cloudflare の確認を返したホストだけ Electron の印を残した形
 */
export class BrowserIdentity {
  private readonly electronHosts = new Set<string>()

  constructor(
    /** 既定（Chrome と同じ形） */
    readonly chromeUserAgent: string,
    /** Cloudflare の確認を返したホストで使う（Electron の印を残す） */
    readonly electronUserAgent: string
  ) {}

  /** この URL のページで名乗る UA */
  userAgentFor(url: string): string {
    const host = hostOf(url)
    return host && this.electronHosts.has(host) ? this.electronUserAgent : this.chromeUserAgent
  }

  /** 自分が決めた UA か（モバイルの表示の UA などには手を出さない） */
  owns(userAgent: string): boolean {
    return userAgent === this.chromeUserAgent || userAgent === this.electronUserAgent
  }

  /**
   * ページ本体の読み込み（mainFrame）のリクエストで送る UA。手を出さないときは null。
   * タブの UA は遷移が始まったときに切り替えるが、その遷移のリクエスト自体には前の UA が付くので、ここで行き先のホストに合わせる
   */
  requestUserAgent(request: { url: string; resourceType: string; currentUserAgent: string }): string | null {
    if (request.resourceType !== 'mainFrame' || !this.owns(request.currentUserAgent)) return null
    const ua = this.userAgentFor(request.url)
    return ua === request.currentUserAgent ? null : ua
  }

  /**
   * ページ本体の応答を見る。Chrome の形で開いたページに Cloudflare が確認を返したら、そのホストを Electron の UA に切り替え、
   * 読み直すべきなら true（同じホストで2回目以降・Electron の UA でも確認が出たときは false。読み直しを繰り返さない）
   */
  noteResponse(response: { url: string; resourceType: string; sentUserAgent: string; headers: Record<string, string | string[] | undefined> | undefined }): boolean {
    if (response.resourceType !== 'mainFrame' || response.sentUserAgent !== this.chromeUserAgent) return false
    if (this.chromeUserAgent === this.electronUserAgent || !isCloudflareChallenge(response.headers)) return false
    const host = hostOf(response.url)
    if (!host || this.electronHosts.has(host)) return false
    if (this.electronHosts.size >= ELECTRON_UA_HOSTS_MAX) {
      const oldest = this.electronHosts.values().next().value
      if (oldest !== undefined) this.electronHosts.delete(oldest)
    }
    this.electronHosts.add(host)
    return true
  }
}
