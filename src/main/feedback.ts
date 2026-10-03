import {
  BODY_MAX,
  FEEDBACK_KIND_META,
  TITLE_MAX,
  buildNewIssueUrl,
  ghIssueCreateArgs,
  isFeedbackIssueUrl,
  type FeedbackEnvironment,
  type FeedbackSubmitInput,
  type FeedbackSubmitResult
} from '@shared/feedback'
import { UserFacingError } from '@shared/errors'
import { t } from '@shared/i18n'
import { classifyGhError, type ExecResult } from './github/gh'
import { shouldFallBackToBrowser, sniffImageType, type RelayImage, type RelayResult, type RelaySubmission } from './feedbackRelay'
import { MAX_IMAGE_BYTES, MAX_IMAGES } from '@shared/feedbackRelay'

/**
 * フィードバックを GitHub の Issue にする。
 *
 * Orca由来: ~/bench/orca/src/main/ipc/feedback.ts（送信の入口と環境情報の集め方）（MIT, Copyright 2026 Lovecast Inc.）
 * 送り方（利用者の声をなるべく多く集めるため、既定は GitHub のアカウント無しで送れる匿名の中継）:
 *   1. via: 'relay'（既定）… 匿名の中継（src/main/feedbackRelay.ts）。静止画も送れる
 *   2. via: 'gh' … gh でログイン済みの人が選べる「自分の GitHub アカウントで送る」。`gh issue create`（本文は標準入力）。
 *      ラベルの権限が無くて断られたら、ラベル無しでもう一度
 *   3. 中継が落ちている・gh が失敗した・未ログイン … GitHub の「新しい Issue」の画面をブラウザで開く。
 *      URL に収まらない本文は短くし、全文はクリップボードに写す（静止画はブラウザの画面で貼ってもらう）
 * 中継が内容を理由に断った（頻度の上限・重複・大きすぎるなど）ときは、ブラウザへは回さず理由を返す。
 * gh の失敗の出力はトークンを含みうるのでそのままは出さない（classifyGhError の伏せた短い文だけを画面に添える）。
 * Electron に依存させない（中継・gh・ブラウザ・クリップボードは呼び出し側が渡す）。単体テストの対象。
 */

export interface FeedbackSubmitDeps {
  relay: (submission: RelaySubmission) => Promise<RelayResult>
  /** 中継に添える版・OS（main が決める。renderer からは受け取らない） */
  appMeta: () => { appVersion: string; platform: string; arch: string; osRelease: string; installId: string | undefined }
  gh: (args: string[], options?: { input?: string; timeoutMs?: number }) => Promise<ExecResult>
  /** gh でログイン済みか（githubStatus の account の有無） */
  signedIn: () => Promise<boolean>
  openExternal: (url: string) => Promise<void>
  copyText: (text: string) => void
}

type Validated = Omit<FeedbackSubmitInput, 'images'> & { images: RelayImage[] }

function validate(input: FeedbackSubmitInput): Validated {
  const kind = input?.kind === 'idea' ? 'idea' : input?.kind === 'bug' ? 'bug' : null
  const title = typeof input?.title === 'string' ? input.title.replace(/[\r\n]+/g, ' ').trim() : ''
  const body = typeof input?.body === 'string' ? input.body : ''
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const f = input?.fields
  const fields = { summary: str(f?.summary), what: str(f?.what), expected: str(f?.expected), actual: str(f?.actual), environment: str(f?.environment) }
  if (!kind) throw new UserFacingError(t('feedback.errors.badKind'))
  if (!title || title === FEEDBACK_KIND_META[kind].prefix.trim()) throw new UserFacingError(t('feedback.errors.titleRequired'))
  if (title.length > TITLE_MAX + 12) throw new UserFacingError(t('feedback.errors.titleTooLong'))
  if (body.length > BODY_MAX || Object.values(fields).join('').length > BODY_MAX) throw new UserFacingError(t('feedback.errors.bodyTooLong'))
  const rawImages = Array.isArray(input?.images) ? input.images.slice(0, MAX_IMAGES) : []
  const images = rawImages.flatMap((image) => {
    const data = typeof image?.base64 === 'string' && image.base64.length < MAX_IMAGE_BYTES * 2 ? new Uint8Array(Buffer.from(image.base64, 'base64')) : null
    const type = data ? sniffImageType(data) : null
    return data && type ? [{ type, data }] : []
  })
  return { kind, title, body, fields, via: input?.via === 'gh' ? 'gh' : input?.via === 'browser' ? 'browser' : 'relay', includeEnvironment: input?.includeEnvironment === true, includeInstallId: input?.includeInstallId === true, images }
}

async function openInBrowser(input: Validated, deps: FeedbackSubmitDeps, reason: 'chosen' | 'not-signed-in' | 'gh-failed' | 'relay-down', detail?: string): Promise<FeedbackSubmitResult> {
  const { url, truncated } = buildNewIssueUrl(input.kind, input.title, input.fields)
  if (!isFeedbackIssueUrl(url)) throw new UserFacingError(t('feedback.errors.openFailed'))
  if (truncated) deps.copyText(input.body)
  await deps.openExternal(url)
  return { kind: 'opened', truncated, reason, ...(detail ? { detail } : {}) }
}

export async function submitFeedback(raw: FeedbackSubmitInput, deps: FeedbackSubmitDeps): Promise<FeedbackSubmitResult> {
  const input = validate(raw)
  if (input.via === 'browser') return openInBrowser(input, deps, 'chosen')

  if (input.via === 'relay') {
    const meta = deps.appMeta()
    const result = await deps.relay({
      kind: input.kind === 'idea' ? 'enhancement' : 'bug',
      title: input.title,
      body: input.body,
      appVersion: meta.appVersion,
      ...(input.includeEnvironment ? { platform: meta.platform, arch: meta.arch, osRelease: meta.osRelease } : {}),
      ...(input.includeInstallId && meta.installId ? { installId: meta.installId } : {}),
      images: input.images
    })
    if (result.ok) return { kind: 'created', url: result.url, via: 'relay' }
    if (shouldFallBackToBrowser(result.code)) return openInBrowser(input, deps, 'relay-down')
    return { kind: 'rejected', code: result.code, retryable: result.retryable, ...(result.retryAfterSec ? { retryAfterSec: result.retryAfterSec } : {}) }
  }

  if (!(await deps.signedIn().catch(() => false))) return openInBrowser(input, deps, 'not-signed-in')
  const create = (withLabel: boolean) => deps.gh(ghIssueCreateArgs(input.kind, input.title, withLabel), { input: input.body, timeoutMs: 30_000 })
  let result = await create(true)
  // ラベルを付ける権限が無い（リポジトリの協力者でない）と断られることがある。ラベル無しで作り直す
  if (result.failed && !result.missing && !result.timedOut && /label/i.test(`${result.stderr}\n${result.stdout}`)) result = await create(false)
  const url = result.stdout.match(/https:\/\/github\.com\/\S+\/issues\/\d+/)?.[0]
  if (!result.failed && url) return { kind: 'created', url, via: 'gh' }
  // 失敗の出力はトークンを含みうるので、そのままは出さない。classifyGhError で伏せて短い文にしたものだけを画面に添える
  return openInBrowser(input, deps, 'gh-failed', classifyGhError(result).message)
}

/** 環境情報の元の値（伏せ字は shared/feedback の sanitizeEnvironment で行う） */
export function collectEnvironment(src: {
  appVersion: string
  packaged: boolean
  platform: NodeJS.Platform
  systemVersion: string
  arch: string
  cpuModel: string | undefined
  locale: string
}): FeedbackEnvironment {
  const os = src.platform === 'darwin' ? 'macOS' : src.platform === 'win32' ? 'Windows' : src.platform === 'linux' ? 'Linux' : src.platform
  return {
    appVersion: src.appVersion,
    build: src.packaged ? 'release' : 'dev',
    os,
    osVersion: src.systemVersion,
    arch: src.arch,
    cpu: src.cpuModel?.trim() || 'unknown',
    locale: src.locale
  }
}
