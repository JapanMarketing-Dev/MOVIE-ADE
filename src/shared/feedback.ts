import { STAR_REPO } from './starPrompt'

/**
 * アプリから GitHub の Issue へ送るフィードバック（バグ・改善の提案）。
 *
 * Orca由来: ~/bench/orca/src/shared/client-environment-info.ts（環境情報の書き方）,
 *           ~/bench/orca/.github/ISSUE_TEMPLATE/*.yml（見出し）（MIT, Copyright 2026 Lovecast Inc.）
 * Orca は自前のサーバー経由で匿名で Issue を作るが、Ferret はサーバーを持たない。
 * 利用者の gh で `gh issue create` するか、ブラウザで GitHub の「新しい Issue」の画面を開く。
 *
 * ここは純粋な関数だけ（本文の組み立て・環境情報の伏せ字・URL の切り詰め・gh の引数）。単体テストの対象。
 */

export const FEEDBACK_REPO = STAR_REPO
export const FEEDBACK_REPO_SLUG = `${FEEDBACK_REPO.owner}/${FEEDBACK_REPO.repo}`
export const FEEDBACK_NEW_ISSUE_URL = `https://github.com/${FEEDBACK_REPO_SLUG}/issues/new`

export type FeedbackKind = 'bug' | 'idea'

/** .github/ISSUE_TEMPLATE のファイル名・題名の頭・ラベル。ひな形と合わせる */
export const FEEDBACK_KIND_META: Record<FeedbackKind, { template: string; prefix: string; label: string }> = {
  bug: { template: 'bug_report.yml', prefix: '[Bug]: ', label: 'bug' },
  idea: { template: 'feature_request.yml', prefix: '[Feature]: ', label: 'enhancement' }
}

export interface FeedbackDraft {
  kind: FeedbackKind
  title: string
  /** 既定の大きな欄（Bug: 何が起きましたか / Idea: どうなってほしいですか）。これだけでも送れる */
  summary: string
  /** 「詳しく書く」で開く欄。Bug: 何をしたか / Idea: 困っていること */
  what: string
  /** Bug: 期待したこと / Idea: こうなってほしい */
  expected: string
  /** Bug: 実際に起きたこと / Idea: ほかの案・補足 */
  actual: string
}

/** 環境情報。どれも OS・Electron から取る値で、パス・利用者名・プロジェクト名・URL・キーは入れない */
export interface FeedbackEnvironment {
  appVersion: string
  /** 配布版か開発版か */
  build: 'release' | 'dev'
  os: string
  osVersion: string
  arch: string
  cpu: string
  locale: string
}

/** renderer → main の送信の指定（確認画面で見せた題名・本文のまま送る） */
export interface FeedbackSubmitInput {
  kind: FeedbackKind
  /** 頭（[Bug]: など）を付けた題名 */
  title: string
  body: string
  /** ブラウザで開くときの欄ごとの値（本文と同じ中身。GitHub のフォームは body を受け付けないため） */
  fields: IssueFormFields
  /** 既定は匿名の中継。補助の選択肢として「自分の GitHub アカウントで送る」（gh）と「ブラウザで開く」 */
  via: 'relay' | 'gh' | 'browser'
  /** 環境情報を入れるか。外したら中継にも platform・arch・osRelease を送らない */
  includeEnvironment: boolean
  /** インストール ID を中継に送るか（頻度の上限に使うだけ。Issue には書かれない） */
  includeInstallId: boolean
  /** 静止画（base64、PNG / JPEG、最大3枚・各2MB）。中継のときだけ送る */
  images: Array<{ type: 'image/png' | 'image/jpeg'; base64: string }>
}

/** 送ったあとの結果 */
export type FeedbackSubmitResult =
  | { kind: 'created'; url: string; via: 'relay' | 'gh' }
  /** ブラウザで開いた。truncated なら本文を短くし、全文はクリップボードにある */
  | { kind: 'opened'; truncated: boolean; reason: 'chosen' | 'not-signed-in' | 'gh-failed' | 'relay-down'; /** gh が失敗した理由（伏せ字済みの短い文） */ detail?: string }
  /** 中継が内容を理由に断った（頻度の上限・重複・大きすぎるなど）。retryable なら少し待って送り直せる */
  | { kind: 'rejected'; code: string; retryable: boolean; retryAfterSec?: number }

/**
 * 題名。空なら最初に書いた欄の1行目から作る（一行だけでも送れるように）
 */
export function deriveTitle(draft: Pick<FeedbackDraft, 'title' | 'summary' | 'what' | 'expected' | 'actual'>): string {
  const own = draft.title.replace(/[\r\n]+/g, ' ').trim()
  if (own) return own
  const first = [draft.summary, draft.what, draft.expected, draft.actual].map((v) => v.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '').find(Boolean) ?? ''
  return [...first].length > 80 ? `${[...first].slice(0, 79).join('')}…` : first
}

/** ひな形の見出し（英語。GitHub 側の表示と揃える） */
const HEADINGS: Record<FeedbackKind, { summary: string; details: [string, string, string] }> = {
  bug: { summary: 'What happened?', details: ['What did you do?', 'What did you expect?', 'What actually happened?'] },
  idea: { summary: 'What would you like?', details: ['Problem or use case', 'Proposed solution', 'Alternatives or additional context'] }
}
export const ENVIRONMENT_HEADING = 'Environment'

export const TITLE_MAX = 200
export const BODY_MAX = 60_000

// ─── 環境情報の伏せ字 ─────────────────────────────

/**
 * 環境情報の1つの値から、パス・URL・メール・鍵らしいもの・利用者名を取り除く。
 * 元の値は OS の版や CPU の名前なので、ふつうは何も変わらない。念のための網。
 */
export function redactEnvironmentValue(value: string, secrets: readonly string[] = []): string {
  let text = String(value ?? '').replace(/[\r\n\t]+/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '***')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '***')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s,;)]*[\\/][^\s,;)]*/g, '***')
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|xox[abpr]|AKIA)[-_A-Za-z0-9]{8,}\b/g, '***')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '***')
  // 利用者名・プロジェクト名は最後に（先に伏せると、メールや URL の形が崩れて取り逃す）
  for (const secret of secrets) {
    if (secret && secret.length >= 2) text = text.split(secret).join('***')
  }
  return text.trim().slice(0, 120)
}

export function sanitizeEnvironment(env: FeedbackEnvironment, secrets: readonly string[] = []): FeedbackEnvironment {
  const clean = (v: string) => redactEnvironmentValue(v, secrets) || 'unknown'
  return {
    appVersion: clean(env.appVersion),
    build: env.build === 'release' ? 'release' : 'dev',
    os: clean(env.os),
    osVersion: clean(env.osVersion),
    arch: clean(env.arch),
    cpu: clean(env.cpu),
    locale: clean(env.locale)
  }
}

export function formatEnvironment(env: FeedbackEnvironment, product: string): string {
  return [
    `- ${product}: ${env.appVersion} (${env.build})`,
    `- OS: ${env.os} ${env.osVersion} (${env.arch})`,
    `- CPU: ${env.cpu}`,
    `- Language: ${env.locale}`
  ].join('\n')
}

// ─── 題名と本文 ───────────────────────────────

export function buildIssueTitle(draft: Pick<FeedbackDraft, 'kind' | 'title'>): string {
  const title = draft.title.replace(/[\r\n]+/g, ' ').trim()
  return `${FEEDBACK_KIND_META[draft.kind].prefix}${title}`.slice(0, TITLE_MAX + 12)
}

/** 本文。見出しは .github/ISSUE_TEMPLATE と同じ。空の欄は「_No response_」（GitHub のフォームと同じ書き方） */
export function buildIssueBody(draft: FeedbackDraft, env: FeedbackEnvironment | null, product: string): string {
  const { summary, details } = HEADINGS[draft.kind]
  const section = (heading: string, text: string) => `### ${heading}\n\n${text.trim() || '_No response_'}`
  // 既定の欄は必ず。「詳しく書く」の欄は書いたものだけ（一行の声を、空の見出しで長くしない）
  const parts = [section(summary, draft.summary)]
  ;[draft.what, draft.expected, draft.actual].forEach((text, i) => { if (text.trim()) parts.push(section(details[i]!, text)) })
  if (env) parts.push(`### ${ENVIRONMENT_HEADING}\n\n${formatEnvironment(env, product)}`)
  parts.push(`<sub>Sent from ${product}</sub>`)
  return parts.join('\n\n')
}

// ─── ブラウザで開く URL ────────────────────────────

/**
 * ひな形（Issue のフォーム）の欄ごとの値。GitHub のフォームは `body` を受け付けず、欄の id（what など）で値を入れる。
 * id は .github/ISSUE_TEMPLATE/*.yml と同じ
 */
export interface IssueFormFields {
  summary: string
  what: string
  expected: string
  actual: string
  environment: string
}

export function issueFormFields(draft: FeedbackDraft, env: FeedbackEnvironment | null, product: string): IssueFormFields {
  return {
    summary: draft.summary.trim(),
    what: draft.what.trim(),
    expected: draft.expected.trim(),
    actual: draft.actual.trim(),
    environment: env ? formatEnvironment(env, product) : ''
  }
}

/** GitHub が受け付ける URL の長さには上限がある。余裕を見てこの長さに収める */
export const NEW_ISSUE_URL_MAX = 6000
const TRUNCATED_NOTE = '\n\n_(Truncated. The full text was copied to the clipboard; please paste it here.)_'

/**
 * 「新しい Issue」の画面の URL（ひな形・題名・欄ごとの値）。長すぎれば、長い欄から同じ長さに切りそろえ、
 * 切った欄の末尾にそのことを書く。
 */
export function buildNewIssueUrl(kind: FeedbackKind, title: string, fields: IssueFormFields, maxLength = NEW_ISSUE_URL_MAX): { url: string; truncated: boolean } {
  const make = (f: IssueFormFields) => {
    const params = new URLSearchParams({ template: FEEDBACK_KIND_META[kind].template, title })
    for (const [key, value] of Object.entries(f)) if (value) params.set(key, value)
    return `${FEEDBACK_NEW_ISSUE_URL}?${params.toString()}`
  }
  const full = make(fields)
  if (full.length <= maxLength) return { url: full, truncated: false }
  const cap = (n: number): IssueFormFields => {
    const cut = (v: string) => (v.length > n ? v.slice(0, n).trimEnd() + TRUNCATED_NOTE : v)
    return { summary: cut(fields.summary), what: cut(fields.what), expected: cut(fields.expected), actual: cut(fields.actual), environment: fields.environment }
  }
  // 符号化で長さが変わるので、収まる欄の長さを二分探索で探す
  let lo = 0
  let hi = Math.max(fields.summary.length, fields.what.length, fields.expected.length, fields.actual.length)
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (make(cap(mid)).length <= maxLength) lo = mid
    else hi = mid - 1
  }
  return { url: make(cap(lo)), truncated: true }
}

/** ブラウザで開いてよい URL か（このリポジトリの「新しい Issue」だけ） */
export function isFeedbackIssueUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.host === 'github.com' && u.pathname === `/${FEEDBACK_REPO_SLUG}/issues/new` && !u.username && !u.password
  } catch {
    return false
  }
}

// ─── gh issue create ─────────────────────────────

/** 本文は標準入力（--body-file -）で渡す。withLabel が false ならラベルを付けない（権限が無いと断られるため） */
export function ghIssueCreateArgs(kind: FeedbackKind, title: string, withLabel = true): string[] {
  return [
    'issue', 'create', '-R', FEEDBACK_REPO_SLUG,
    '--title', title,
    ...(withLabel ? ['--label', FEEDBACK_KIND_META[kind].label] : []),
    '--body-file', '-'
  ]
}
