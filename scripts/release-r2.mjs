/**
 * 配布物を Cloudflare R2（バケット movie-ade-releases）へ上げる。公開は2段階で行う。
 *
 *   1. 公開前の置き場へ上げる（索引は変えないので、サイトにもアプリの更新確認にもまだ出ない）
 *      node scripts/release-r2.mjs stage [--version 0.1.0] [--dir dist/release] [--notes notes.md]
 *                                        [--notes-url URL] [--preview win,linux] [--prerelease] [--replace] [--dry-run]
 *      → staging/<version>/<ファイル名> と staging/<version>/manifest.json
 *
 *   2. 確認が済んだら公開する
 *      node scripts/release-r2.mjs promote --version 0.1.0 [--replace] [--yes] [--dry-run]
 *      → staging から releases/<version>/ へ移し、versions.json（最新10版）と latest.json を更新し、
 *        10版を超えた古い版を、消す対象を表示してから消す。最後に staging/<version>/ を消す
 *
 * 同じ版が releases/ にすでにあれば、どちらも止める（二重アップロードしない）。staging は上書きできる。
 *
 * 公開済みの版を作り直したときは --replace を付ける（stage と promote の両方）。
 *   - 新しいファイルは releases/<version>/b<build>/ に置く（ファイル名は同じで URL だけ変わる）。
 *     版のファイルは1年の immutable で返すので、同じ URL を上書きすると、ブラウザや将来の CDN が古いものを返しうるため
 *   - promote は、消す古いファイルを表示して確認を求めてから、manifest と索引を作り直し、古いファイルを消す
 *     （確認なしで進めるときは --yes。CI 用）
 * 書き込みは `wrangler r2 object put --remote`（1ファイル 300 MiB まで）。手元ではログイン済みの wrangler、
 * CI では環境変数 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID を使う（README の「Releases」を参照）。
 * 形式は scripts/release-r2-lib.mjs（download-site と合意）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { join, resolve } from 'node:path'
import {
  CONTENT_TYPES,
  IMMUTABLE_CACHE,
  INDEX_CACHE,
  MANIFEST_CACHE,
  STAGING_CACHE,
  addVersionToIndex,
  buildManifest,
  emptyIndex,
  obsoleteFiles,
  parseArtifactName,
  replaceVersionInIndex,
  stagingKey
} from './release-r2-lib.mjs'

const BUCKET = process.env.R2_BUCKET ?? 'movie-ade-releases'
const PUBLIC_BASE = process.env.R2_PUBLIC_BASE ?? 'https://pub-588d93b3e875464f98d6cf98dc711a0c.r2.dev'
const WRANGLER = process.env.WRANGLER ?? 'wrangler@latest'
/** wrangler r2 object put が1回で上げられる大きさの上限（300 MiB） */
const PUT_LIMIT_BYTES = 300 * 1024 * 1024

const root = resolve(import.meta.dirname, '..')

function parseArgs(argv) {
  const args = { command: 'stage', dir: 'dist/release', preview: [], prerelease: false, dryRun: false, replace: false, yes: false }
  let i = 0
  if (argv[0] === 'stage' || argv[0] === 'promote') args.command = argv[i++]
  for (; i < argv.length; i++) {
    const key = argv[i]
    const value = () => argv[++i]
    if (key === '--version') args.version = value()
    else if (key === '--dir') args.dir = value()
    else if (key === '--notes') args.notes = value()
    else if (key === '--notes-url') args.notesUrl = value()
    else if (key === '--preview') args.preview = value().split(',').map((s) => s.trim()).filter(Boolean)
    else if (key === '--prerelease') args.prerelease = true
    else if (key === '--dry-run') args.dryRun = true
    else if (key === '--replace') args.replace = true
    else if (key === '--yes') args.yes = true
    else throw new Error(`知らない引数です: ${key}`)
  }
  args.version ??= JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  return args
}

function wrangler(args) {
  const result = spawnSync('npx', ['--yes', WRANGLER, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32'
  })
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const isMissing = (r) => /not found|does not exist|NoSuchKey|10007/i.test(r.stderr + r.stdout)

/** R2 の JSON を読む。無ければ null（キャッシュを通さないよう、公開 URL ではなく API で読む） */
function getJson(key) {
  const r = wrangler(['r2', 'object', 'get', `${BUCKET}/${key}`, '--remote', '--pipe'])
  if (!r.ok) {
    if (isMissing(r)) return null
    throw new Error(`${key} を読めませんでした:\n${r.stderr || r.stdout}`)
  }
  return JSON.parse(r.stdout)
}

function download(key, file) {
  const r = wrangler(['r2', 'object', 'get', `${BUCKET}/${key}`, '--remote', '--file', file])
  if (!r.ok) throw new Error(`${key} を取り出せませんでした:\n${r.stderr || r.stdout}`)
}

function put(key, file, contentType, cacheControl, dryRun) {
  console.log(`  put ${key}  (${cacheControl})`)
  if (dryRun) return
  const r = wrangler(['r2', 'object', 'put', `${BUCKET}/${key}`, '--remote', '--file', file, '--content-type', contentType, '--cache-control', cacheControl])
  if (!r.ok) throw new Error(`${key} を上げられませんでした:\n${r.stderr || r.stdout}`)
}

function putJson(key, value, cacheControl, dryRun, work) {
  const file = join(work, key.replace(/\//g, '__'))
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
  put(key, file, 'application/json; charset=utf-8', cacheControl, dryRun)
}

function remove(key, dryRun) {
  console.log(`  delete ${key}`)
  if (dryRun) return
  const r = wrangler(['r2', 'object', 'delete', `${BUCKET}/${key}`, '--remote'])
  if (!r.ok && !isMissing(r)) console.warn(`  ${key} を消せませんでした（あとで手で消してください）:\n${r.stderr || r.stdout}`)
}

function sha256(file) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    createReadStream(file).on('data', (d) => hash.update(d)).on('end', () => resolvePromise(hash.digest('hex'))).on('error', reject)
  })
}

/** 消す対象を見せてから進めてよいかを尋ねる。--yes なら尋ねない。端末でなければ止める */
async function confirm(question, args) {
  if (args.yes || args.dryRun) return
  if (!process.stdin.isTTY) throw new Error('確認できない環境です。内容を確かめたうえで --yes を付けてください')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`${question} [y/N] `)
  rl.close()
  if (!/^y(es)?$/i.test(answer.trim())) throw new Error('中止しました')
}

const mib = (n) => `${(n / 1024 / 1024).toFixed(1)} MiB`

/** releases/ にすでにある版は、stage も promote もしない */
function assertNotReleased(version, index) {
  if (index.versions.some((v) => v.version === version) || getJson(`releases/${version}/manifest.json`)) {
    throw new Error(`${version} はすでに releases/ にあります。同じ版を上げ直すことはしません（版を上げてください）`)
  }
}

async function stage(args, work) {
  const dir = resolve(root, args.dir)
  if (!existsSync(dir)) throw new Error(`フォルダがありません: ${dir}（先に pnpm dist:<os> で作る）`)
  const found = readdirSync(dir).map((name) => parseArtifactName(name, args.version)).filter(Boolean)
  if (found.length === 0) throw new Error(`${dir} に MOVIE-ADE-${args.version}-*.{dmg,exe,AppImage,deb} がありません`)

  console.log(`版 ${args.version} の配布物（${found.length} 件）:`)
  const files = []
  for (const f of found) {
    const path = join(dir, f.name)
    const size = statSync(path).size
    if (size > PUT_LIMIT_BYTES) throw new Error(`${f.name} は ${mib(size)} で、wrangler で1回に上げられる 300 MiB を超えています`)
    files.push({ ...f, size, sha256: await sha256(path), local: path })
    console.log(`  ${f.name}  ${mib(size)}`)
  }
  let build = 1
  if (args.replace) {
    const released = getJson(`releases/${args.version}/manifest.json`)
    if (!released) throw new Error(`${args.version} は公開されていないので、--replace は要りません`)
    build = (released.build ?? 1) + 1
    console.log(`公開済みの ${args.version} を差し替えるための分です（build ${build}。promote --replace で入れ替える）`)
  } else {
    assertNotReleased(args.version, getJson('versions.json') ?? emptyIndex())
  }
  const previous = getJson(`staging/${args.version}/manifest.json`)
  if (previous) {
    console.log(`staging/${args.version}/ にある前回の分を置き換えます`)
    // 前回の分で、今回と path が違うもの（build が変わったときなど）は残さない
    for (const key of obsoleteFiles(previous, { files: [] }).map(stagingKey)) remove(key, args.dryRun)
  }

  const manifest = buildManifest({
    version: args.version,
    date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    prerelease: args.prerelease,
    notes: args.notes ? readFileSync(resolve(root, args.notes), 'utf8') : `MOVIE-ADE ${args.version}. These builds are not code-signed yet.`,
    notesUrl: args.notesUrl,
    files: files.map(({ name, os, arch, kind, size, sha256: hash }) => ({ name, os, arch, kind, size, sha256: hash })),
    previewOs: args.preview,
    build
  })

  console.log(args.dryRun ? '\n（--dry-run: 実際には書き込みません）' : '\n公開前の置き場（staging）へ上げます:')
  for (const f of manifest.files) {
    const local = files.find((x) => x.name === f.name).local
    put(stagingKey(f.path), local, CONTENT_TYPES[f.kind], STAGING_CACHE, args.dryRun)
  }
  putJson(`staging/${args.version}/manifest.json`, manifest, STAGING_CACHE, args.dryRun, work)
  console.log(`\n確認用: ${PUBLIC_BASE}/staging/${args.version}/manifest.json`)
  console.log(`公開するには: node scripts/release-r2.mjs promote --version ${args.version}${args.replace ? ' --replace' : ''}`)
  console.log(`合計 ${mib(files.reduce((n, f) => n + f.size, 0))}`)
}

async function promote(args, work) {
  const manifest = getJson(`staging/${args.version}/manifest.json`)
  if (!manifest) throw new Error(`staging/${args.version}/manifest.json がありません（先に stage する）`)
  const index = getJson('versions.json') ?? emptyIndex()
  let nextIndex
  let removed = []
  let obsolete = []
  if (args.replace) {
    const old = getJson(`releases/${args.version}/manifest.json`)
    if (!old) throw new Error(`${args.version} は公開されていないので、--replace は要りません`)
    if ((manifest.build ?? 1) <= (old.build ?? 1)) throw new Error('staging の分は差し替え用ではありません。stage --replace で上げ直してください')
    nextIndex = replaceVersionInIndex(index, manifest)
    obsolete = obsoleteFiles(old, manifest)
    console.log(`公開済みの ${args.version}（build ${old.build ?? 1}）を build ${manifest.build} に差し替えます。消す古いファイル:`)
    for (const key of obsolete) console.log(`  ${key}`)
    await confirm('この内容で差し替えますか', args)
  } else {
    assertNotReleased(args.version, index)
    // ここで10版の上限を計算する（同じ版なら例外）
    ;({ index: nextIndex, removed } = addVersionToIndex(index, manifest))
    if (removed.length > 0) {
      console.log(`最新 ${nextIndex.versions.length} 版を超えるので、公開のあとで次の版を消します: ${removed.map((v) => v.version).join(', ')}`)
      await confirm('進めますか', args)
    }
  }

  console.log(args.dryRun ? '（--dry-run: 実際には書き込みません）' : `${args.version} を公開します:`)
  for (const f of manifest.files) {
    const local = join(work, f.name)
    if (!args.dryRun) {
      download(stagingKey(f.path), local)
      // staging の中身が manifest と同じかを確かめてから公開する
      if ((await sha256(local)) !== f.sha256) throw new Error(`${f.name} の sha256 が manifest と一致しません。公開を止めました`)
    }
    put(f.path, local, CONTENT_TYPES[f.kind], IMMUTABLE_CACHE, args.dryRun)
    if (!args.dryRun) rmSync(local)
  }
  putJson(`releases/${args.version}/manifest.json`, manifest, MANIFEST_CACHE, args.dryRun, work)

  // 古い版を消すときに使うので、外れる版の manifest を先に読んでおく
  const removedManifests = removed.map((v) => ({ version: v.version, key: v.manifest, manifest: getJson(v.manifest) }))
  putJson('versions.json', nextIndex, INDEX_CACHE, args.dryRun, work)
  const latest = nextIndex.latest === args.version ? manifest : nextIndex.latest ? getJson(`releases/${nextIndex.latest}/manifest.json`) : null
  if (latest) putJson('latest.json', latest, INDEX_CACHE, args.dryRun, work)

  if (obsolete.length > 0) {
    console.log('\n差し替える前の古いファイルを消します:')
    for (const key of obsolete) remove(key, args.dryRun)
  }

  if (removedManifests.length > 0) {
    console.log(`\n最新 ${nextIndex.versions.length} 版を超えた古い版を消します: ${removedManifests.map((v) => v.version).join(', ')}`)
    for (const v of removedManifests) {
      for (const f of v.manifest?.files ?? []) remove(f.path, args.dryRun)
      remove(v.key, args.dryRun)
    }
  }

  console.log(`\n公開前の置き場を片付けます:`)
  for (const f of manifest.files) remove(stagingKey(f.path), args.dryRun)
  remove(`staging/${args.version}/manifest.json`, args.dryRun)
  console.log(`\n${args.dryRun ? '確認だけ' : '公開しました'}: ${PUBLIC_BASE}/releases/${args.version}/manifest.json`)
}

const args = parseArgs(process.argv.slice(2))
const work = mkdtempSync(join(tmpdir(), 'movie-ade-r2-'))
try {
  if (args.command === 'promote') await promote(args, work)
  else await stage(args, work)
} finally {
  rmSync(work, { recursive: true, force: true })
}
