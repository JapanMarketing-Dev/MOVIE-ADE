import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, open, unlink } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { VerifiedDownload } from './updateCheck'

/**
 * 更新の「ダウンロード」（security-4 [7]）。
 *
 * 更新の確認で署名を確かめた版・名前・sha256 を、そのまま使ってアプリが落とす。ブラウザでダウンロードページを
 * 開き直すと、ページは R2 をもう一度読むので、確かめたあとに書き換えられた中身を選びうる。
 * 落とした中身は、大きさと sha256 が確かめた値と同じときだけ、ダウンロードのフォルダに置く。
 * 違えば一時ファイルを消して断る（途中のものを利用者に見せない）。
 */

export class UpdateDownloadError extends Error {
  constructor(readonly reason: 'http' | 'size' | 'digest') {
    super(`update download failed: ${reason}`)
    this.name = 'UpdateDownloadError'
  }
}

/** 同じ名前があれば「名前 (1).dmg」のようにずらす。link は既にあれば失敗するので上書きしない */
async function placeUnique(temp: string, dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 0; i < 100; i++) {
    const target = join(dir, i === 0 ? name : `${stem} (${i})${ext}`)
    try {
      await link(temp, target)
      return target
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EEXIST') continue
      // ハードリンクを作れないファイルシステム（FAT など）では、上書きしない写しにする
      try {
        await copyFile(temp, target, constants.COPYFILE_EXCL)
        return target
      } catch (copyErr) {
        if ((copyErr as NodeJS.ErrnoException).code !== 'EEXIST') throw copyErr
      }
    }
  }
  throw new Error('no free file name')
}

/**
 * file を dir に落とし、確かめた sha256 と大きさが合えば置いたパスを返す。
 * name は署名した SHA256SUMS の、決まった形（Ferret-<版>-<os>-<arch>.<ext>）の名前なのでパスの区切りを含まない
 */
export async function downloadVerifiedUpdate(file: VerifiedDownload, dir: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<string> {
  const res = await fetcher(file.url, { signal })
  if (!res.ok || !res.body) throw new UpdateDownloadError('http')
  const declared = Number(res.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared !== file.size) throw new UpdateDownloadError('size')
  const temp = join(dir, `.${file.name}.${randomBytes(6).toString('hex')}.part`)
  // AppImage はそのまま実行できるよう実行の権限を付ける
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, file.kind === 'AppImage' ? 0o755 : 0o644)
  let ok = false
  try {
    const hash = createHash('sha256')
    let total = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > file.size) {
        await reader.cancel().catch(() => undefined)
        throw new UpdateDownloadError('size')
      }
      hash.update(value)
      await handle.write(value)
    }
    if (total !== file.size) throw new UpdateDownloadError('size')
    if (hash.digest('hex') !== file.sha256) throw new UpdateDownloadError('digest')
    await handle.close()
    const placed = await placeUnique(temp, dir, file.name)
    ok = true
    return placed
  } finally {
    if (!ok) await handle.close().catch(() => undefined)
    await unlink(temp).catch(() => undefined)
  }
}
