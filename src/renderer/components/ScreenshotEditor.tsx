import { useEffect, useRef, useState } from 'react'
import { CircleAlert, Eraser, Undo2, X } from 'lucide-react'
import { MAX_IMAGE_BYTES } from '@shared/feedbackRelay'
import { displayToImage, rectFromDrag, type Rect } from '@shared/screenshotMask'
import { Button, IconButton, Modal } from '../ui'
import { useT } from '../lib/i18n'

/**
 * フィードバックに添える画面の静止画を、送る前に大きく見せて塗りつぶす画面。
 * 既定でターミナル・プロジェクト名・URL・ファイルの一覧は塗ってあり（shared/screenshotMask の DEFAULT_MASK_SELECTORS）、
 * ドラッグで黒い矩形を足せる。描くのは canvas。塗った画像だけを送る（元の画像は送らない）。
 */

export interface MaskedImage {
  /** 撮ったままの画像（送らない。塗り直すときに使う） */
  raw: { type: 'image/png' | 'image/jpeg'; base64: string; width: number; height: number }
  masks: Rect[]
  /** 塗った結果（送るのはこちら） */
  output: { type: 'image/png' | 'image/jpeg'; base64: string }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = src
  })
}

function paint(ctx: CanvasRenderingContext2D, img: HTMLImageElement, masks: readonly Rect[]): void {
  ctx.drawImage(img, 0, 0)
  ctx.fillStyle = '#000'
  for (const m of masks) ctx.fillRect(m.x, m.y, m.width, m.height)
}

/** 塗った画像を作る。PNG が 2MB を超えるときは JPEG にする */
export async function renderMasked(raw: MaskedImage['raw'], masks: readonly Rect[]): Promise<MaskedImage['output']> {
  const img = await loadImage(`data:${raw.type};base64,${raw.base64}`)
  const canvas = document.createElement('canvas')
  canvas.width = raw.width
  canvas.height = raw.height
  paint(canvas.getContext('2d')!, img, masks)
  const png = canvas.toDataURL('image/png').split(',')[1]!
  if (png.length * 0.75 <= MAX_IMAGE_BYTES) return { type: 'image/png', base64: png }
  return { type: 'image/jpeg', base64: canvas.toDataURL('image/jpeg', 0.85).split(',')[1]! }
}

export function ScreenshotEditor({ image, index, onDone, onDiscard }: {
  image: MaskedImage
  index: number
  onDone: (next: MaskedImage) => void
  onDiscard: () => void
}) {
  const t = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [masks, setMasks] = useState<Rect[]>(image.masks)
  const [drag, setDrag] = useState<{ start: { x: number; y: number }; end: { x: number; y: number } } | null>(null)
  const [saving, setSaving] = useState(false)
  const size = { width: image.raw.width, height: image.raw.height }

  useEffect(() => {
    let alive = true
    void loadImage(`data:${image.raw.type};base64,${image.raw.base64}`).then((img) => { if (alive) { imgRef.current = img; setMasks((m) => [...m]) } })
    return () => { alive = false }
  }, [image.raw])

  // 塗った範囲と、引いている途中の矩形を描き直す
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    const img = imgRef.current
    if (!ctx || !img) return
    paint(ctx, img, masks)
    const pending = drag ? rectFromDrag(drag.start, drag.end, size, 1) : null
    if (pending) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
      ctx.fillRect(pending.x, pending.y, pending.width, pending.height)
    }
  }, [masks, drag]) // eslint-disable-line react-hooks/exhaustive-deps

  const pointAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    return displayToImage({ x: e.clientX - box.left, y: e.clientY - box.top }, { width: box.width, height: box.height }, size)
  }

  const finish = async () => {
    setSaving(true)
    try {
      onDone({ ...image, masks, output: await renderMasked(image.raw, masks) })
    } finally {
      setSaving(false)
    }
  }

  return <Modal className="rv-modal" label={t('feedback.screenshot.title')} onClose={() => !saving && void finish()}>
    <div className="gh-send screenshot-editor" data-testid="screenshot-editor">
      <header className="gh-send__head">
        <h2>{t('feedback.screenshot.title')}</h2>
        <IconButton label={t('feedback.close')} icon={<X size={16} />} disabled={saving} onClick={() => void finish()} />
      </header>
      <p className="gh-send__confirm"><CircleAlert size={13} aria-hidden="true" />{t('feedback.screenshot.warning')}</p>
      <p className="st-note">{t('feedback.screenshot.hint')}</p>
      <canvas ref={canvasRef} width={size.width} height={size.height} className="screenshot-editor__canvas" data-testid="screenshot-canvas"
        aria-label={t('feedback.screenshot.edit', { n: index + 1 })}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); const p = pointAt(e); setDrag({ start: p, end: p }) }}
        onPointerMove={(e) => { if (drag) setDrag({ ...drag, end: pointAt(e) }) }}
        onPointerUp={(e) => {
          if (!drag) return
          const rect = rectFromDrag(drag.start, pointAt(e), size)
          setDrag(null)
          if (rect) setMasks((prev) => [...prev, rect])
        }} />
      <footer className="gh-send__foot feedback__foot">
        <div className="feedback__other">
          <Button variant="ghost" icon={<Undo2 size={13} />} disabled={saving || masks.length === 0} onClick={() => setMasks((prev) => prev.slice(0, -1))}>{t('feedback.screenshot.undo')}</Button>
          <Button variant="ghost" icon={<Eraser size={13} />} disabled={saving} onClick={onDiscard} data-testid="screenshot-discard">{t('feedback.screenshot.discard')}</Button>
        </div>
        <Button variant="primary" busy={saving} onClick={() => void finish()} data-testid="screenshot-done">{t('feedback.screenshot.done')}</Button>
      </footer>
    </div>
  </Modal>
}
