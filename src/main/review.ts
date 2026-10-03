import { clipboard, nativeImage, shell } from 'electron'
import { renderAgentPrompt } from '@shared/agentPrompt'
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
import { applyEdits, isSessionId, loadSession, readEvents, saveSession, sessionPaths,
  writeFeedbackMarkdown, type SessionPaths, type SessionRecord } from './sessions'

export async function finishReview(paths: SessionPaths, result: RecordingResult,
  transcript: TranscriptSegment[], warnings: string[], twoSpeakers: boolean): Promise<ReviewData> {
  const material: Material = {
    meta: { id: paths.id, startedAt: result.startedAt, durationMs: result.durationMs,
      targetUrl: result.events.find((e) => e.type === 'nav')?.url, twoSpeakers },
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
  if (!projectDir) throw new Error(t('errors.openProjectFolder'))
  if (!isSessionId(id)) throw new Error(t('review.errors.invalidId'))
  return sessionPaths(projectDir, id)
}

export async function loadReviewAt(paths: SessionPaths): Promise<ReviewData> {
  const record = await loadSession(paths)
  if (!record) return recoverReview(paths)
  const { existsSync } = await import('node:fs')
  const images: Record<string, string> = {}
  for (const name of record.document.items.flatMap((item) => item.images)) {
    if (!/^\.\/\d+\.png$/.test(name)) continue
    const bytes = await readFile(join(paths.dir, basename(name))).catch(() => null)
    if (bytes) images[name] = `data:image/png;base64,${bytes.toString('base64')}`
  }
  return { id: paths.id, document: record.document, images, canUndo: record.edits.length > 0 && !!record.originalDocument, canOrganize: record.edits.length === 0 && record.document.items.length > 0 && !record.document.organizedByLlm, ...(existsSync(paths.recording) ? { videoUrl: `ade-media://review/${paths.id}/recording.webm` } : {}), warnings: record.captureGaps ?? [] }
}

async function persist(paths: SessionPaths, record: SessionRecord): Promise<void> {
  // 編集で番号が変わったときも、画像名と内容を同時に作り直す。
  for (const plan of imagePlan({ ...record.document, items: record.document.items.map((it) => ({ ...it, include: true })) }, record.frames)) {
    let frame = nativeImage.createFromPath(join(paths.framesDir, basename(plan.frame.path)))
    if (frame.isEmpty()) continue
    if (plan.needsCursorRing && plan.frame.cursor && plan.frame.size) {
      const size = frame.getSize()
      frame = nativeImage.createFromBitmap(cursorRing(frame.toBitmap(), size.width, size.height, plan.frame.cursor.x, plan.frame.cursor.y), size)
    }
    const width = Math.min(frame.getSize().width, 1568)
    await writeFile(join(paths.dir, basename(plan.name)), frame.resize({ width }).toPNG())
  }
  await saveSession(paths, record)
  await writeFeedbackMarkdown(paths, renderFeedbackMarkdown(record.document, { captureGaps: record.captureGaps ?? [] }))
}

const queues = new Map<string, Promise<unknown>>()
export async function editReview(paths: SessionPaths, edit: ReviewEdit): Promise<ReviewData> {
  const next = (queues.get(paths.dir) ?? Promise.resolve()).catch(() => {}).then(() => editReviewNow(paths, edit))
  queues.set(paths.dir, next)
  try { return await next } finally { if (queues.get(paths.dir) === next) queues.delete(paths.dir) }
}
async function editReviewNow(paths: SessionPaths, edit: ReviewEdit): Promise<ReviewData> {
  const record = await loadSession(paths)
  if (!record) throw new Error(t('review.errors.notFound'))
  if (edit.kind === 'undo') {
    if (!record.originalDocument || !record.edits.length) throw new Error(t('review.errors.nothingToRestore'))
    const edits = record.edits.slice(0, -1)
    const applied = applyEdits({ document: record.originalDocument, edits, events: await readEvents(paths), frames: record.frames })
    await persist(paths, { ...record, document: applied.document, edits })
    return loadReviewAt(paths)
  }
  if (edit.kind === 'merge') {
    const positions = edit.ids.map((id) => record.document.items.findIndex((it) => it.id === id))
    if (positions.length !== 2 || positions[0]! < 0 || positions[1] !== positions[0]! + 1)
      throw new Error(t('review.errors.selectAdjacent'))
  }
  const applied = applyEdits({ document: record.document, edits: [edit],
    events: await readEvents(paths), frames: record.frames })
  if (applied.skipped.length) throw new Error(applied.skipped[0]!.reason)
  await persist(paths, { ...record, document: applied.document, edits: [...record.edits, edit] })
  return loadReviewAt(paths)
}

export async function copyReview(paths: SessionPaths, template?: string | null): Promise<void> {
  clipboard.writeText(reviewInstruction(paths, template))
}
export async function revealReview(paths: SessionPaths): Promise<void> {
  shell.showItemInFolder(paths.feedbackMd)
}

/** 「Agentへ送信」「Agent向けにコピー」の1行。文面は設定のテンプレート（空なら既定文） */
export function reviewInstruction(paths: SessionPaths, template?: string | null): string {
  return renderAgentPrompt({ relativeDir: paths.relativeDir, feedbackMd: paths.feedbackMd }, template)
}
export async function previewFrames(paths: SessionPaths, itemId: string): Promise<import('@shared/review').ReviewFrame[]> {
  const record = await loadSession(paths)
  const item = record?.document.items.find((it) => it.id === itemId)
  if (!record || !item) throw new Error(t('review.errors.findingNotFound'))
  const { frameCandidates } = await import('./sessions/edits')
  return frameCandidates(record.frames, item.contextTime, 7).flatMap((frame) => {
    const image = nativeImage.createFromPath(join(paths.framesDir, basename(frame.path)))
    return image.isEmpty() ? [] : [{ t: frame.t, image: image.resize({ width: Math.min(800, image.getSize().width) }).toDataURL() }]
  })
}

/**
 * 「指摘を整理」。CLI（各自の契約）か、API キーで直接 LLM を呼ぶ（api: で始まる runnerId）。
 * api には保存したキーと接続先を渡す（キーは pipeline/stt/keys.ts。配布版は環境変数のキーを読まない）
 */
export async function organizeReview(paths: SessionPaths, runnerId: OrganizeRunnerId, api?: { apiKey?: string; endpoint?: AiEndpointConfig }): Promise<ReviewData> {
  const work = (queues.get(paths.dir) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const record = await loadSession(paths)
    if (!record || record.edits.length) throw new Error(t('review.errors.editedNoOverwrite'))
    // 選択中のアカウント（フッターで切り替えたもの）で CLI を動かす
    const apiProvider = runnerId.startsWith('api:') ? runnerId.slice(4) as LlmApiProvider : null
    const runner = apiProvider
      ? new ApiLlmRunner({ provider: apiProvider, endpoint: api?.endpoint, apiKey: api?.apiKey })
      : runnerId === 'codex'
        ? new CodexRunner({ accountEnv: () => resolveAgentEnv('codex') })
        : new ClaudeCodeRunner({ accountEnv: () => resolveAgentEnv('claude') })
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
      throw new Error(t('review.errors.organizeFailed', { name }))
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
    record.originalDocument = { ...base, items: finalizeItems([...base.items.map(toPending), restored], events), dropped: base.dropped.filter((item) => item.t !== t) }
    record.document = applyEdits({ document: record.originalDocument, edits: record.edits, events, frames: record.frames }).document
    await persist(paths, record)
    return loadReviewAt(paths)
  })
  queues.set(paths.dir, work)
  try { return await work } finally { if (queues.get(paths.dir) === work) queues.delete(paths.dir) }
}
