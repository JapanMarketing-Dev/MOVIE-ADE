import { clipboard, nativeImage, shell } from 'electron'
import { renderAgentPrompt, renderReplyPrompt } from '@shared/agentPrompt'
import { groupByTarget } from '@shared/reviewTarget'
import { cursorRing } from './pipeline/cursor-ring'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ReviewData, ReviewEdit } from '@shared/review'
import type { RecordingResult } from './recording/types'
import type { Material, TranscriptSegment } from './pipeline/types'
import { buildDraftDocument, refineWithLlm } from './pipeline/decompose'
import { CodexRunner, ClaudeCodeRunner } from './pipeline/organize'
import { ApiLlmRunner } from './pipeline/organize/runners/api'
import { LLM_PROVIDER_PRESETS, providerLabel, type AiEndpointConfig, type LlmApiProvider, type OrganizeRunnerId } from '@shared/aiProviders'
import { resolveAgentEnv } from './accounts'
import { renderFeedbackMarkdown } from './pipeline/feedback'
import { nearestFrameTime } from './pipeline/draft'
import { finalizeItems, toPending } from './pipeline/assemble'
import { imagePlan } from './pipeline/assemble'
// restoreDropped は発話の時刻を t と呼ぶので、そこだけ別名（translateMessage）で引く
import { t, t as translateMessage } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import { DEFAULT_PASS_THRESHOLD } from '@shared/decision'
import { currentSettings } from './settings'
import { appendEvents, applyEdits, frameFilePath, isSessionId, loadSession, readEvents, readLabel, readProgress, saveSession, sessionPaths, takePaths, updateProgress,
  writeFeedbackMarkdown, type SessionPaths, type SessionRecord } from './sessions'
import { sentPatch, type ProgressMap } from '@shared/findingProgress'
import type { ReviewProgressPatch } from '@shared/review'

export async function finishReview(paths: SessionPaths, result: RecordingResult,
  transcript: TranscriptSegment[], warnings: string[], twoSpeakers: boolean): Promise<ReviewData> {
  // 録画を始めた時点の登録URL（index.ts が capture.json に控える）。環境のラベルに使う
  // 古い録画には capture.json が無い（想定内）
  const capture = JSON.parse(await readFile(join(paths.dir, 'capture.json'), 'utf8').catch(() => '{}')) as { urlPresets?: unknown }
  const urlPresets = Array.isArray(capture.urlPresets)
    ? capture.urlPresets.filter((p): p is { id: string; label: string; url: string } =>
      !!p && typeof p.id === 'string' && typeof p.label === 'string' && typeof p.url === 'string')
    : []
  const material: Material = {
    meta: { id: paths.id, startedAt: result.startedAt, durationMs: result.durationMs,
      targetUrl: result.events.find((e) => e.type === 'nav')?.url, twoSpeakers, ...(urlPresets.length ? { urlPresets } : {}) },
    transcript, events: result.events, frames: result.frames
  }
  const { mergeTranscripts } = await import('./pipeline/merge')
  const merged = mergeTranscripts(transcript.filter((s) => s.source !== 'system'), transcript.filter((s) => s.source === 'system'))
  material.transcript = merged.segments
  const stage = buildDraftDocument(material)
  const record: SessionRecord = { version: 1, meta: material.meta, transcript: material.transcript,
    removedDuplicates: merged.removed.map((r) => r.segment), frames: result.frames, draft: stage.draft.items,
    originalDocument: stage.document, document: stage.document, edits: [], captureGaps: [...result.warnings, ...warnings] }
  await persist(paths, record)
  return loadReviewAt(paths)
}

export function checkedPaths(projectDir: string | null, id: string): SessionPaths {
  if (!projectDir) throw new UserFacingError(t('errors.openProjectFolder'))
  if (!isSessionId(id)) throw new UserFacingError(t('review.errors.invalidId'))
  return sessionPaths(projectDir, id)
}

export async function loadReviewAt(paths: SessionPaths): Promise<ReviewData> {
  const record = await loadSession(paths)
  if (!record) return recoverReview(paths)
  const { existsSync } = await import('node:fs')
  const images: Record<string, string> = {}
  for (const name of record.document.items.flatMap((item) => item.images)) {
    if (!/^\.\/\d+\.png$/.test(name)) continue
    // 消された画像は出さないだけ（想定内）
    const bytes = await readFile(join(paths.dir, basename(name))).catch(() => null)
    if (bytes) images[name] = `data:image/png;base64,${bytes.toString('base64')}`
  }
  const progress = await readProgress(paths, record.document.items.map((it) => it.id))
  // 追記した録画があれば、録画ごとの動画と時刻の範囲を渡す（▷ で正しい録画の正しい時刻を開く）
  const { listTakes } = await import('./sessions/takes')
  const takes = listTakes(record)
  const { sentAt } = await readLabel(paths)
  return { id: paths.id, document: record.document, images, progress, canUndo: record.edits.length > 0 && !!record.originalDocument, canOrganize: record.edits.length === 0 && record.document.items.length > 0 && !record.document.organizedByLlm, ...(existsSync(paths.recording) ? { videoUrl: `ade-media://review/${paths.id}/recording.webm` } : {}), warnings: record.captureGaps ?? [],
    ...(takes.length > 1 ? { takes: takes.map((take) => ({ ...take, ...(existsSync(takePaths(paths, take.n).recording) ? { videoUrl: takeVideoUrl(paths.id, take.n) } : {}) })) } : {}),
    ...(sentAt ? { sentAt } : {}) }
}

/** 録画の動画の URL（index.ts の ade-media が返す）。1 本目はレビュー直下の recording.webm */
function takeVideoUrl(id: string, n: number): string {
  return n <= 1 ? `ade-media://review/${id}/recording.webm` : `ade-media://review/${id}/takes/${n}/recording.webm`
}

/**
 * 「このレビューに追加で録る」の録画を始める前に、録る場所（takes/<n>/）を用意する。
 * 分解の終わっていない・壊れたレビューには足さない（足し先の session.json が要る）
 */
export async function prepareReviewTake(projectDir: string, id: string): Promise<{ review: SessionPaths; n: number; paths: SessionPaths }> {
  const review = checkedPaths(projectDir, id)
  const record = await loadSession(review)
  if (!record) throw new UserFacingError(t('review.errors.appendUnavailable'))
  const { nextTakeNumber } = await import('./sessions/takes')
  const { existsSync } = await import('node:fs')
  const { mkdir } = await import('node:fs/promises')
  // 足し終えずに残った録画のフォルダ（落ちた・失敗した）は上書きせず、次の番号を使う
  let n = nextTakeNumber(record)
  while (existsSync(takePaths(review, n).dir)) n++
  const paths = takePaths(review, n)
  await mkdir(paths.audioDir, { recursive: true })
  await mkdir(paths.framesDir, { recursive: true })
  return { review, n, paths }
}

/**
 * 「このレビューに追加で録る」の録画が止まったあと。takes/<n>/ の素材から下書きを作り、レビューの末尾に足す。
 * 既存の指摘・編集・全体への補足・進み具合は残す（sessions/takes.ts）
 */
export async function appendReviewTake(paths: SessionPaths, n: number, result: RecordingResult,
  transcript: TranscriptSegment[], warnings: string[]): Promise<ReviewData> {
  // 編集・整理と同じ順番待ちに並ぶ（同じ session.json を書き換えるので）
  const work = (queues.get(paths.dir) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const record = await loadSession(paths)
    if (!record) throw new UserFacingError(t('review.errors.notFound'))
    const { appendTake } = await import('./sessions/takes')
    const { mergeTranscripts } = await import('./pipeline/merge')
    const merged = mergeTranscripts(transcript.filter((s) => s.source !== 'system'), transcript.filter((s) => s.source === 'system'))
    const appended = appendTake(record, await readEvents(paths), { n, startedAt: result.startedAt, addedAt: new Date().toISOString(),
      durationMs: result.durationMs, transcript: merged.segments, removedDuplicates: merged.removed.map((r) => r.segment),
      events: result.events, frames: result.frames, warnings: [...result.warnings, ...warnings] })
    // 操作ログはレビューの時間軸へずらしたものをレビューの events.jsonl へ足す（録画ごとの元の記録は takes/<n>/events.jsonl に残る）
    await appendEvents(paths, appended.events)
    await persist(paths, appended.record)
    return loadReviewAt(paths)
  })
  queues.set(paths.dir, work)
  try { return await work } finally { if (queues.get(paths.dir) === work) queues.delete(paths.dir) }
}

async function persist(paths: SessionPaths, record: SessionRecord): Promise<void> {
  // 編集で番号が変わったときも、画像名と内容を同時に作り直す。
  for (const plan of imagePlan({ ...record.document, items: record.document.items.map((it) => ({ ...it, include: true })) }, record.frames)) {
    let frame = nativeImage.createFromPath(frameFilePath(paths, plan.frame.path))
    if (frame.isEmpty()) continue
    if (plan.needsCursorRing && plan.frame.cursor && plan.frame.size) {
      const size = frame.getSize()
      frame = nativeImage.createFromBitmap(cursorRing(frame.toBitmap(), size.width, size.height, plan.frame.cursor.x, plan.frame.cursor.y), size)
    }
    const width = Math.min(frame.getSize().width, 1568)
    await writeFile(join(paths.dir, basename(plan.name)), frame.resize({ width }).toPNG())
  }
  await saveSession(paths, record)
  await writeFeedbackMarkdown(paths, renderFeedbackMarkdown(record.document, feedbackOptions(paths, record)))
}

/** feedback.md の書き出しの設定（受け入れ確認の節・進み具合のファイル） */
function feedbackOptions(paths: SessionPaths, record: SessionRecord) {
  return { captureGaps: record.captureGaps ?? [], decision: feedbackDecisionOptions(paths), progressFile: paths.progressJson }
}

/**
 * 指摘の進み具合を変える（画面の切り替え）。Agent と同じ progress.json に書く。
 * 知らない指摘のIDは書かない（renderer から来た値なので確かめる）
 */
export async function setReviewProgress(paths: SessionPaths, patch: ReviewProgressPatch): Promise<ProgressMap> {
  const record = await loadSession(paths)
  if (!record) throw new UserFacingError(t('review.errors.notFound'))
  const ids = record.document.items.map((it) => it.id)
  const known = Object.fromEntries(Object.entries(patch && typeof patch === 'object' ? patch : {}).filter(([id]) => ids.includes(id)))
  if (Object.keys(known).length) await updateProgress(paths, known)
  return readProgress(paths, ids)
}

/** 「Agentへ送信」のあと。送った指摘のうち未対応のものを対応中にする（Agent が done にするまで） */
export async function markSentInProgress(paths: SessionPaths): Promise<void> {
  const record = await loadSession(paths)
  if (!record) return
  const patch = sentPatch(record.document.items, await readProgress(paths))
  if (Object.keys(patch).length) await updateProgress(paths, patch)
}

const queues = new Map<string, Promise<unknown>>()
export async function editReview(paths: SessionPaths, edit: ReviewEdit): Promise<ReviewData> {
  // 前の処理の失敗はその呼び出し側へ返し済み。ここでは順番待ちに使うだけ（想定内）
  const next = (queues.get(paths.dir) ?? Promise.resolve()).catch(() => {}).then(() => editReviewNow(paths, edit))
  queues.set(paths.dir, next)
  try { return await next } finally { if (queues.get(paths.dir) === next) queues.delete(paths.dir) }
}
async function editReviewNow(paths: SessionPaths, edit: ReviewEdit): Promise<ReviewData> {
  const record = await loadSession(paths)
  if (!record) throw new UserFacingError(t('review.errors.notFound'))
  if (edit.kind === 'undo') {
    if (!record.originalDocument || !record.edits.length) throw new UserFacingError(t('review.errors.nothingToRestore'))
    const edits = record.edits.slice(0, -1)
    const applied = applyEdits({ document: record.originalDocument, edits, events: await readEvents(paths), frames: record.frames })
    await persist(paths, { ...record, document: applied.document, edits })
    return loadReviewAt(paths)
  }
  if (edit.kind === 'merge') {
    const positions = edit.ids.map((id) => record.document.items.findIndex((it) => it.id === id))
    if (positions.length !== 2 || positions[0]! < 0 || positions[1] !== positions[0]! + 1)
      throw new UserFacingError(t('review.errors.selectAdjacent'))
  }
  const applied = applyEdits({ document: record.document, edits: [edit],
    events: await readEvents(paths), frames: record.frames })
  if (applied.skipped.length) throw new Error(applied.skipped[0]!.reason)
  await persist(paths, { ...record, document: applied.document, edits: [...record.edits, edit] })
  return loadReviewAt(paths)
}

/** 判定モデルを有効にしているときの、指示文の受け入れ確認（無効なら null） */
function decisionPromptOptions(): { threshold: number } | null {
  const decision = currentSettings().decision
  return decision?.enabled ? { threshold: decision.passThreshold ?? DEFAULT_PASS_THRESHOLD } : null
}

/** 判定モデルを有効にしているときの、feedback.md の受け入れ確認の節と BEFORE の画像の絶対パス（無効なら null） */
function feedbackDecisionOptions(paths: SessionPaths): { threshold: number; dir: string } | null {
  const prompt = decisionPromptOptions()
  return prompt ? { ...prompt, dir: paths.dir } : null
}

/**
 * 送る・コピーする直前に feedback.md を今の設定で書き直す（判定モデルを有効・無効にしたあとでも節が合うように）。
 * 記録の無いレビュー（分解の途中で落ちた）はそのまま
 */
export async function refreshFeedbackMarkdown(paths: SessionPaths): Promise<void> {
  const record = await loadSession(paths)
  if (record) await writeFeedbackMarkdown(paths, renderFeedbackMarkdown(record.document, feedbackOptions(paths, record)))
}

export async function copyReview(paths: SessionPaths, template?: string | null): Promise<void> {
  await refreshFeedbackMarkdown(paths)
  clipboard.writeText(reviewInstruction(paths, template))
}
export async function revealReview(paths: SessionPaths): Promise<void> {
  shell.showItemInFolder(paths.feedbackMd)
}

/** 「Agentへ送信」「Agent向けにコピー」の1行。文面は設定のテンプレート（空なら既定文） */
export function reviewInstruction(paths: SessionPaths, template?: string | null): string {
  return renderAgentPrompt({ relativeDir: paths.relativeDir, feedbackMd: paths.feedbackMd }, template, undefined, decisionPromptOptions())
}

/**
 * 「Agent から確認があります」（needs_human）への返答を送る1行。renderer が review:send の差し替えの本文として送り、
 * 送れたら review:progress でその指摘を対応中へ戻して返答を残す。番号は feedback.md の見出しと同じ数え方（送る指摘だけを対象ごとの節の順に）。送る指摘でなければ投げる
 */
export async function replyInstruction(paths: SessionPaths, itemId: string, reply: string): Promise<string> {
  const record = await loadSession(paths)
  if (!record) throw new UserFacingError(t('review.errors.notFound'))
  const included = record.document.items.filter((it) => it.include)
  const ordered = groupByTarget(included, (it) => it.context.url, record.document.meta.urlPresets ?? []).flatMap((g) => g.items)
  const n = ordered.findIndex((it) => it.id === itemId) + 1
  if (n === 0) throw new UserFacingError(t('review.errors.findingNotFound'))
  await refreshFeedbackMarkdown(paths)
  return renderReplyPrompt({ relativeDir: paths.relativeDir, feedbackMd: paths.feedbackMd }, { n, id: itemId, reply }, undefined, decisionPromptOptions())
}
export async function previewFrames(paths: SessionPaths, itemId: string): Promise<import('@shared/review').ReviewFrame[]> {
  const record = await loadSession(paths)
  const item = record?.document.items.find((it) => it.id === itemId)
  if (!record || !item) throw new UserFacingError(t('review.errors.findingNotFound'))
  const { frameCandidates } = await import('./sessions/edits')
  const { framesOfTake } = await import('./sessions/takes')
  // 追記した録画があれば、その指摘と同じ録画の静止画だけを候補にする
  return frameCandidates(framesOfTake(record, item.contextTime), item.contextTime, 7).flatMap((frame) => {
    const image = nativeImage.createFromPath(frameFilePath(paths, frame.path))
    return image.isEmpty() ? [] : [{ t: frame.t, image: image.resize({ width: Math.min(800, image.getSize().width) }).toDataURL() }]
  })
}

/**
 * 「指摘を整理」。CLI（各自の契約）か、API キーで直接 LLM を呼ぶ（api: で始まる runnerId）。
 * api には保存したキーと接続先を渡す（キーは pipeline/stt/keys.ts。配布版は環境変数のキーを読まない）
 */
export async function organizeReview(paths: SessionPaths, runnerId: OrganizeRunnerId, api?: { apiKey?: string; endpoint?: AiEndpointConfig },
  /** CLI の runner のモデル名（settings.json の organizer.cliModels）。省略時は各 CLI の既定 */
  cliModels?: Partial<Record<'codex' | 'claude-code', string>>): Promise<ReviewData> {
  // 前の処理の失敗はその呼び出し側へ返し済み（順番待ちに使うだけ。想定内）
  const work = (queues.get(paths.dir) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const record = await loadSession(paths)
    if (!record || record.edits.length) throw new UserFacingError(t('review.errors.editedNoOverwrite'))
    // 選択中のアカウント（フッターで切り替えたもの）で CLI を動かす
    const apiProvider = runnerId.startsWith('api:') ? runnerId.slice(4) as LlmApiProvider : null
    const runner = apiProvider
      ? new ApiLlmRunner({ provider: apiProvider, endpoint: api?.endpoint, apiKey: api?.apiKey })
      : runnerId === 'codex'
        ? new CodexRunner({ accountEnv: () => resolveAgentEnv('codex'), ...(cliModels?.codex ? { model: cliModels.codex } : {}) })
        : new ClaudeCodeRunner({ accountEnv: () => resolveAgentEnv('claude'), ...(cliModels?.['claude-code'] ? { model: cliModels['claude-code'] } : {}) })
    const name = apiProvider ? providerLabel(LLM_PROVIDER_PRESETS[apiProvider], t) : runnerId === 'codex' ? 'Codex' : 'Claude Code'
    if (!await runner.available()) throw new Error(apiProvider ? t('organize.api.keyMissing', { label: name }) : t('review.errors.runnerUnavailable', { name }))
    const material: Material = { meta: record.meta, transcript: record.transcript, events: await readEvents(paths), frames: record.frames }
    // API は CLI より待つ（大きなモデルは1分を超えることがある。接続先ごとの timeoutMs があればそれを使う）
    const result = await refineWithLlm(material, buildDraftDocument(material), { runner, cwd: paths.dir, timeoutMs: apiProvider ? 180_000 : 60_000 })
    record.llm = { runner: runner.id, ok: result.organize.ok, elapsedMs: result.organize.elapsedMs,
      issues: result.organize.issues, ...(!result.organize.ok ? { reason: result.organize.reason } : {}) }
    if (result.fellBack) {
      await persist(paths, record)
      // 理由は session.json の llm.reason に残す。画面には次の一手だけを出す
      throw new UserFacingError(t('review.errors.organizeFailed', { name }))
    }
    record.originalDocument = result.document
    record.document = result.document
    await persist(paths, record)
    return loadReviewAt(paths)
  })
  queues.set(paths.dir, work)
  try { return await work } finally { if (queues.get(paths.dir) === work) queues.delete(paths.dir) }
}

async function recoverReview(paths: SessionPaths): Promise<ReviewData> {
  const { inspect, startedAtFromId } = await import('./sessions')
  const info = await inspect(paths)
  const { existsSync } = await import('node:fs')
  const broken = existsSync(paths.sessionJson)
  if (!info.worthRecovering) throw new Error(broken ? t('review.errors.broken') : t('review.errors.nothingRecoverable'))
  // 壊れた session.json は上書きで失わないよう、別名で残してから作り直す
  if (broken) await copyFile(paths.sessionJson, `${paths.sessionJson}.broken`)
  // 記録の各ファイルは無いことがあり、途中で切れた行は飛ばす（中断した録画の復元。想定内）
  const lines = async <T>(name: string): Promise<T[]> => (await readFile(join(paths.dir, name), 'utf8').catch(() => '')).split('\n').flatMap((line) => {
    try { return line.trim() ? [JSON.parse(line) as T] : [] } catch { return [] }
  })
  const events = await readEvents(paths)
  const frames = await lines<import('./pipeline/types').FrameRef>('frames.jsonl')
  const transcript = await lines<TranscriptSegment>('transcript.jsonl')
  const meta = JSON.parse(await readFile(join(paths.dir, 'capture.json'), 'utf8').catch(() => '{}')) as { startedAt?: string; twoSpeakers?: boolean }
  const durationMs = Math.max(0, ...events.map((e) => e.t), ...frames.map((f) => f.t), ...transcript.map((s) => s.t1))
  return finishReview(paths, { startedAt: meta.startedAt ?? startedAtFromId(paths.id), durationMs, videoPath: paths.recording,
    videoBytes: 0, frames, events, audioSamples: { mic: 0, system: 0 }, warnings: [] }, transcript,
    [t('review.recoveredWarning')], meta.twoSpeakers ?? false)
}

export async function restoreDropped(paths: SessionPaths, t: number): Promise<ReviewData> {
  // 前の処理の失敗はその呼び出し側へ返し済み（順番待ちに使うだけ。想定内）
  const work = (queues.get(paths.dir) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const record = await loadSession(paths)
    const base = record?.originalDocument ?? record?.document
    const dropped = base?.dropped.find((item) => item.t === t)
    const quote = record?.transcript.find((item) => item.t0 === t)
    if (!record || !base || !dropped || !quote) throw new Error(translateMessage('review.errors.noRecoverableUtterance'))
    const events = await readEvents(paths)
    const ft = nearestFrameTime(record.frames, t)
    const restored = { id: `restored-${t}`, t, title: quote.text.slice(0, 60), request: '', status: 'needs_check' as const,
      quotes: [{ speaker: quote.speaker, t, text: quote.text }], frameTimes: ft === undefined ? [] : [ft], annotationIds: [], draftIds: [], include: false }
    // 指摘が増えたので、整理が付けた名前（reviewTitle）は外して自動の名前をルールで作り直す
    const { reviewTitle: _stale, ...rest } = base
    record.originalDocument = { ...rest, items: finalizeItems([...base.items.map(toPending), restored], events), dropped: base.dropped.filter((item) => item.t !== t) }
    record.document = applyEdits({ document: record.originalDocument, edits: record.edits, events, frames: record.frames }).document
    await persist(paths, record)
    return loadReviewAt(paths)
  })
  queues.set(paths.dir, work)
  try { return await work } finally { if (queues.get(paths.dir) === work) queues.delete(paths.dir) }
}
