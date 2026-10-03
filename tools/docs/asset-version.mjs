// サイトの CSS / JS に付ける版（中身の sha256 の先頭8文字）。
// Cloudflare のゾーン設定（Browser Cache TTL）が _headers の短いキャッシュを上書きするので、
// 参照に ?v=<版> を付けて、中身が変わったら別の URL として読ませる。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SITE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../site')

/** site/ からの相対パス（例: 'style.css'、'js/app.js'）→ 版 */
export function assetVersion(rel) {
  return createHash('sha256').update(readFileSync(join(SITE_DIR, rel))).digest('hex').slice(0, 8)
}

/** モジュールが import するファイル。版を付けた import を書き込んでから、そのファイル自身の版を取る（葉から順に） */
export const MODULE_IMPORTS = [
  ['js/releases.js', ['config.js']],
  ['js/app.js', ['config.js', 'releases.js']],
]
