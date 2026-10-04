/**
 * プレビュー（ade-preview://）で markdown から参照される画像を、プロジェクトの中から返す。
 * electron-vite の読み込み（?asset / ?raw）を持たない小さなモジュールに分け、単体テストから直接呼べるようにしている
 */
import { resolveInside } from '../files'
import { assertHandleInside } from '../containedFile'
import { FileTooLargeError, readFileBounded } from '../boundedFile'

/** markdown から参照される画像の大きさの上限（README のスクリーンショットでも数 MB。それを超えるものは出さない） */
export const PREVIEW_IMAGE_MAX_BYTES = 20 * 1024 * 1024

/** 画像として返す拡張子 */
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

/** 拡張子から画像の種類。画像でなければ undefined */
export function previewImageType(path: string): string | undefined {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? undefined : IMAGE_TYPES[path.slice(dot).toLowerCase()]
}

/**
 * 画像の中身と状態。大きさに上限を置き、普通のファイルだけを読む
 * （疎な・巨大なファイルやパイプで main が止まらないように。boundedFile.ts）
 */
export async function readPreviewImage(root: string, path: string): Promise<{ status: 200; body: Buffer } | { status: 404 | 413 }> {
  try {
    const file = await resolveInside(root, path)
    // 開いたものがプロジェクトの中の実体かを確かめてから読む（security-4 [5]）
    return { status: 200, body: await readFileBounded(file, PREVIEW_IMAGE_MAX_BYTES, { afterOpen: (handle) => assertHandleInside(handle, root, file) }) }
  } catch (err) {
    if (err instanceof FileTooLargeError) return { status: 413 }
    // 無い画像・プロジェクトの外を指す画像・普通のファイルでないもの（想定内）
    return { status: 404 }
  }
}
