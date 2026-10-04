import { app, autoUpdater, shell } from 'electron'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { chmod, copyFile, link, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import type { InstallMethod } from '@shared/appUpdate'
import type { VerifiedDownload } from './updateCheck'

/**
 * 自動更新の入れ替えそのもの（OS ごと）。どれも、署名で確かめた大きさ・sha256 と合ったファイル（autoUpdate.ts）だけを受け取る。
 *
 * electron-updater由来（MIT, Copyright (c) 2015 Loopline Systems / electron-builder の作者）。Orca も同じものを使う
 * （~/bench/orca/src/main/electron-updater-loader.ts）:
 *   - macOS: MacUpdater.updateDownloaded … 手元だけのサーバー（127.0.0.1・その場の Basic 認証・推測できないパス）で zip を
 *     Squirrel.Mac に渡す。Squirrel.Mac は zip の中のアプリの署名が、動いているアプリと同じ開発元（Developer ID）かも確かめる
 *   - Windows: NsisUpdater.doInstall … `--updated /S --force-run` でインストーラーを走らせ、アプリを終える
 *   - Linux AppImage: AppImageUpdater.doInstall … 今の AppImage の場所に置き換え（名前に版があれば新しい名前で並べて古い方を消す）、起動し直す
 * electron-updater そのものは入れていない。配信元の latest*.yml を読み直して、その中の sha512 で確かめる作りなので、
 * R2 だけを書き換えられたときに守れない（このアプリは署名した SHA256SUMS の値だけを信じる）。
 */

/** zip を Squirrel.Mac に渡してから、受け取り終えるまで待つ上限 */
const SQUIRREL_TIMEOUT_MS = 5 * 60 * 1000

let squirrelServer: Server | null = null

function closeSquirrelServer(): void {
  squirrelServer?.close()
  squirrelServer = null
}

/** ファイルの sha256。無ければ null */
export async function hashFile(path: string): Promise<string | null> {
  try {
    await stat(path)
  } catch {
    return null
  }
  return await new Promise<string | null>((resolve) => {
    const hash = createHash('sha256')
    createReadStream(path).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', () => resolve(null))
  })
}

/** userData/updates を作り、keep 以外（前の版の残り・途中のもの）を消す */
export async function prepareUpdateDir(root: string, keep: string): Promise<{ dir: string; target: string }> {
  const dir = join(root, 'updates')
  await mkdir(dir, { recursive: true })
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (name !== keep) await rm(join(dir, name), { recursive: true, force: true }).catch(() => undefined)
  }
  return { dir, target: join(dir, keep) }
}

/**
 * macOS: 確かめた zip を Squirrel.Mac に渡し、受け取り終える（update-downloaded）まで待つ。
 * 渡す直前にもう一度 sha256 を確かめる（落としてから渡すまでの間に置き換えられたものは渡さない）
 */
async function stageWithSquirrel(path: string, file: VerifiedDownload): Promise<void> {
  if ((await hashFile(path)) !== file.sha256) throw new Error('update file changed before staging')
  closeSquirrelServer()
  const pass = randomBytes(32).toString('base64url')
  const fileUrl = `/${randomBytes(32).toString('hex')}.zip`
  const server = createServer((req, res) => {
    if (req.url === '/') {
      const [scheme, token] = (req.headers.authorization ?? '').split(' ')
      if (scheme !== 'Basic' || Buffer.from(token ?? '', 'base64').toString() !== `ferret:${pass}`) {
        res.writeHead(401).end()
        return
      }
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const body = Buffer.from(JSON.stringify({ url: `http://127.0.0.1:${port}${fileUrl}` }))
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length }).end(body)
      return
    }
    if (req.url !== fileUrl) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': file.size })
    createReadStream(path).on('error', () => res.destroy()).pipe(res)
  })
  squirrelServer = server
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('Squirrel.Mac did not finish staging the update')), SQUIRREL_TIMEOUT_MS)
    const onDownloaded = (): void => done()
    const onError = (err: Error): void => done(err)
    function done(err?: Error): void {
      clearTimeout(timer)
      autoUpdater.removeListener('update-downloaded', onDownloaded)
      autoUpdater.removeListener('error', onError)
      if (err) {
        closeSquirrelServer()
        reject(err)
      } else {
        resolve()
      }
    }
    autoUpdater.once('update-downloaded', onDownloaded)
    autoUpdater.once('error', onError)
    try {
      autoUpdater.setFeedURL({
        url: `http://127.0.0.1:${port}`,
        headers: { 'Cache-Control': 'no-cache', Authorization: `Basic ${Buffer.from(`ferret:${pass}`).toString('base64')}` }
      })
      autoUpdater.checkForUpdates()
    } catch (err) {
      done(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/** 入れ替えの準備。macOS だけ Squirrel.Mac に渡す（ほかは落としたファイルをそのまま使う） */
export async function stageUpdate(method: InstallMethod, path: string, file: VerifiedDownload): Promise<void> {
  if (method === 'squirrel-mac') await stageWithSquirrel(path, file)
}

/** 同じ名前があれば「名前 (1).deb」のようにずらして、上書きせずに置く */
async function placeInDownloads(path: string, name: string): Promise<string> {
  const dir = app.getPath('downloads')
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 0; i < 100; i++) {
    const target = join(dir, i === 0 ? name : `${stem} (${i})${ext}`)
    try {
      await link(path, target)
      return target
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
      try {
        await copyFile(path, target, constants.COPYFILE_EXCL)
        return target
      } catch (copyErr) {
        if ((copyErr as NodeJS.ErrnoException).code !== 'EEXIST') throw copyErr
      }
    }
  }
  throw new Error('no free file name')
}

/**
 * 入れ替える。呼ぶ前に、作業中の Agent・録画の確認（index.ts）を済ませておく。
 * 終了の後始末（PTY を閉じる・設定を書く）は app.quit() の before-quit（index.ts の beginShutdown）が行う
 */
export async function installUpdate(method: InstallMethod, path: string, file: VerifiedDownload): Promise<void> {
  // 入れ替える直前にもう一度 sha256 を確かめる
  if ((await hashFile(path)) !== file.sha256) throw new Error('update file changed before install')
  if (method === 'squirrel-mac') {
    // Squirrel.Mac が受け取り終えたもの（stageUpdate）を、終了のあとで入れ替えて起動し直す
    autoUpdater.quitAndInstall()
    return
  }
  if (method === 'nsis') {
    // 画面なしで入れ替え（/S）、終わったら新しい版を起動する（--force-run）。--updated は「更新として入れる」の印
    const child = spawn(path, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', reject)
    })
    child.unref()
    app.quit()
    return
  }
  if (method === 'appimage') {
    const current = process.env.APPIMAGE
    if (!current || !isAbsolute(current) || current.includes('\0')) throw new Error('APPIMAGE is not an absolute path')
    // 利用者が付けた名前（版を含まない）はそのまま上書きし、版を含む名前なら新しい版の名前で並べて古い方を消す
    const destination = /\d+\.\d+\.\d+/.test(basename(current)) ? join(dirname(current), file.name) : current
    const staged = `${destination}.${randomBytes(4).toString('hex')}.new`
    await copyFile(path, staged)
    await chmod(staged, 0o755)
    await rename(staged, destination)
    if (destination !== current) await rm(current, { force: true })
    app.relaunch({ execPath: destination, args: [] })
    app.quit()
    return
  }
  // deb: 自動では入れ替えない。ダウンロードのフォルダに置いて、ソフトウェアのインストーラーで開く
  const placed = await placeInDownloads(path, file.name)
  const error = await shell.openPath(placed)
  if (error) shell.showItemInFolder(placed)
}

/** アプリを閉じるときに、Squirrel.Mac 用の手元のサーバーを閉じる */
export function disposeAutoUpdateInstall(): void {
  closeSquirrelServer()
}
