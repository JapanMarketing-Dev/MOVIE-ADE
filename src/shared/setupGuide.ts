/**
 * AI の接続先の設定の案内（文字起こし・整理・判定モデルで共通）。
 * - 「キーを作る ↗」「ID はここ ↗」「ドキュメント ↗」のリンク（外部のブラウザで開く。https だけ）
 * - Agent に設定を頼む指示文（Account ID を調べる・キーの作り方を案内する・settings.json と .env に書く）
 *
 * 指示文の決まり：キーや ID の値は入れない。Agent にも値を表示させない。キーの作成・ログイン・権限の付与は
 * 利用者が自分で行い、Agent に代わりにさせない。settings.json にはキーそのものを書かず、apiKeyEnv で参照する。
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
  /** settings.json の中の接続先の場所（例 capture.sttEndpoints.groq） */
  endpointPath: string
  /** その提供元を使うようにする項目（例 capture.transcription = "groq"） */
  select?: { path: string; value: string }
}

type Translate = (key: TranslationKey, params?: MessageParams) => string

/**
 * Agent に設定を頼む指示文。番号付きの手順にする。キーや ID の値は受け取らない（引数に無い）ので、文に入りようがない。
 */
export function buildAgentSetupPrompt(guide: SetupGuide, target: SetupPromptTarget, t: Translate): string {
  const at = { provider: guide.label, path: target.endpointPath, settingsPath: target.settingsPath }
  const steps: string[] = []
  if (guide.local) {
    steps.push(t('ai.setup.prompt.local', { provider: guide.label, installUrl: guide.installUrl ?? '', baseUrl: guide.baseUrl.replace(/\/+$/, ''), model: guide.model || '-' }))
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
  steps.push(t('ai.setup.prompt.finish'))
  const docs = isSafeExternalUrl(guide.docsUrl) ? `\n${t('ai.setup.prompt.docs', { docsUrl: guide.docsUrl })}` : ''
  return `${t('ai.setup.prompt.intro', { provider: guide.label, purpose: target.purpose })}\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}${docs}`
}
