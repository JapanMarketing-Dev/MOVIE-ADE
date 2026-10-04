/**
 * AI の接続先の設定の案内（文字起こし・整理・判定モデルで共通）。
 * - 「キーを作る ↗」「ID はここ ↗」「ドキュメント ↗」のリンク（外部のブラウザで開く。https だけ）
 * - Agent に設定を頼む指示文。人の手作業を最小にし、Agent に全部させる: CLI が無ければ入れて使い（ollama・wrangler など）、
 *   画面の操作が要るところはブラウザを操作するツール（Playwright・browser use など）で進め、Ferret の settings.json と .env に書き、
 *   最後に1回呼んで確かめる。人に頼むのはログインや承認など本人にしかできない操作だけ（2026-10-03 の方針）
 *
 * 指示文の決まり：キーや ID の値は入れない（引数に無い）。Agent にも値を画面・ログ・会話に出させない。
 * settings.json にはキーそのものを書かず、.env に置いて apiKeyEnv で参照する。
 */
import type { MessageParams, TranslationKey } from './i18n'
import type { AiKeyPermission } from './aiProviders'

/** 案内に使う、提供元の情報（文字起こし・整理のプリセットはそのまま渡せる。判定モデルは写して作る） */
export interface SetupGuide {
  /** 画面に出す名前（OpenAI 互換は訳した名前を渡す） */
  label: string
  keyRequired: boolean
  local?: boolean
  needsAccountId?: boolean
  needsBaseUrl?: boolean
  baseUrl: string
  model: string
  keyUrl?: string
  idUrl?: string
  docsUrl?: string
  installUrl?: string
  envVar?: string
  idEnvVar?: string
  permission?: AiKeyPermission
}

/** 外部のブラウザで開いてよい URL か。https だけ（file:・javascript:・http: などは断る）。URL に認証情報を含むものも断る */
export function isSafeExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 2000) return false
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && !u.username && !u.password && !!u.hostname
  } catch {
    return false
  }
}

export type SetupLinkKind = 'key' | 'id' | 'docs' | 'install'

/** 欄の横に出すリンク。https でないものは出さない */
export function setupLinks(guide: SetupGuide): Array<{ kind: SetupLinkKind; url: string }> {
  const links: Array<{ kind: SetupLinkKind; url: string | undefined }> = [
    { kind: 'install', url: guide.local ? guide.installUrl : undefined },
    { kind: 'key', url: guide.keyRequired ? guide.keyUrl : undefined },
    { kind: 'id', url: guide.needsAccountId ? guide.idUrl : undefined },
    { kind: 'docs', url: guide.docsUrl },
  ]
  return links.flatMap((l) => (isSafeExternalUrl(l.url) ? [{ kind: l.kind, url: l.url }] : []))
}

export interface SetupPromptTarget {
  /** 何に使うか（訳した語。例「文字起こし」） */
  purpose: string
  /** settings.json の絶対パス（settingsFile:info の path） */
  settingsPath: string
  /** 設定フォルダの .env の絶対パス（settingsFile:info の dir + .env。main がキーを探す場所） */
  envPath: string
  /** settings.json の JSON Schema の絶対パス（settingsFile:info の schemaPath）。省略時は settings.json と同じフォルダの settings.schema.json */
  schemaPath?: string
  /** settings.json の中の接続先の場所（例 capture.sttEndpoints.groq） */
  endpointPath: string
  /** その提供元を使うようにする項目（例 capture.transcription = "groq"） */
  select?: { path: string; value: string }
  /** 揃ったら true にする項目（例 decision.enabled）。前の手順がすべて済んでから */
  enablePath?: string
}

/** 端末内のサーバーの種類（入れ方・モデルの落とし方の案内を分ける）。インストールのページの場所で見分ける */
function localServerKind(guide: SetupGuide): 'ollama' | 'other' {
  try {
    return guide.installUrl && new URL(guide.installUrl).hostname === 'ollama.com' ? 'ollama' : 'other'
  } catch {
    return 'other'
  }
}

type Translate = (key: TranslationKey, params?: MessageParams) => string

/**
 * Agent に設定を頼む指示文。番号付きの手順にする。キーや ID の値は受け取らない（引数に無い）ので、文に入りようがない。
 * 手順の並び: Ferret の設定ファイルの場所 → 端末内のサーバーを入れて起動・モデルを落とす → Base URL → Account ID → キー → .env と apiKeyEnv
 * → 使う提供元を選ぶ → 有効にする → 1回呼んで確かめ、値を見せずに報告
 */
export function buildAgentSetupPrompt(guide: SetupGuide, target: SetupPromptTarget, t: Translate): string {
  const at = { provider: guide.label, path: target.endpointPath, settingsPath: target.settingsPath }
  const schemaPath = target.schemaPath ?? target.settingsPath.replace(/settings\.json$/, 'settings.schema.json')
  const steps: string[] = [t('ai.setup.prompt.settings', { settingsPath: target.settingsPath, schemaPath, envPath: target.envPath })]
  if (guide.local) {
    const local = { provider: guide.label, installUrl: guide.installUrl ?? '', baseUrl: guide.baseUrl.replace(/\/+$/, ''), model: guide.model || '-' }
    steps.push(t(localServerKind(guide) === 'ollama' ? 'ai.setup.prompt.ollama' : 'ai.setup.prompt.local', local))
    // 端末内のサーバーは、選んだモデルを settings.json に書くまで「使える」に数えない（isEndpointReady）。落としたモデルを書かせる
    if (guide.model) steps.push(t('ai.setup.prompt.model', { ...at, model: guide.model }))
  }
  if (guide.needsBaseUrl) steps.push(t('ai.setup.prompt.baseUrl', at))
  if (guide.needsAccountId) {
    steps.push(t('ai.setup.prompt.accountId', { ...at, idUrl: guide.idUrl ?? '', idEnvVar: guide.idEnvVar ?? 'ACCOUNT_ID', envPath: target.envPath }))
  }
  if (!guide.local) {
    const envVar = guide.envVar ?? 'MY_API_KEY'
    const permission = guide.permission ? t('ai.setup.prompt.permission', { permission: t(`ai.permission.${guide.permission}` as TranslationKey) }) : ''
    if (guide.keyRequired) steps.push(t('ai.setup.prompt.key', { keyUrl: guide.keyUrl ?? '', permission }))
    steps.push(t(guide.keyRequired ? 'ai.setup.prompt.envFile' : 'ai.setup.prompt.envFileOptional', { ...at, envPath: target.envPath, envVar }))
  }
  if (target.select) steps.push(t('ai.setup.prompt.select', { selectPath: target.select.path, selectValue: target.select.value, settingsPath: target.settingsPath }))
  if (target.enablePath) steps.push(t('ai.setup.prompt.enable', { enablePath: target.enablePath, settingsPath: target.settingsPath }))
  steps.push(t('ai.setup.prompt.finish'))
  const docs = isSafeExternalUrl(guide.docsUrl) ? `\n${t('ai.setup.prompt.docs', { docsUrl: guide.docsUrl })}` : ''
  return `${t('ai.setup.prompt.intro', { provider: guide.label, purpose: target.purpose })}\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}${docs}`
}
