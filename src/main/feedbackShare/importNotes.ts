/**
 * 共有リンクに届いた指摘を、Ferret の「文字で指摘」と同じ形（枠 + 静止画 + 文）にする。Electron に依存しない純粋な処理。
 * 取り込んだあとは review.ts の addTextNote でレビューに足す（BEFORE はページの静止画に枠を重ねたもの）。
 */
import { commentNoteText, shapeToBox, type ShareComment, type SharePage, type ShareSnapshot } from '@shared/feedbackShare'
import type { NotePage, TextNote } from '../sessions/notes'
import { sanitizeTextNote } from '../sessions/notes'

export interface ImportPlanItem {
  comment: ShareComment
  page: SharePage
  note: TextNote
  notePage: NotePage
}

/**
 * 選んだ指摘を取り込む順（送られた順）に並べ、文字で指摘の値にする。
 * 断ったもの・取り込み済みのもの・ページの無いものは除く（同じ指摘を2回取り込まない）
 */
export function planImport(snapshot: Pick<ShareSnapshot, 'pages' | 'comments'>, commentIds: readonly string[]): ImportPlanItem[] {
  const wanted = new Set(commentIds)
  const pages = new Map(snapshot.pages.map((p) => [p.id, p]))
  return snapshot.comments.flatMap((comment) => {
    if (!wanted.has(comment.id) || comment.status !== 'new') return []
    const page = pages.get(comment.pageId)
    if (!page) return []
    // ライブで打ったピンは、元のページの画面の上の位置で、静止画とは縦の位置が合わないことがある。静止画全体を示す枠にする
    const box = comment.live ? shapeToBox(undefined, page.width, page.height) : shapeToBox(comment.shape, page.width, page.height)
    const note = sanitizeTextNote({ text: commentNoteText(comment, page), bbox: box, view: { width: page.width, height: page.height } })
    if (!note) return []
    return [{ comment, page, note, notePage: { url: comment.live?.url ?? page.url, title: page.title } }]
  })
}
