/**
 * 共有1つの部屋（Durable Object）。共有の中身（題名・ライブで開くページ・メモ・パスワードの確認の値）と、届いた録画の一覧を持つ。
 * Worker からだけ fetch（JSON の命令）で呼ばれる。1つの部屋の要求は1つずつ処理されるので、数と大きさの上限を確実に守れる。
 *
 * - 持ち主の命令はトークンのハッシュを付けて送られ、ここで定時間で比べる
 * - 録画は R2 の multipart で分けて届く。始めるときに大きさを予約し（共有の合計の上限）、1回ずつ順に受け、全部そろったら見せる
 * - 期限（expiresAt）で alarm が鳴り、録画（R2）と記録をすべて消す。送り終わらない録画もここで片付ける
 * - 録画は1件ずつ別の鍵（r:<連番>:<id>）に置く（1つの値の大きさの上限に当たらないように）
 */
import {
  SHARE_LIMITS,
  type ShareMemo,
  type SharePublicRecording,
  type ShareRecording,
  type ShareRecordingStart,
  type ShareRecordingStatus,
  type ShareSnapshot,
  type ShareUrl
} from '../../../src/shared/feedbackShare'
import { sha256Hex, type ShareAuthVerifier } from '../../../src/shared/shareCrypto'
import type { Env, RoomState } from './env'
import { PENDING_UPLOAD_MS } from './limits'

export interface RoomMeta {
  id: string
  title: string
  createdAt: string
  expiresAt: string
  urls: ShareUrl[]
  memo?: ShareMemo
  auth?: ShareAuthVerifier
  /** ownerToken の SHA-256（16 進） */
  tokenHash: string
  /** 受け付けた録画の数（断った・消したものも数える。上限の判定に使う） */
  received: number
  /** 予約した・受け取った録画の大きさの合計 */
  bytes: number
}

/** 部屋に置く録画。送っている途中（ready でない）は相手にも持ち主にも見せない */
export interface RoomRecording extends ShareRecording {
  ready: boolean
  uploadId?: string
  parts: Array<{ partNumber: number; etag: string }>
  /** 受け取った大きさ */
  received: number
  startedAt: number
}

export type RoomCommand =
  | { op: 'init'; meta: RoomMeta }
  | { op: 'update'; tokenHash: string; patch: { title?: string; urls?: ShareUrl[]; memo?: ShareMemo | null; auth?: ShareAuthVerifier | null } }
  | { op: 'snapshot'; tokenHash: string; now: number }
  | { op: 'gate'; now: number }
  | { op: 'verify'; proof: string; now: number }
  | { op: 'public'; now: number }
  | { op: 'start'; start: ShareRecordingStart; id: string; now: number }
  | { op: 'attach'; id: string; uploadId: string }
  | { op: 'part'; id: string; partNumber: number; size: number; now: number }
  | { op: 'partDone'; id: string; partNumber: number; etag: string }
  | { op: 'finishCheck'; id: string; now: number }
  | { op: 'ready'; id: string; notes: ShareRecording['notes']; hasThumbnail: boolean }
  | { op: 'abort'; id: string }
  | { op: 'media'; id: string; owner?: string; now: number }
  | { op: 'setStatus'; tokenHash: string; id: string; status: ShareRecordingStatus }
  | { op: 'deleteRecording'; tokenHash: string; id: string }
  | { op: 'destroy'; tokenHash: string }

/** 部屋の応答。失敗は code だけ */
export type RoomResult = { ok: true; [key: string]: unknown } | { ok: false; code: 'unauthorized' | 'not_found' | 'gone' | 'full' | 'too_large' | 'invalid_request' | 'conflict' | 'wrong_password' }

const META = 'meta'
const REC_PREFIX = 'r:'

/** 定時間の比較（長さが同じ 16 進の文字列） */
export function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** 録画の R2 の鍵（共有の下にまとめる。消すときは s/<shareId>/ を丸ごと） */
export const sharePrefix = (shareId: string) => `s/${shareId}/`
export const mediaKey = (shareId: string, id: string) => `s/${shareId}/${id}/media`
export const eventsKey = (shareId: string, id: string) => `s/${shareId}/${id}/events.json`
export const thumbKey = (shareId: string, id: string) => `s/${shareId}/${id}/thumb.jpg`

/** 相手に見せる録画の形（状態と送っている途中の値を除く） */
function publicRecording(r: RoomRecording): SharePublicRecording {
  const { id, createdAt, name, mode, mime, bytes, durationMs, hasVideo, hasThumbnail, startUrl, notes } = r
  return { id, createdAt, ...(name ? { name } : {}), mode, ...(mime ? { mime } : {}), bytes, durationMs, hasVideo, hasThumbnail, ...(startUrl ? { startUrl } : {}), notes }
}

function ownerRecording(r: RoomRecording): ShareRecording {
  return { ...publicRecording(r), status: r.status }
}

export class ShareRoom {
  constructor(private readonly state: RoomState, private readonly env: Pick<Env, 'MEDIA'>) {}

  async fetch(request: Request): Promise<Response> {
    let command: RoomCommand
    try {
      command = (await request.json()) as RoomCommand
    } catch {
      return Response.json({ ok: false, code: 'invalid_request' } satisfies RoomResult)
    }
    return Response.json(await this.run(command))
  }

  async run(command: RoomCommand): Promise<RoomResult> {
    const storage = this.state.storage
    if (command.op === 'init') {
      if (await storage.get<RoomMeta>(META)) return { ok: false, code: 'invalid_request' }
      await storage.put(META, command.meta)
      await storage.setAlarm(Date.parse(command.meta.expiresAt))
      return { ok: true }
    }
    const meta = await storage.get<RoomMeta>(META)
    if (!meta) return { ok: false, code: 'not_found' }
    const expired = (now: number) => now >= Date.parse(meta.expiresAt)
    const owner = (tokenHash: string) => sameHash(tokenHash, meta.tokenHash)

    switch (command.op) {
      case 'gate':
        if (expired(command.now)) return { ok: false, code: 'gone' }
        return { ok: true, protected: !!meta.auth, ...(meta.auth ? { salt: meta.auth.salt, iterations: meta.auth.iterations } : {}) }
      case 'verify': {
        if (expired(command.now)) return { ok: false, code: 'gone' }
        if (!meta.auth) return { ok: true }
        const hash = await sha256Hex(command.proof)
        return sameHash(hash, meta.auth.verifier) ? { ok: true } : { ok: false, code: 'wrong_password' }
      }
      case 'public': {
        if (expired(command.now)) return { ok: false, code: 'gone' }
        const recordings = [...(await this.recordings()).values()].filter((r) => r.ready && r.status !== 'rejected').map(publicRecording)
        return { ok: true, view: { locked: false, id: meta.id, title: meta.title, expiresAt: meta.expiresAt, protected: !!meta.auth, ...(meta.memo ? { memo: meta.memo } : {}), urls: meta.urls, recordings } }
      }
      case 'start': {
        if (expired(command.now)) return { ok: false, code: 'gone' }
        if (meta.received >= SHARE_LIMITS.recordings) return { ok: false, code: 'full' }
        if (meta.bytes + command.start.bytes > SHARE_LIMITS.shareBytes) return { ok: false, code: 'too_large' }
        const notesOnly = command.start.mode === 'notes'
        const recording: RoomRecording = {
          id: command.id, createdAt: new Date(command.now).toISOString(), ...command.start, hasThumbnail: false, notes: [], status: 'new',
          ready: false, parts: [], received: 0, startedAt: command.now
        }
        meta.received += 1
        meta.bytes += command.start.bytes
        await storage.put(this.recKey(meta, command.id), recording)
        await storage.put(META, meta)
        // 送り終わらない録画を片付けるため、期限より前に一度起こす
        await storage.setAlarm(Math.min(Date.parse(meta.expiresAt), command.now + PENDING_UPLOAD_MS))
        return { ok: true, key: mediaKey(meta.id, command.id), notesOnly, parts: notesOnly ? 0 : Math.ceil(command.start.bytes / SHARE_LIMITS.partBytes) }
      }
      case 'attach': {
        const found = await this.find(command.id)
        if (!found || found.rec.ready || found.rec.uploadId) return { ok: false, code: 'conflict' }
        await storage.put(found.key, { ...found.rec, uploadId: command.uploadId })
        return { ok: true }
      }
      case 'part': {
        if (expired(command.now)) return { ok: false, code: 'gone' }
        const found = await this.find(command.id)
        if (!found || found.rec.ready || !found.rec.uploadId) return { ok: false, code: 'not_found' }
        const { rec } = found
        const total = Math.ceil(rec.bytes / SHARE_LIMITS.partBytes)
        // 順に1回ずつ。最後以外はちょうど partBytes、最後は残り
        if (command.partNumber !== rec.parts.length + 1 || command.partNumber > total) return { ok: false, code: 'conflict' }
        const expected = command.partNumber < total ? SHARE_LIMITS.partBytes : rec.bytes - SHARE_LIMITS.partBytes * (total - 1)
        if (command.size !== expected) return { ok: false, code: 'invalid_request' }
        return { ok: true, key: mediaKey(meta.id, rec.id), uploadId: rec.uploadId, mime: rec.mime, first: command.partNumber === 1 }
      }
      case 'partDone': {
        const found = await this.find(command.id)
        if (!found || found.rec.ready || found.rec.parts.length + 1 !== command.partNumber) return { ok: false, code: 'conflict' }
        const parts = [...found.rec.parts, { partNumber: command.partNumber, etag: command.etag }]
        const size = command.partNumber < Math.ceil(found.rec.bytes / SHARE_LIMITS.partBytes) ? SHARE_LIMITS.partBytes : found.rec.bytes - found.rec.received
        await storage.put(found.key, { ...found.rec, parts, received: found.rec.received + size })
        return { ok: true }
      }
      case 'finishCheck': {
        // 全部の回を受け取ったか（R2 の multipart をまとめる前に確かめる。まだ見せない）
        if (expired(command.now)) return { ok: false, code: 'gone' }
        const found = await this.find(command.id)
        if (!found || found.rec.ready) return { ok: false, code: 'not_found' }
        const { rec } = found
        const total = rec.mode === 'notes' ? 0 : Math.ceil(rec.bytes / SHARE_LIMITS.partBytes)
        if (rec.parts.length !== total) return { ok: false, code: 'conflict' }
        return { ok: true, key: mediaKey(meta.id, rec.id), uploadId: rec.uploadId ?? null, parts: rec.parts, durationMs: rec.durationMs }
      }
      case 'ready': {
        // R2 でまとめ終えた。ここから相手と持ち主に見せる
        const found = await this.find(command.id)
        if (!found || found.rec.ready) return { ok: false, code: 'not_found' }
        const ready: RoomRecording = { ...found.rec, notes: command.notes, hasThumbnail: command.hasThumbnail, ready: true }
        delete ready.uploadId
        await storage.put(found.key, ready)
        return { ok: true }
      }
      case 'abort': {
        const found = await this.find(command.id)
        if (!found || found.rec.ready) return { ok: false, code: 'not_found' }
        await storage.delete(found.key)
        meta.bytes = Math.max(0, meta.bytes - found.rec.bytes)
        await storage.put(META, meta)
        return { ok: true, key: mediaKey(meta.id, found.rec.id), uploadId: found.rec.uploadId ?? null }
      }
      case 'media': {
        if (expired(command.now)) return { ok: false, code: 'gone' }
        const found = await this.find(command.id)
        const isOwner = command.owner !== undefined && owner(command.owner)
        if (!found || !found.rec.ready || (found.rec.status === 'rejected' && !isOwner)) return { ok: false, code: 'not_found' }
        return { ok: true, recording: ownerRecording(found.rec) }
      }
      case 'update': {
        if (!owner(command.tokenHash)) return { ok: false, code: 'unauthorized' }
        const { title, urls, memo, auth } = command.patch
        if (title !== undefined) meta.title = title
        if (urls !== undefined) meta.urls = urls
        if (memo !== undefined) {
          if (memo === null) delete meta.memo
          else meta.memo = memo
        }
        if (auth !== undefined) {
          if (auth === null) delete meta.auth
          else meta.auth = auth
        }
        // パスワードを外したのに暗号化したメモが残る・付けたのに平文のメモが残る、を作らない（アプリが両方そろえて送る）
        if (meta.memo?.kind === 'sealed' && !meta.auth) delete meta.memo
        await storage.put(META, meta)
        return { ok: true }
      }
      case 'snapshot': {
        if (!owner(command.tokenHash)) return { ok: false, code: 'unauthorized' }
        const snapshot: ShareSnapshot = {
          id: meta.id, title: meta.title, createdAt: meta.createdAt, expiresAt: meta.expiresAt, protected: !!meta.auth,
          ...(meta.memo ? { memo: meta.memo } : {}), urls: meta.urls,
          recordings: [...(await this.recordings()).values()].filter((r) => r.ready).map(ownerRecording)
        }
        return { ok: true, snapshot }
      }
      case 'setStatus': {
        if (!owner(command.tokenHash)) return { ok: false, code: 'unauthorized' }
        const found = await this.find(command.id)
        if (!found || !found.rec.ready) return { ok: false, code: 'not_found' }
        await storage.put(found.key, { ...found.rec, status: command.status })
        return { ok: true }
      }
      case 'deleteRecording': {
        if (!owner(command.tokenHash)) return { ok: false, code: 'unauthorized' }
        const found = await this.find(command.id)
        if (!found) return { ok: false, code: 'not_found' }
        await storage.delete(found.key)
        await this.removeMedia(meta.id, found.rec)
        return { ok: true }
      }
      case 'destroy': {
        if (!owner(command.tokenHash)) return { ok: false, code: 'unauthorized' }
        await this.wipe(meta)
        return { ok: true }
      }
      default:
        return { ok: false, code: 'invalid_request' }
    }
  }

  /** 期限が来たら、録画と記録をすべて消す。それより前なら、送り終わらない録画だけ片付ける */
  async alarm(): Promise<void> {
    const meta = await this.state.storage.get<RoomMeta>(META)
    if (!meta) {
      await this.state.storage.deleteAll()
      return
    }
    const now = Date.now()
    if (now >= Date.parse(meta.expiresAt)) {
      await this.wipe(meta)
      return
    }
    let pending = false
    for (const [key, rec] of await this.recordings()) {
      if (rec.ready) continue
      if (now - rec.startedAt < PENDING_UPLOAD_MS) {
        pending = true
        continue
      }
      await this.state.storage.delete(key)
      meta.bytes = Math.max(0, meta.bytes - rec.bytes)
      await this.removeMedia(meta.id, rec)
    }
    await this.state.storage.put(META, meta)
    await this.state.storage.setAlarm(pending ? Math.min(Date.parse(meta.expiresAt), now + PENDING_UPLOAD_MS) : Date.parse(meta.expiresAt))
  }

  private recKey(meta: RoomMeta, id: string): string {
    return `${REC_PREFIX}${String(meta.received).padStart(6, '0')}:${id}`
  }

  private recordings(): Promise<Map<string, RoomRecording>> {
    return this.state.storage.list<RoomRecording>({ prefix: REC_PREFIX })
  }

  private async find(id: string): Promise<{ key: string; rec: RoomRecording } | null> {
    for (const [key, rec] of await this.recordings()) {
      if (rec.id === id) return { key, rec }
    }
    return null
  }

  /** 録画1本の R2 のもの（送っている途中なら multipart を取りやめる） */
  private async removeMedia(shareId: string, rec: RoomRecording): Promise<void> {
    if (rec.uploadId) await this.env.MEDIA.resumeMultipartUpload(mediaKey(shareId, rec.id), rec.uploadId).abort().catch(() => undefined)
    await this.env.MEDIA.delete([mediaKey(shareId, rec.id), eventsKey(shareId, rec.id), thumbKey(shareId, rec.id)]).catch(() => undefined)
  }

  /** 共有の R2 のもの（s/<id>/ の下）と記録をすべて消す */
  private async wipe(meta: RoomMeta): Promise<void> {
    for (const rec of (await this.recordings()).values()) {
      if (rec.uploadId) await this.env.MEDIA.resumeMultipartUpload(mediaKey(meta.id, rec.id), rec.uploadId).abort().catch(() => undefined)
    }
    let cursor: string | undefined
    for (let round = 0; round < 50; round++) {
      const listed = await this.env.MEDIA.list({ prefix: sharePrefix(meta.id), ...(cursor ? { cursor } : {}), limit: 1000 }).catch(() => null)
      if (!listed) break
      if (listed.objects.length) await this.env.MEDIA.delete(listed.objects.map((o) => o.key)).catch(() => undefined)
      if (!listed.truncated || !listed.cursor) break
      cursor = listed.cursor
    }
    await this.state.storage.deleteAll()
  }
}
