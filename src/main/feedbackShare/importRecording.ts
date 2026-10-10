/**
 * 共有リンクに届いた録画（声・書き込み・文字で指摘）を、mtg の取り込みと同じレビューの素材にする。Electron に依存しない純粋な処理。
 * 取り込み自体は meeting/import.ts の importShareRecording（動画を写す → 声を文字起こし → コマ → createImportedReview）。
 *
 * - 送った人の名前は、文字起こし・文字で指摘の話者の名前（speakerName → 引用の Quote.name）にする
 * - 書き込み（pen・erase）は録画と同じ操作ログにする（動かした・戻したものは replaces・erase のまま。resolveAnnotationEdits が解く）
 * - 文字で指摘は、枠を四角の書き込みに、文をその時刻の発言にする（下書きが枠と文を1つの指摘にまとめる）
 * - 録画を始めたページは、0 秒の遷移にする（指摘の URL になる）
 */
import type { ShareEventsFile, ShareRecording } from '@shared/feedbackShare'
import type { Event, PenEvent, TranscriptSegment } from '../pipeline/types'

/** 文字で指摘を発言にするときの長さ（下書きのまとまりの判定に使う） */
const NOTE_SPAN_MS = 1500
/** 書き込みのコマは、描き終わりから少し後を撮る（動画に描いた線が写ってから） */
export const PEN_FRAME_DELAY_MS = 150

export interface ShareMaterial {
  transcript: TranscriptSegment[]
  events: Event[]
  /** 書き込みごとに撮るコマの時刻（FrameRef.annotationId に入れる） */
  penFrames: Array<{ t: number; annotationId: string }>
}

export function shareRecordingMaterial(recording: Pick<ShareRecording, 'name' | 'notes' | 'startUrl' | 'durationMs'>, eventsFile: ShareEventsFile | null, spoken: readonly TranscriptSegment[]): ShareMaterial {
  const name = recording.name?.trim() || undefined
  const who = name ? { speakerName: name } : {}
  const transcript: TranscriptSegment[] = [
    ...spoken.map((s) => ({ ...s, speaker: 'other' as const, ...who })),
    ...recording.notes.map((n) => ({ t0: n.t, t1: n.t + NOTE_SPAN_MS, speaker: 'other' as const, text: n.text, ...who }))
  ].sort((a, b) => a.t0 - b.t0)

  const events: Event[] = []
  if (recording.startUrl) events.push({ t: 0, type: 'nav', url: recording.startUrl, title: '' })
  const penFrames: ShareMaterial['penFrames'] = []
  let view = eventsFile?.view ?? null
  const end = Math.max(0, recording.durationMs)
  for (const e of eventsFile?.events ?? []) {
    if (e.type === 'view') {
      view = { width: e.width, height: e.height }
    } else if (e.type === 'pen' || e.type === 'note') {
      // 文字で指摘の枠は、ペンの ID と混ざらないよう印を付ける
      const id = e.type === 'note' ? `note-${e.id}` : e.id
      const tEnd = e.type === 'pen' ? e.t_end : e.t
      const pen: PenEvent = {
        t: e.t, type: 'pen', id, t_end: tEnd, bbox: e.bbox,
        ...(e.type === 'note' || e.shape === 'rect' ? { shape: 'rect' as const } : {}),
        ...(e.type === 'pen' && e.replaces ? { replaces: e.replaces } : {}),
        ...(view ? { view } : {})
      }
      events.push(pen)
      penFrames.push({ t: Math.min(end || Number.MAX_SAFE_INTEGER, tEnd + PEN_FRAME_DELAY_MS), annotationId: id })
    } else if (e.type === 'erase') {
      events.push({ t: e.t, type: 'erase', ids: e.ids })
    }
  }
  events.sort((a, b) => a.t - b.t)
  return { transcript, events, penFrames }
}
