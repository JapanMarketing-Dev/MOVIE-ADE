/**
 * Office のプレビューの HTML に共通の部品（画像・色・大きさ・ページの枠）。
 * 出す HTML はスクリプトを持たず、文字はすべて escapeHtml を通す。画像は data: の URL にして埋め込む
 * （表示は sandbox の iframe。外へは何も読みに行かない）。
 */
import type { ZipArchive } from './zip'
import { escapeHtml } from './xml'

/** 1px の EMU（English Metric Unit。914400 EMU = 1 inch = 96px） */
export const EMU_PER_PX = 9525

export function emuToPx(value: string | number | undefined): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n / EMU_PER_PX : 0
}

/** 埋め込む画像1枚の上限。超えたら枠だけ出す */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp',
  webp: 'image/webp', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff', ico: 'image/x-icon'
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step))
  return btoa(binary)
}

/** 部品の画像を data: の URL に。画像でない（EMF・WMF など描けない形式）・大きすぎるものは null */
export async function imageDataUrl(zip: ZipArchive, part: string, cache: Map<string, string | null>): Promise<string | null> {
  if (cache.has(part)) return cache.get(part)!
  const ext = part.slice(part.lastIndexOf('.') + 1).toLowerCase()
  const type = IMAGE_TYPES[ext]
  let url: string | null = null
  if (type) {
    const bytes = await zip.bytes(part).catch(() => null)
    if (bytes && bytes.length <= MAX_IMAGE_BYTES) url = `data:${type};base64,${base64(bytes)}`
  }
  cache.set(part, url)
  return url
}

/** 6桁の16進数の色だけを CSS の色に（auto・テーマ色の名前などは null） */
export function hexColor(value: string | undefined): string | null {
  return value && /^[0-9a-fA-F]{6}$/.test(value) ? `#${value.toLowerCase()}` : null
}

/** 描けない画像の代わりの枠 */
export function imagePlaceholder(width: number, height: number, label: string): string {
  const w = Math.max(24, Math.round(width))
  const h = Math.max(16, Math.round(height))
  return `<span class="ofc-missing" style="width:${w}px;height:${h}px">${escapeHtml(label)}</span>`
}

const BASE_CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:#e8e8ea;color:#1f1f1f;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Noto Sans CJK JP",Meiryo,sans-serif;-webkit-font-smoothing:antialiased}
img{max-width:100%}
.ofc-missing{display:inline-flex;align-items:center;justify-content:center;border:1px dashed #9a9a9a;color:#777;font-size:11px;background:#f6f6f6;overflow:hidden;vertical-align:middle}
.ofc-note{max-width:900px;margin:16px auto 0;padding:8px 12px;border-radius:6px;background:#fff7d6;color:#5c4a00;font-size:12px}
`

/** 表示するページ全体。css はその形式の分 */
export function officeHtml(title: string, css: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${escapeHtml(title)}</title><style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`
}
