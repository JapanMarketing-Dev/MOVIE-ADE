/**
 * 判定モデルの中継と、Agent のターミナルへ渡す環境変数をまとめる。
 *
 * - 有効にしたら中継を立てる。無効にしても止めず、依頼を断るだけにする（アプリを閉じるまでポートと合言葉を変えない。
 *   開いたままのターミナルの URL が、無効 → 有効のあとも使えるように）
 * - ターミナルを開くたびに合言葉を1つ出し、FERRET_DECISION_URL / _MODEL / _IMAGES / _IMAGE_FORMAT を渡す。**キーは渡さない**
 *   （改名前の MOVIE_ADE_DECISION_* も1リリースだけ同じ値で渡す。非推奨）
 * - キーは中継に最初の依頼が来たときに初めて読み（macOS の Keychain に触れうる）、設定が変わるまで覚えておく
 *
 * Electron に依存させない（設定・キー・記録の口は呼び出し側が渡す）。
 */
import { DECISION_ENV, LEGACY_DECISION_ENV, decisionAuthHeader, resolveDecision, type DecisionPreferences } from '@shared/decision'
import type { ApiCallRecord } from '@shared/apiUsage'
import { DecisionRelay, RelayConfigError, type RelayTokenMeta, type RelayUpstream } from './relay'

export interface DecisionServiceDeps {
  prefs: () => DecisionPreferences | undefined
  /** キーの解決（settings.json の apiKey > apiKeyEnv > 保存したキー）。値はログに出さない */
  readKey: (prefs: DecisionPreferences) => Promise<string | undefined>
  /** 環境変数を読む（process.env → プロジェクトの .env → 設定フォルダの .env。settingsKeys.ts の envGetter） */
  getEnv: (name: string) => string | undefined
  onCall: (record: ApiCallRecord) => void
  fetch?: typeof fetch
}

export class DecisionService {
  private relay: DecisionRelay | null = null
  /** 復号したキー。設定が変わったら捨てる */
  private cachedKey: { value: string | undefined } | null = null

  constructor(private readonly deps: DecisionServiceDeps) {}

  private enabledPrefs(): DecisionPreferences | null {
    const prefs = this.deps.prefs()
    return prefs?.enabled ? prefs : null
  }

  /** 設定が変わったら呼ぶ。有効なら中継を立てる。無効にしても止めない（依頼は upstream が断る） */
  async sync(): Promise<void> {
    this.cachedKey = null
    if (!this.enabledPrefs()) return
    if (!this.relay) this.relay = new DecisionRelay({ upstream: () => this.upstream(), onCall: this.deps.onCall, ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}) })
    await this.relay.start()
  }

  /** 中継を止める（アプリの終了・テスト用）。出した合言葉もすべて無効になる */
  async stop(): Promise<void> {
    const relay = this.relay
    this.relay = null
    await relay?.stop()
  }

  get port(): number | null {
    return this.relay?.port ?? null
  }

  /** ターミナル（Agent）を開くときの環境変数。無効なら空。キーは入れない */
  async launchEnv(meta: RelayTokenMeta = {}): Promise<Record<string, string>> {
    const prefs = this.enabledPrefs()
    if (!prefs) return {}
    if (!this.relay?.running) await this.sync()
    const relay = this.relay
    if (!relay) return {}
    const resolved = resolveDecision(prefs, this.deps.getEnv)
    const values = {
      url: relay.urlFor(relay.issue(meta)),
      model: resolved.model,
      images: resolved.images ? '1' : '0',
      imageFormat: resolved.imageFormat
    }
    const env: Record<string, string> = {}
    for (const key of Object.keys(values) as (keyof typeof values)[]) {
      env[DECISION_ENV[key]] = values[key]
      env[LEGACY_DECISION_ENV[key]] = values[key]
    }
    return env
  }

  /** 中継が送る先。依頼のたびに設定を読み直す（キーだけは覚えておく） */
  private async upstream(): Promise<RelayUpstream> {
    const prefs = this.enabledPrefs()
    if (!prefs) throw new RelayConfigError('The decision model is turned off in Ferret settings.')
    const resolved = resolveDecision(prefs, this.deps.getEnv)
    if (resolved.missing.includes('account_id')) throw new RelayConfigError('Set the Cloudflare account ID in Ferret settings (or CLOUDFLARE_ACCOUNT_ID).')
    if (resolved.missing.length) throw new RelayConfigError('Set the decision API URL and model in Ferret settings.')
    if (!this.cachedKey) this.cachedKey = { value: resolved.authScheme === 'none' ? undefined : await this.deps.readKey(prefs) }
    return {
      url: resolved.url,
      headers: { ...resolved.headers, ...decisionAuthHeader(resolved, this.cachedKey.value) },
      provider: resolved.preset,
      model: resolved.model,
      ...(resolved.pricing ? { pricing: resolved.pricing } : {}),
      timeoutMs: resolved.timeoutMs
    }
  }
}
