/**
 * 共有リンク（ログイン無しで誰でも指摘を送れる）の IPC ハンドラ。index.ts の registerIpc の dispatcher に混ぜて登録する
 * （アプリの窓の本体のフレームからだけ受ける。security-5 [1]）。
 *
 * - 共有を作る・ページを足すときは、利用者がボタンを押した直後の1回だけ、いま表示中の内蔵ブラウザのタブを撮って上げる
 *   （撮るのは index.ts の snapshotPage。gestures の screenshot を使う。ページのスクリプトや IPC だけでは撮れない）。
 *   上げるのは http(s) のページだけ（手元のファイルは上げない）
 * - 持ち主のトークンは main だけが持つ（store.ts）。画面へは題名・URL・期限・指摘と、ページの静止画（data URL）だけを返す
 * - 取り込んだ指摘は「文字で指摘」と同じ形でレビューに足す（review.ts の addTextNote）。以後は Agent へ渡し、BEFORE/AFTER を人が確かめる
 */
import { nativeImage, safeStorage } from 'electron'
import { join } from 'node:path'
import type { IpcRequests } from '@shared/ipc'
import { SHARE_LIMITS, cleanText, type ShareCommentStatus, type ShareViewport } from '@shared/feedbackShare'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import type { ReviewData } from '@shared/review'
import { ShareApiError, ShareClient, type ShareFetch } from './client'
import type { ShareStore } from './store'

/** 上げるページの静止画と、その URL・題名・表示の大きさ（CSS ピクセル） */
export interface CapturedPage {
  url: string
  title: string
  viewport: ShareViewport
  width: number
  height: number
  image: Uint8Array
  type: 'image/jpeg' | 'image/png'
}

type Channel = 'share:list' | 'share:create' | 'share:addPage' | 'share:open' | 'share:setStatus' | 'share:import' | 'share:delete'

export interface FeedbackShareDeps {
  projectId: () => string | null
  projectDir: () => string | null
  /**
   * 利用者がアプリの窓で押した直後の1回だけ、いま表示中の内蔵ブラウザのタブ（http(s) のページ）を撮る（index.ts。撮る処理は決めた場所にだけ置く。
   * security-5 [1]）。撮れなければ UserFacingError
   */
  snapshotPage: () => Promise<CapturedPage>
  fetch: ShareFetch
  /** Worker の場所。省略時は share.ferretade.dev（開発版だけ手元の Worker に向けられる。index.ts） */
  base?: string
  userAgent: string
  installId: () => string | null
  userDataDir: () => string
  isPackaged: boolean
  isE2E: boolean
  /** 文字で指摘と同じくレビューに足す（review.ts の addTextNote。urlPresets も index.ts が付ける） */
  addNote: (projectDir: string, reviewId: string | null, request: { id: string; note: import('../sessions/notes').TextNote; image: { png: Uint8Array; size: { width: number; height: number } } | null; page?: import('../sessions/notes').NotePage }) => Promise<{ review: ReviewData; count: number }>
  onAdded: (result: { review: ReviewData; count: number }) => void
}

export function feedbackShareHandlers(deps: FeedbackShareDeps): { [C in Channel]: (...args: Parameters<IpcRequests[C]>) => unknown } {
  const client = new ShareClient({ fetch: deps.fetch, userAgent: deps.userAgent, ...(deps.base ? { base: deps.base } : {}) })
  let store: ShareStore | null = null
  const shares = async (): Promise<ShareStore> => {
    if (!store) {
      const [{ ShareStore: Store }, { chooseKeyCipher }] = await Promise.all([import('./store'), import('../pipeline/stt/keys')])
      store = new Store(join(deps.userDataDir(), 'feedback-share', 'shares.bin'), chooseKeyCipher({ isPackaged: deps.isPackaged, isE2E: deps.isE2E, safeStorage }))
    }
    return store
  }
  const project = (): string => {
    const id = deps.projectId()
    if (!id) throw new UserFacingError(t('errors.openProjectFolder'))
    return id
  }
  const owned = async (shareId: unknown) => {
    if (typeof shareId !== 'string') throw new UserFacingError(t('share.errors.notFound'))
    const share = await (await shares()).get(project(), shareId)
    if (!share) throw new UserFacingError(t('share.errors.notFound'))
    return share
  }
  /** Worker の失敗を、利用者に見せる文にする（トークン・本文は出さない） */
  const friendly = async <T>(work: () => Promise<T>, shareId?: string): Promise<T> => {
    try {
      return await work()
    } catch (err) {
      if (!(err instanceof ShareApiError)) throw err
      // 期限切れ・消えた共有は控えからも消す
      if (shareId && (err.code === 'gone' || err.code === 'not_found' || err.code === 'unauthorized')) await (await shares()).remove(shareId).catch(() => undefined)
      const key = err.code === 'network' ? 'share.errors.network'
        : err.code === 'rate_limited' ? 'share.errors.rateLimited'
          : err.code === 'gone' || err.code === 'not_found' || err.code === 'unauthorized' ? 'share.errors.notFound'
            : err.code === 'full' ? 'share.errors.full'
              : err.code === 'too_large' || err.code === 'bad_image' ? 'share.errors.image' : 'share.errors.failed'
      throw new UserFacingError(t(key))
    }
  }
  return {
    'share:list': async () => {
      const store = await shares()
      return { shares: deps.projectId() ? await store.list(deps.projectId()!) : [], persisted: store.persisted() }
    },
    'share:create': async (input) => {
      const projectId = project()
      const raw = (input ?? {}) as { title?: unknown; showOthers?: unknown }
      const title = cleanText(raw.title ?? '', SHARE_LIMITS.titleChars) ?? ''
      // 撮るのを先に（押した直後の許可を使う）。撮れなければ共有も作らない
      const page = await deps.snapshotPage()
      return friendly(async () => {
        const created = await client.create({ title: title || page.title, showOthers: raw.showOthers === true, ...(deps.installId() ? { installId: deps.installId()! } : {}) })
        const store = await shares()
        await store.add({ id: created.id, projectId, title: title || page.title, url: created.url, createdAt: new Date().toISOString(), expiresAt: created.expiresAt, ownerToken: created.ownerToken })
        await client.addPage(created.id, created.ownerToken, page)
        return (await store.list(projectId)).find((s) => s.id === created.id)!
      })
    },
    'share:addPage': async (shareId) => {
      const share = await owned(shareId)
      const page = await deps.snapshotPage()
      return friendly(() => client.addPage(share.id, share.ownerToken, page), share.id)
    },
    'share:open': async (shareId) => {
      const share = await owned(shareId)
      return friendly(async () => {
        const snapshot = await client.snapshot(share.id, share.ownerToken)
        const images: Record<string, string> = {}
        await Promise.all(snapshot.pages.map(async (page) => {
          const bytes = await client.pageImage(share.id, page)
          if (bytes) images[page.id] = `data:${page.ext === 'png' ? 'image/png' : 'image/jpeg'};base64,${Buffer.from(bytes).toString('base64')}`
        }))
        return { snapshot, images }
      }, share.id)
    },
    'share:setStatus': async (shareId, commentId, status) => {
      const share = await owned(shareId)
      if (typeof commentId !== 'string' || (status !== 'new' && status !== 'rejected')) throw new UserFacingError(t('share.errors.failed'))
      await friendly(() => client.setStatus(share.id, share.ownerToken, commentId, status as ShareCommentStatus), share.id)
    },
    'share:import': async (shareId, commentIds) => {
      const share = await owned(shareId)
      const dir = deps.projectDir()
      if (!dir) throw new UserFacingError(t('errors.openProjectFolder'))
      if (!Array.isArray(commentIds) || commentIds.length === 0 || commentIds.length > SHARE_LIMITS.comments || !commentIds.every((id) => typeof id === 'string')) {
        throw new UserFacingError(t('share.errors.failed'))
      }
      return friendly(async () => {
        // 取り込みの処理（レビューの部品）は使うときに読む（起動を遅くしない）
        const [{ planImport }, { newNoteId }] = await Promise.all([import('./importNotes'), import('../sessions/notes')])
        const snapshot = await client.snapshot(share.id, share.ownerToken)
        const plan = planImport(snapshot, commentIds as string[])
        if (plan.length === 0) return null
        // ページの静止画は1回だけ取り、PNG にして使い回す（レビューの静止画は PNG）
        const pngs = new Map<string, { png: Uint8Array; size: { width: number; height: number } } | null>()
        for (const item of plan) {
          if (pngs.has(item.page.id)) continue
          const bytes = await client.pageImage(share.id, item.page)
          const image = bytes ? nativeImage.createFromBuffer(Buffer.from(bytes)) : null
          pngs.set(item.page.id, image && !image.isEmpty() ? { png: new Uint8Array(image.toPNG()), size: image.getSize() } : null)
        }
        let reviewId: string | null = null
        let result: { review: ReviewData; count: number } | null = null
        for (const item of plan) {
          result = await deps.addNote(dir, reviewId, { id: newNoteId(), note: item.note, image: pngs.get(item.page.id) ?? null, page: item.notePage })
          reviewId = result.review.id
          // 取り込んだ印を付ける（失敗しても取り込みは済んでいる。次に開いたときにまた選べる）
          await client.setStatus(share.id, share.ownerToken, item.comment.id, 'imported').catch(() => undefined)
        }
        if (result) deps.onAdded(result)
        return result
      }, share.id)
    },
    'share:delete': async (shareId) => {
      const share = await owned(shareId)
      try {
        await client.remove(share.id, share.ownerToken)
      } catch (err) {
        // 期限切れなどで Worker に無いものは、控えから消せば済む。通信の失敗などは知らせる（Worker に残したまま控えだけ消さない）
        const missing = err instanceof ShareApiError && (err.code === 'gone' || err.code === 'not_found' || err.code === 'unauthorized')
        if (!missing) return friendly(() => Promise.reject(err))
      }
      await (await shares()).remove(share.id)
    }
  }
}
