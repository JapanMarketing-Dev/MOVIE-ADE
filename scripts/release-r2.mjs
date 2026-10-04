/**
 * 配布物を Cloudflare R2（バケット movie-ade-releases）へ上げる。公開は2段階で行う。
 *
 *   1. 公開前の置き場へ上げる（索引は変えないので、サイトにもアプリの更新確認にもまだ出ない）
 *      node scripts/release-r2.mjs stage [--version 0.1.0] [--dir dist/release] [--notes notes.md]
 *                                        [--notes-url URL] [--preview win,linux] [--prerelease] [--replace] [--dry-run]
 *      → staging/<version>/<ファイル名> と staging/<version>/manifest.json
 *
 *   2. 確認が済んだら公開する
 *      node scripts/release-r2.mjs promote --version 0.1.0 [--expect-sums SHA256SUMS] [--replace] [--yes] [--dry-run]
 *
 *   公開済みの版のリリースノートだけを差し替える（ファイルと sha256 は変えない。サイトの更新履歴に出る文）
 *      node scripts/release-r2.mjs notes --version 0.4.0 --notes docs/release-notes/0.4.0.md [--dry-run]
 *      → releases/<version>/manifest.json の notes を書き換え、その版が最新なら latest.json も同じにする
 *
 *   公開しないことにした staging の版を片付ける
 *      node scripts/release-r2.mjs discard --version 0.1.2 [--yes] [--dry-run]
 *      → staging/<version>/ のファイルと manifest.json を、表示して確認を求めてから消す（releases/ には触らない）
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
 * --sums-sig は SHA256SUMS の署名（scripts/release-signing.mjs。R2 の書き込みとは別の鍵）。promote は署名が無い・合わなければ止め、
 * 合えば releases/<version>/SHA256SUMS(.sig) も置く（アプリの更新確認が確かめる。security-3 [2]）。
 * 自動更新用のファイル（macOS の zip。scripts/release-r2-lib.mjs の parseUpdateArtifactName）は、--dir にあれば一緒に上げ、
 * manifest の updates に載せる（サイトには出ない）。その sha256 はインストーラーとは別の UPDATE-SHA256SUMS に載せて署名する
 * （--expect-update-sums / --update-sums-sig。promote は updates があるのに無ければ止め、合えば releases/<version>/ に置く）。
 * --expect-sums は、R2 とは別の場所（GitHub Release）に置いた SHA256SUMS。渡すと、manifest の各ファイルの sha256 が
 * それと過不足なく一致しなければ止める（R2 だけを書き換えられても公開しない）。CI の stage / promote は必ず渡す。
 * 手元から公開するときは、stage のあとに scripts/release-github.mjs create で SHA256SUMS だけの GitHub Release の下書きを作り、
 * それを gh release download で取ってきて promote に渡す（手順は release-github.mjs の先頭）。
 *
 * 書き込みは `wrangler r2 object put --remote`（1ファイル 300 MiB まで）。手元ではログイン済みの wrangler、
 * CI では環境変数 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID を使う（README の「Releases」を参照）。
 * wrangler は devDependencies で版を固定したもの（pnpm-lock.yaml の integrity 付き）を、node で直接起動する（shell を通さない）。
 * R2 から読んだ manifest・索引は validateManifest / validateIndex で形を確かめてから使い、
 * ローカルの一時ファイルの名前には manifest の値を使わない（file-0 のように、こちらで付ける）。
 * 形式は scripts/release-r2-lib.mjs（download-site と合意）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline/promises'
import * as nodePath from 'node:path'
import { join, resolve } from 'node:path'
import {
  CONTENT_TYPES,
  IMMUTABLE_CACHE,
  INDEX_CACHE,
  MANIFEST_CACHE,
  PUT_LIMIT_BYTES,
  STAGING_CACHE,
  addVersionToIndex,
  assertManifestMatchesSums,
  assertUpdatesMatchSums,
  assertValidVersion,
  allFiles,
  buildManifest,
  emptyIndex,
  obsoleteFiles,
  withNotes,
  parseArtifactName,
  parseSha256Sums,
  parseUpdateArtifactName,
  replaceVersionInIndex,
  stagingKey,
  UPDATE_SUMS,
  validateIndex,
  validateManifest,
  workPath
} from './release-r2-lib.mjs'
import { runTool, wranglerInvocation } from './release-tools.mjs'
import { assertSignedSums } from './release-signing.mjs'

const BUCKET = process.env.R2_BUCKET ?? 'movie-ade-releases'
const PUBLIC_BASE = process.env.R2_PUBLIC_BASE ?? 'https://pub-588d93b3e875464f98d6cf98dc711a0c.r2.dev'

const root = resolve(import.meta.dirname, '..')

function parseArgs(argv) {
  const args = { command: 'stage', dir: 'dist/release', preview: [], prerelease: false, dryRun: false, replace: false, yes: false }
  let i = 0
  if (['stage', 'promote', 'discard', 'notes'].includes(argv[0])) args.command = argv[i++]
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
    else if (key === '--expect-sums') args.expectSums = value()
    else if (key === '--sums-sig') args.sumsSig = value()
    else if (key === '--expect-update-sums') args.expectUpdateSums = value()
    else if (key === '--update-sums-sig') args.updateSumsSig = value()
    else throw new Error(`知らない引数です: ${key}`)
  }
  args.version ??= JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  // 版は R2 のキーとローカルのパスに入るので、形を確かめてから使う
  assertValidVersion(args.version)
  return args
}

/** 固定した wrangler を shell なしで動かす（引数は外から来た値でも、そのまま1つずつ渡る） */
function wrangler(args) {
  const result = runTool(wranglerInvocation(args), { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw result.error
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const isMissing = (r) => /not found|does not exist|NoSuchKey|10007/i.test(r.stderr + r.stdout)

/** R2 の JSON を読む。無ければ null（キャッシュを通さないよう、公開 URL ではなく API で読む）。形は呼ぶ側で確かめる */
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

let tempCount = 0
/** 作業フォルダの中に、こちらで名前を付けた一時ファイルのパスを作る（manifest の値は使わない） */
function tempFile(work, ext) {
  return workPath(work, `file-${tempCount++}.${ext}`, nodePath)
}

/** R2 の manifest を読んで形を確かめる。無ければ null */
function getManifest(key, version) {
  const m = getJson(key)
  return m === null ? null : validateManifest(m, version)
}

/** R2 の versions.json を読んで形を確かめる。無ければ空の索引 */
function getIndex() {
  const x = getJson('versions.json')
  return x === null ? emptyIndex() : validateIndex(x)
}

/**
 * --expect-sums の SHA256SUMS と manifest を突き合わせる（渡されていなければ何もしない）。
 * --sums-sig があれば、SHA256SUMS の署名をリポジトリの公開鍵で確かめる（security-3 [2]。R2 の外の鍵）。
 * promote は両方が無ければ止める（requireSigned）
 */
function checkExpectedSums(manifest, args, requireSigned = false) {
  if (requireSigned && !args.dryRun && (!args.expectSums || !args.sumsSig)) {
    throw new Error('公開には署名した SHA256SUMS が要ります（--expect-sums SHA256SUMS --sums-sig SHA256SUMS.sig。scripts/release-signing.mjs sign で作る）')
  }
  if (!args.expectSums) return
  const sums = readFileSync(resolve(root, args.expectSums))
  if (args.sumsSig) {
    assertSignedSums(sums, readFileSync(resolve(root, args.sumsSig), 'utf8'))
    console.log(`SHA256SUMS の署名（${args.sumsSig}）をリポジトリの公開鍵で確かめました`)
  }
  assertManifestMatchesSums(manifest, parseSha256Sums(sums.toString('utf8')))
  console.log(`SHA256SUMS（${args.expectSums}）と manifest の ${manifest.files.length} 件が一致しました`)
  checkExpectedUpdateSums(manifest, args, requireSigned)
}

/**
 * 自動更新用のファイル（manifest の updates）を、署名した UPDATE-SHA256SUMS と突き合わせる。
 * updates がある版の公開（requireSigned）は、--expect-update-sums と --update-sums-sig が無ければ止める
 */
function checkExpectedUpdateSums(manifest, args, requireSigned) {
  const count = manifest.updates?.length ?? 0
  if (requireSigned && !args.dryRun && count > 0 && (!args.expectUpdateSums || !args.updateSumsSig)) {
    throw new Error(`自動更新のファイルがあるので、署名した ${UPDATE_SUMS} が要ります（--expect-update-sums ${UPDATE_SUMS} --update-sums-sig ${UPDATE_SUMS}.sig）`)
  }
  if (!args.expectUpdateSums) {
    if (count > 0) console.log(`（${UPDATE_SUMS} を渡していないので、自動更新のファイル ${count} 件は突き合わせていません）`)
    return
  }
  const sums = readFileSync(resolve(root, args.expectUpdateSums))
  if (args.updateSumsSig) {
    assertSignedSums(sums, readFileSync(resolve(root, args.updateSumsSig), 'utf8'))
    console.log(`${UPDATE_SUMS} の署名（${args.updateSumsSig}）をリポジトリの公開鍵で確かめました`)
  }
  assertUpdatesMatchSums(manifest, parseSha256Sums(sums.toString('utf8')))
  console.log(`${UPDATE_SUMS}（${args.expectUpdateSums}）と manifest の自動更新のファイル ${count} 件が一致しました`)
}

function putJson(key, value, cacheControl, dryRun, work) {
  const file = tempFile(work, 'json')
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
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
  if (index.versions.some((v) => v.version === version) || getJson(`releases/${version}/manifest.json`) !== null) {
    throw new Error(`${version} はすでに releases/ にあります。同じ版を上げ直すことはしません（版を上げてください）`)
  }
}

async function stage(args, work) {
  const dir = resolve(root, args.dir)
  if (!existsSync(dir)) throw new Error(`フォルダがありません: ${dir}（先に pnpm dist:<os> で作る）`)
  const entries = readdirSync(dir)
  const found = entries.map((name) => parseArtifactName(name, args.version)).filter(Boolean)
  const foundUpdates = entries.map((name) => parseUpdateArtifactName(name, args.version)).filter(Boolean)
  if (found.length === 0) throw new Error(`${dir} に Ferret-${args.version}-*.{dmg,exe,AppImage,deb} がありません`)
  // 1つの版に製品名を混ぜない（Ferret と MOVIE-ADE のファイルが同じ版で並ぶと、サイトの表示がおかしくなる）
  const products = [...new Set(found.map((f) => f.product))]
  if (products.length > 1) throw new Error(`同じ版に製品名が混ざっています: ${products.join(', ')}`)
  const product = products[0]

  console.log(`版 ${args.version} の配布物（${found.length} 件）:`)
  const files = []
  for (const f of found) {
    const path = join(dir, f.name)
    const size = statSync(path).size
    if (size > PUT_LIMIT_BYTES) throw new Error(`${f.name} は ${mib(size)} で、wrangler で1回に上げられる 300 MiB を超えています`)
    files.push({ ...f, size, sha256: await sha256(path), local: path })
    console.log(`  ${f.name}  ${mib(size)}`)
  }
  const updates = []
  if (foundUpdates.length > 0) console.log(`自動更新用のファイル（${foundUpdates.length} 件。サイトには出さない）:`)
  for (const f of foundUpdates) {
    const path = join(dir, f.name)
    const size = statSync(path).size
    if (size > PUT_LIMIT_BYTES) throw new Error(`${f.name} は ${mib(size)} で、wrangler で1回に上げられる 300 MiB を超えています`)
    updates.push({ ...f, size, sha256: await sha256(path), local: path })
    console.log(`  ${f.name}  ${mib(size)}`)
  }
  let build = 1
  if (args.replace) {
    const released = getManifest(`releases/${args.version}/manifest.json`, args.version)
    if (!released) throw new Error(`${args.version} は公開されていないので、--replace は要りません`)
    build = (released.build ?? 1) + 1
    console.log(`公開済みの ${args.version} を差し替えるための分です（build ${build}。promote --replace で入れ替える）`)
  } else {
    assertNotReleased(args.version, getIndex())
  }
  const previous = getManifest(`staging/${args.version}/manifest.json`, args.version)
  if (previous) {
    console.log(`staging/${args.version}/ にある前回の分を置き換えます`)
    // 前回の分で、今回と path が違うもの（build が変わったときなど）は残さない
    for (const key of obsoleteFiles(previous, { files: [] }).map(stagingKey)) remove(key, args.dryRun)
  }

  const manifest = buildManifest({
    version: args.version,
    date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    prerelease: args.prerelease,
    notes: args.notes ? readFileSync(resolve(root, args.notes), 'utf8') : `${product} ${args.version}`,
    notesUrl: args.notesUrl,
    files: files.map(({ name, os, arch, kind, size, sha256: hash }) => ({ name, os, arch, kind, size, sha256: hash })),
    updates: updates.map(({ name, os, arch, kind, size, sha256: hash }) => ({ name, os, arch, kind, size, sha256: hash })),
    previewOs: args.preview,
    product,
    build
  })
  checkExpectedSums(manifest, args)

  console.log(args.dryRun ? '\n（--dry-run: 実際には書き込みません）' : '\n公開前の置き場（staging）へ上げます:')
  for (const f of allFiles(manifest)) {
    const local = [...files, ...updates].find((x) => x.name === f.name).local
    put(stagingKey(f.path), local, CONTENT_TYPES[f.kind], STAGING_CACHE, args.dryRun)
  }
  putJson(`staging/${args.version}/manifest.json`, manifest, STAGING_CACHE, args.dryRun, work)
  console.log(`\n確認用: ${PUBLIC_BASE}/staging/${args.version}/manifest.json`)
  console.log(`公開するには: node scripts/release-r2.mjs promote --version ${args.version}${args.replace ? ' --replace' : ''}`)
  console.log(`合計 ${mib([...files, ...updates].reduce((n, f) => n + f.size, 0))}`)
}

async function discard(args) {
  const manifest = getManifest(`staging/${args.version}/manifest.json`, args.version)
  if (!manifest) throw new Error(`staging/${args.version}/manifest.json がありません（片付けるものがない）`)
  const keys = [...allFiles(manifest).map((f) => stagingKey(f.path)), `staging/${args.version}/manifest.json`]
  console.log(`公開しない ${args.version} を staging から消します:`)
  for (const key of keys) console.log(`  ${key}`)
  await confirm('消しますか', args)
  for (const key of keys) remove(key, args.dryRun)
  console.log(args.dryRun ? '確認だけ' : '片付けました')
}

async function replaceNotes(args, work) {
  if (!args.notes) throw new Error('--notes <ファイル> を渡してください')
  const key = `releases/${args.version}/manifest.json`
  const manifest = getManifest(key, args.version)
  if (!manifest) throw new Error(`${key} がありません（公開済みの版だけを直せます）`)
  const next = withNotes(manifest, readFileSync(resolve(root, args.notes), 'utf8'))
  console.log(`${args.version} のリリースノートを差し替えます（ファイルと sha256 は変えません）`)
  putJson(key, next, MANIFEST_CACHE, args.dryRun, work)
  // latest.json は最新版の manifest と同じ中身なので、直す版が最新ならそちらも同じにする
  if (getIndex().latest === args.version) putJson('latest.json', next, INDEX_CACHE, args.dryRun, work)
  console.log(args.dryRun ? '確認だけ' : `差し替えました: ${PUBLIC_BASE}/${key}`)
}

async function promote(args, work) {
  const manifest = getManifest(`staging/${args.version}/manifest.json`, args.version)
  if (!manifest) throw new Error(`staging/${args.version}/manifest.json がありません（先に stage する）`)
  checkExpectedSums(manifest, args, true)
  const index = getIndex()
  let nextIndex
  let removed = []
  let obsolete = []
  if (args.replace) {
    const old = getManifest(`releases/${args.version}/manifest.json`, args.version)
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

  // latest.json に入れる manifest は、書き込みを始める前に読んで確かめておく（途中で止まって索引だけが古いまま残らないように）
  const latest = nextIndex.latest === args.version ? manifest : nextIndex.latest ? getManifest(`releases/${nextIndex.latest}/manifest.json`, nextIndex.latest) : null

  console.log(args.dryRun ? '（--dry-run: 実際には書き込みません）' : `${args.version} を公開します:`)
  for (const f of allFiles(manifest)) {
    // 一時ファイルの名前はこちらで付ける（manifest の name は使わない）。まだ無いことを確かめ、作ったものだけを消す
    const local = tempFile(work, 'bin')
    if (existsSync(local)) throw new Error(`一時ファイルがすでにあります: ${local}`)
    if (!args.dryRun) {
      download(stagingKey(f.path), local)
      // staging の中身が manifest と同じかを確かめてから公開する
      if ((await sha256(local)) !== f.sha256) throw new Error(`${f.name} の sha256 が manifest と一致しません。公開を止めました`)
    }
    put(f.path, local, CONTENT_TYPES[f.kind], IMMUTABLE_CACHE, args.dryRun)
    if (!args.dryRun) rmSync(local)
  }
  putJson(`releases/${args.version}/manifest.json`, manifest, MANIFEST_CACHE, args.dryRun, work)
  // 署名した SHA256SUMS も並べて置く。アプリの更新確認が、同梱の公開鍵で確かめてから案内する（src/main/releaseSignature.ts）
  if (args.expectSums && args.sumsSig) {
    put(`releases/${args.version}/SHA256SUMS`, resolve(root, args.expectSums), 'text/plain; charset=utf-8', MANIFEST_CACHE, args.dryRun)
    put(`releases/${args.version}/SHA256SUMS.sig`, resolve(root, args.sumsSig), 'text/plain; charset=utf-8', MANIFEST_CACHE, args.dryRun)
  }
  // 自動更新用のファイルの sha256 と署名。アプリは署名を確かめた zip だけを入れ替えに使う（src/main/releaseSignature.ts の verifiedUpdateFiles）
  if (manifest.updates?.length && args.expectUpdateSums && args.updateSumsSig) {
    put(`releases/${args.version}/${UPDATE_SUMS}`, resolve(root, args.expectUpdateSums), 'text/plain; charset=utf-8', MANIFEST_CACHE, args.dryRun)
    put(`releases/${args.version}/${UPDATE_SUMS}.sig`, resolve(root, args.updateSumsSig), 'text/plain; charset=utf-8', MANIFEST_CACHE, args.dryRun)
  }

  // 古い版を消すときに使うので、外れる版の manifest を先に読んでおく
  // 形の正しくない manifest の版は、ファイルを消さずに警告だけ出す（R2 の別の場所を消さない）
  const removedManifests = removed.map((v) => {
    try {
      return { version: v.version, key: v.manifest, manifest: getManifest(v.manifest, v.version) }
    } catch (e) {
      console.warn(`  ${v.version} の manifest を確かめられないので、その版のファイルは消しません（あとで手で確かめてください）: ${e.message}`)
      return { version: v.version, key: v.manifest, manifest: null }
    }
  })
  putJson('versions.json', nextIndex, INDEX_CACHE, args.dryRun, work)
  if (latest) putJson('latest.json', latest, INDEX_CACHE, args.dryRun, work)

  if (obsolete.length > 0) {
    console.log('\n差し替える前の古いファイルを消します:')
    for (const key of obsolete) remove(key, args.dryRun)
  }

  if (removedManifests.length > 0) {
    console.log(`\n最新 ${nextIndex.versions.length} 版を超えた古い版を消します: ${removedManifests.map((v) => v.version).join(', ')}`)
    for (const v of removedManifests) {
      for (const f of allFiles(v.manifest)) remove(f.path, args.dryRun)
      if (v.manifest) for (const name of ['SHA256SUMS', 'SHA256SUMS.sig', UPDATE_SUMS, `${UPDATE_SUMS}.sig`]) remove(`releases/${v.version}/${name}`, args.dryRun)
      remove(v.key, args.dryRun)
    }
  }

  console.log(`\n公開前の置き場を片付けます:`)
  for (const f of allFiles(manifest)) remove(stagingKey(f.path), args.dryRun)
  remove(`staging/${args.version}/manifest.json`, args.dryRun)
  console.log(`\n${args.dryRun ? '確認だけ' : '公開しました'}: ${PUBLIC_BASE}/releases/${args.version}/manifest.json`)

  // Sentry のリリースにコミット（変更したファイル付き）・公開日・デプロイ（production）を付ける。
  // 認証が無ければ警告だけで進む（scripts/sentry-release.mjs）。公開そのものは済んでいるので失敗でも止めない
  const sentry = spawnSync(process.execPath, [join(import.meta.dirname, 'sentry-release.mjs'), 'publish', '--version', args.version, ...(args.dryRun ? ['--dry-run'] : [])], { stdio: 'inherit' })
  if (sentry.status !== 0) console.warn('Sentry のリリースの情報を付けられませんでした。あとで node scripts/sentry-release.mjs publish --version で付けられます')
}

const args = parseArgs(process.argv.slice(2))
const work = mkdtempSync(join(tmpdir(), 'ferret-r2-'))
try {
  if (args.command === 'promote') await promote(args, work)
  else if (args.command === 'discard') await discard(args)
  else if (args.command === 'notes') await replaceNotes(args, work)
  else await stage(args, work)
} finally {
  rmSync(work, { recursive: true, force: true })
}
