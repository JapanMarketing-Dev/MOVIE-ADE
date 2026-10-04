/**
 * レビュー題材サイトをローカルポートで配信する。
 *
 * - `node test/fixtures/serve.mjs [port]` で単体起動（既定は 4321、0 を渡すと空きポート）
 * - E2E からは `startFixtureServer()` を import して使う
 *
 * 依存を増やさないため Node 標準の http だけで書いている。
 */
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), 'site')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
}

/**
 * `site/` の下にあるファイルを「URL のパス → ファイルのパス」の表にする（シンボリックリンクは辿らない）。
 * 要求の URL はこの表を引くだけにして、ファイルのパスの組み立てには使わない（`..` や `%2e%2e` で外へ出られない）
 */
async function servedFiles(dir = ROOT, prefix = '') {
  const files = new Map()
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) for (const [url, file] of await servedFiles(path, `${prefix}/${entry.name}`)) files.set(url, file)
    else if (entry.isFile()) files.set(`${prefix}/${entry.name}`, path)
  }
  return files
}

/** URL のパスに当たるファイル（フォルダならその index.html）。無ければ undefined */
function lookup(files, urlPath) {
  let decoded
  try {
    decoded = decodeURIComponent((urlPath.split('?')[0] ?? '/').split('#')[0])
  } catch {
    return undefined
  }
  const path = decoded.replace(/\/+$/, '')
  return files.get(path) ?? files.get(`${path}/index.html`)
}

export function createFixtureServer() {
  return createServer(async (req, res) => {
    // 題材のファイルはテストの途中で変わりうるので、要求ごとに表を作る（十数ファイルなので軽い）
    const file = lookup(await servedFiles(), req.url ?? '/')
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html lang="ja"><meta charset="utf-8"><h1>404 見つかりません</h1>')
      return
    }
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
    createReadStream(file).pipe(res)
  })
}

/**
 * サーバーを起動して URL を返す。port に 0 を渡すと空きポートを自動で選ぶ。
 * @param {number} [port]
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export function startFixtureServer(port = 0) {
  const server = createFixtureServer()
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      const actual = typeof address === 'object' && address ? address.port : port
      resolvePromise({
        url: `http://127.0.0.1:${actual}/`,
        port: actual,
        close: () =>
          new Promise((done) => {
            server.close(() => done())
          })
      })
    })
  })
}

// 直接実行されたときだけ待ち受ける
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number.parseInt(process.argv[2] ?? '4321', 10)
  const { url } = await startFixtureServer(Number.isFinite(port) ? port : 4321)
  console.log(`題材サイトを配信しています: ${url}`)
}
