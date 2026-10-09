import { ANNOTATION_COLORS, type AnnotationColor } from './annotation'
import type { Shape } from './annotationShapes'

/**
 * 書き込み（手書きの線・四角の枠）の見た目。アプリの注入スクリプト（preload/review.ts）と、
 * 共有リンクの相手の画面（workers/feedback-share/client）の両方がこれで描く（同じ見た目にする）。
 *
 * 白いページでも暗いページでも読めるよう、選んだ色の線の下に白い縁を敷く。色は利用者が選ぶ（src/shared/annotation.ts）。
 * DOM の canvas の 2D の文脈だけを使う（Electron に依存しない）。
 */

export const PEN_HALO = 'rgba(255, 255, 255, 0.9)'
export const PEN_WIDTH = 4
export const PEN_HALO_WIDTH = PEN_WIDTH + 4

/** ペンのカーソル。選んだ色の点に白い縁（中心が描く位置）。読めない環境では crosshair */
export function penCursor(color: AnnotationColor): string {
  const fill = encodeURIComponent(ANNOTATION_COLORS[color])
  return "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E" +
    `%3Ccircle cx='10' cy='10' r='5' fill='${fill}' stroke='white' stroke-width='2'/%3E%3C/svg%3E\") 10 10, crosshair`
}

/** 線の端と角を丸くする（canvas の大きさを変えたあとに呼ぶ） */
export function preparePenContext(ctx: CanvasRenderingContext2D): void {
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = PEN_WIDTH
}

/** 形の輪郭をパスにする */
function tracePath(ctx: CanvasRenderingContext2D, shape: Shape): void {
  ctx.beginPath()
  if (shape.kind === 'rect') {
    const [x, y, w, h] = shape.rect
    ctx.rect(x, y, w, h)
    return
  }
  const [first, ...rest] = shape.points
  if (!first) return
  ctx.moveTo(first[0], first[1])
  // 点を打っただけでも丸く見えるようにする
  if (rest.length === 0) ctx.lineTo(first[0], first[1])
  for (const [x, y] of rest) ctx.lineTo(x, y)
}

/** 形を、白い縁 → その形の色の順で描く */
export function paintShape(ctx: CanvasRenderingContext2D, shape: Shape): void {
  tracePath(ctx, shape)
  ctx.strokeStyle = PEN_HALO
  ctx.lineWidth = PEN_HALO_WIDTH
  ctx.stroke()
  ctx.strokeStyle = ANNOTATION_COLORS[shape.color]
  ctx.lineWidth = PEN_WIDTH
  ctx.stroke()
}
