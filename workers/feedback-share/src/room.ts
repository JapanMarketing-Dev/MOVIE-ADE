/**
 * 共有1つの部屋（Durable Object）。共有の中身（題名・ページ・指摘）と持ち主のトークンのハッシュを持つ。
 * Worker からだけ fetch（JSON の命令）で呼ばれる。1つの部屋の要求は1つずつ処理されるので、数の上限を確実に守れる。
 *
 * - 持ち主の命令はトークンのハッシュを付けて送られ、ここで定時間で比べる
 * - 期限（expiresAt）で alarm が鳴り、静止画（R2）と記録をすべて消す
 * - 指摘は1件ずつ別の鍵（c:<連番>:<id>）に置く（1つの値の大きさの上限に当たらないように）
 */
import {
  SHARE_LIMITS,
  type ShareComment,
  type ShareCommentInput,
  type ShareCommentStatus,
  type SharePage,
  type SharePublicView,
  type ShareSnapshot
} from '../../../src/shared/feedbackShare'
import type { Env, RoomState } from './env'

export interface RoomMeta {
  id: string
  title: string
  createdAt: string
  expiresAt: string
  showOthers: boolean
  /** ownerToken の SHA-256（16 進） */
  tokenHash: string
  pages: SharePage[]
  /** 受け付けた指摘の数（断った・消したものも数える。上限の判定に使う） */
  received: number
}

export type RoomCommand =
  | { op: 'init'; meta: RoomMeta }
  | { op: 'addPage'; tokenHash: string; page: SharePage }
  | { op: 'snapshot'; tokenHash: string; now: number }
  | { op: 'public'; now: number }
  | { op: 'page'; pageId: string; now: number }
  | { op: 'addComment'; input: ShareCommentInput; id: string; now: number }
  | { op: 'setStatus'; tokenHash: string; commentId: string; status: ShareCommentStatus }
  | { op: 'deleteComment'; tokenHash: string; commentId: string }
  | { op: 'destroy'; tokenHash: string }

/** 部屋の応答。失敗は code だけ */
export type RoomResult = { ok: true; [key: string]: unknown } | { ok: false; code: 'unauthorized' | 'not_found' | 'gone' | 'full' | 'invalid_request' }

const META = 'meta'
const COMMENT_PREFIX = 'c:'

/** 定時間の比較（長さが同じ 16 進の文字列） */
export function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
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
      case 'public': {
        if (expired(command.now)) return { ok: false, code: 'gone' }
        const comments = meta.showOthers ? [...(await this.comments()).values()].filter((c) => c.status !== 'rejected') : []
        const view: SharePublicView = {
          id: meta.id, title: meta.title, expiresAt: meta.expiresAt, showOthers: meta.showOthers, pages: meta.pages,
          comments: comments.map(({ id, pageId, createdAt, name, text, shape }) => ({ id, pageId, createdAt, ...(name ? { name } : {}), text, ...(shape ? { shape } : {}) }))
        }
        return { ok: true, view }
      }
      case 'page': {
        if (expired(command.now)) return { ok: false, code: 'gone' }
        const page = meta.pages.find((p) => p.id === command.pageId)
        return page ? { ok: true, page } : { ok: false, code: 'not_found' }
      }
      case 'addComment': {
        if (expired(command.now)) return { ok: false, code: 'gone' }
        if (!meta.pages.some((p) => p.id === command.input.pageId)) return { ok: false, code: 'not_found' }
        if (meta.received >= SHARE_LIMITS.comments) return { ok: false, code: 'full' }
        const comment: ShareComment = { id: command.id, createdAt: new Date(command.now).toISOString(), status: 'new', ...command.input }
        meta.received += 1
        await storage.put(`${COMMENT_PREFIX}${String(meta.received).padStart(6, '0')}:${comment.id}`, comment)
        await storage.put(META, meta)
        return { ok: true, id: comment.id }
      }
      case 'addPage': {
        if (!owner(command.tokenHash)) return { ok: false, code: 'unauthorized' }
        if (meta.pages.length >= SHARE_LIMITS.pages) return { ok: false, code: 'full' }
        meta.pages.push(command.page)
        await storage.put(META, meta)
        return { ok: true }
      }
      case 'snapshot': {
        if (!owner(command.tokenHash)) return { ok: false, code: 'unauthorized' }
        const snapshot: ShareSnapshot = {
          id: meta.id, title: meta.title, createdAt: meta.createdAt, expiresAt: meta.expiresAt, showOthers: meta.showOthers,
          pages: meta.pages, comments: [...(await this.comments()).values()]
        }
        return { ok: true, snapshot }
      }
      case 'setStatus': {
        if (!owner(command.tokenHash)) return { ok: false, code: 'unauthorized' }
        const found = await this.find(command.commentId)
        if (!found) return { ok: false, code: 'not_found' }
        await storage.put(found.key, { ...found.comment, status: command.status })
        return { ok: true }
      }
      case 'deleteComment': {
        if (!owner(command.tokenHash)) return { ok: false, code: 'unauthorized' }
        const found = await this.find(command.commentId)
        if (!found) return { ok: false, code: 'not_found' }
        await storage.delete(found.key)
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

  /** 期限が来たら、静止画と記録をすべて消す */
  async alarm(): Promise<void> {
    const meta = await this.state.storage.get<RoomMeta>(META)
    if (!meta) {
      await this.state.storage.deleteAll()
      return
    }
    if (Date.now() < Date.parse(meta.expiresAt)) {
      await this.state.storage.setAlarm(Date.parse(meta.expiresAt))
      return
    }
    await this.wipe(meta)
  }

  private async wipe(meta: RoomMeta): Promise<void> {
    await Promise.allSettled(meta.pages.map((p) => this.env.MEDIA.delete(pageMediaKey(meta.id, p))))
    await this.state.storage.deleteAll()
  }

  private comments(): Promise<Map<string, ShareComment>> {
    return this.state.storage.list<ShareComment>({ prefix: COMMENT_PREFIX })
  }

  private async find(id: string): Promise<{ key: string; comment: ShareComment } | null> {
    for (const [key, comment] of await this.comments()) {
      if (comment.id === id) return { key, comment }
    }
    return null
  }
}

/** ページの静止画の R2 の鍵 */
export function pageMediaKey(shareId: string, page: Pick<SharePage, 'id' | 'ext'>): string {
  return `s/${shareId}/${page.id}.${page.ext}`
}
