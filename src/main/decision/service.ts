/**
 * 判定モデルの中継と、Agent のターミナルへ渡す環境変数をまとめる。
 *
 * - 有効にしたら中継を立てる。無効にしたら中継を止め、出した合言葉をすべて無効にする
 *   （閉じ忘れた Agent の子プロセスが、あとで有効にし直した接続先とキーを使えないように）
 * - 提供元・接続先・キー・モデルなど判定の設定が変わったら、出した合言葉をすべて無効にする（security-5 [4]。
 *   前の設定で渡した合言葉で、新しい接続先・キーへ送らせない。開いているターミナルは開き直すと新しい合言葉になる）
 * - ターミナルを開くたびに合言葉を1つ出し（そのターミナルに結び付け、閉じたら revokeSession で無効にする）、FERRET_DECISION_URL / _MODEL / _IMAGES / _IMAGE_FORMAT を渡す。**キーは渡さない**
 *   （改名前の MOVIE_ADE_DECISION_* も1リリースだけ同じ値で渡す。非推奨）
 * - キーは中継に最初の依頼が来たときに初めて読み（macOS の Keychain に触れうる）、設定が変わるまで覚えておく
 *
 * Electron に依存させない（設定・キー・記録の口は呼び出し側が渡す）。
 */
import { createHash } from 'node:crypto'
import { DECISION_ENV, LEGACY_DECISION_ENV, decisionAuthHeader, resolveDecision, type DecisionPreferences } from '@shared/decision'
import type { ApiCallRecord } from '@shared/apiUsage'
import { t } from '@shared/i18n'
import { checkDecision, type DecisionTestResult } from './check'
import { DecisionRelay, RelayConfigError, type RelayTokenMeta, type RelayUpstream } from './relay'

interface DecisionServiceDeps {
  prefs: () => DecisionPreferences | undefined
  /** キーの解決（settings.json の apiKey > apiKeyEnv > 保存したキー）。値はログに出さない */
  readKey: (prefs: DecisionPreferences) => Promise<string | undefined>
  /** 環境変数を読む（process.env → プロジェクトの .env → 設定フォルダの .env。settingsKeys.ts の envGetter） */
  getEnv: (name: string) => string | undefined
  onCall: (record: ApiCallRecord) => void
  /**
   * 認証情報（キー・環境変数のヘッダー）を url へ送ってよいかを確かめる（security-5 [6]）。だめなら投げる。
   * interactive（利用者が「接続を確かめる」を押した）なら、まだ認めていない接続元を main のダイアログで聞いてよい
   */
  authorize?: (prefs: DecisionPreferences, url: string, interactive: boolean) => Promise<void>
  fetch?: typeof fetch
}

export class DecisionService {
  private relay: DecisionRelay | null = null
  /** 復号したキー。設定が変わったら捨てる */
  private cachedKey: { value: string | undefined } | null = null
  /** 前回の sync の設定（ハッシュ）。変わったら合言葉を切る */
  private prefsFingerprint: string | null = null

  constructor(private readonly deps: DecisionServiceDeps) {}

  private enabledPrefs(): DecisionPreferences | null {
    const prefs = this.deps.prefs()
    return prefs?.enabled ? prefs : null
  }

  /** 設定が変わったら呼ぶ。有効なら中継を立てる。無効なら止める（合言葉もすべて無効になる） */
  async sync(): Promise<void> {
    this.cachedKey = null
    const prefs = this.enabledPrefs()
    if (!prefs) {
      this.prefsFingerprint = null
      await this.stop()
      return
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(prefs)).digest('hex')
    if (this.prefsFingerprint !== null && this.prefsFingerprint !== fingerprint) this.relay?.revokeAll()
    this.prefsFingerprint = fingerprint
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

  /** ターミナルが閉じたら呼ぶ。そのターミナルに渡した合言葉を無効にする */
  revokeSession(sessionId: string): void {
    this.relay?.revokeSession(sessionId)
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
    // 送るたびに、今の接続元へ認証情報を送ってよいかを確かめる（設定が変わっても前の許可を使わない）
    await this.authorize(prefs, false)
    if (!this.cachedKey) {
      const resolved = resolveDecision(prefs, this.deps.getEnv)
      this.cachedKey = { value: resolved.authScheme === 'none' ? undefined : await this.deps.readKey(prefs) }
    }
    return this.upstreamFor(prefs, this.cachedKey.value)
  }

  /** 認証情報を送ってよい接続元か。だめなら RelayConfigError（Agent・画面へは理由の文だけ） */
  private async authorize(prefs: DecisionPreferences, interactive: boolean): Promise<void> {
    if (!this.deps.authorize) return
    const resolved = resolveDecision(prefs, this.deps.getEnv)
    try {
      await this.deps.authorize(prefs, resolved.url, interactive)
    } catch (err) {
      throw new RelayConfigError(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * 「接続を確かめる」（利用者が押したときだけ）。画面でまだ保存していない値で、中継と同じ接続先・キー・ヘッダーへ1回送る。
   * 有効にする前でも確かめられる。fake は E2E・単体テスト用（本物を呼ばない）
   */
  async testConnection(prefs: DecisionPreferences, opt: { fake?: boolean; interactive?: boolean } = {}): Promise<DecisionTestResult> {
    return checkDecision({
      upstream: async () => {
        const resolved = resolveDecision(prefs, this.deps.getEnv)
        // fake は本物へ送らないので確かめない
        if (!resolved.missing.length && !opt.fake) await this.authorize(prefs, opt.interactive === true)
        return this.upstreamFor(prefs, resolved.authScheme === 'none' || resolved.missing.length ? undefined : await this.deps.readKey(prefs))
      },
      onCall: this.deps.onCall,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      ...(opt.fake ? { fake: true } : {})
    })
  }

  private upstreamFor(prefs: DecisionPreferences, key: string | undefined): RelayUpstream {
    const resolved = resolveDecision(prefs, this.deps.getEnv)
    if (resolved.missing.includes('account_id')) throw new RelayConfigError(t('decision.test.accountId'))
    if (resolved.missing.length) throw new RelayConfigError(t('decision.test.config'))
    return {
      url: resolved.url,
      headers: { ...resolved.headers, ...decisionAuthHeader(resolved, key) },
      provider: resolved.preset,
      model: resolved.model,
      ...(resolved.pricing ? { pricing: resolved.pricing } : {}),
      timeoutMs: resolved.timeoutMs
    }
  }
}
