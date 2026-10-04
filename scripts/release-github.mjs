/**
 * 版ごとの SHA256SUMS を、R2 とは別の場所（GitHub Release）に置く。インストーラーは R2 だけに置き、GitHub には付けない。
 * R2 のトークンが漏れて配布物と manifest を両方書き換えられても、GitHub の SHA256SUMS と突き合わせれば気づける。
 *
 * 手順の中の位置（README の「Releases」）:
 *   1. node scripts/release-r2.mjs stage …
 *   2. node scripts/release-github.mjs create --version <v> [--target <public main の commit>] [--dry-run]
 *        → staging の manifest から SHA256SUMS を作り、それだけを付けた GitHub Release の下書きを作る
 *        SHA256SUMS には R2 とは別の鍵で署名し（scripts/release-signing.mjs。鍵は ~/.ferret-signing か RELEASE_SIGNING_KEY）、
 *        SHA256SUMS.sig も付ける（security-3 [2]）。自動更新用のファイル（manifest の updates。macOS の zip）があれば、
 *        その sha256 を UPDATE-SHA256SUMS に分けて書き、同じ鍵で署名して UPDATE-SHA256SUMS.sig と並べて付ける
 *   3. gh release download v<v> --repo <repo> --pattern 'SHA256SUMS*' --pattern 'UPDATE-SHA256SUMS*' --dir <フォルダ>
 *      node scripts/release-r2.mjs promote --version <v> --expect-sums <フォルダ>/SHA256SUMS --sums-sig <フォルダ>/SHA256SUMS.sig \
 *        --expect-update-sums <フォルダ>/UPDATE-SHA256SUMS --update-sums-sig <フォルダ>/UPDATE-SHA256SUMS.sig
 *        → 署名が合わない・R2 の manifest が GitHub の SHA256SUMS と一致しなければ公開しない
 *   4. node scripts/release-github.mjs publish --version <v> [--dry-run]   … 下書きを公開する
 *
 * すでに promote した版は create --from releases で作れる。manifest を手元のファイルから読むときは --manifest <file>。
 * --dry-run は gh を動かさず、作る SHA256SUMS と gh のコマンドを表示するだけ。
 * gh も wrangler も shell を通さずに起動する（scripts/release-tools.mjs）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { join, resolve } from 'node:path'
import {
  assertValidVersion,
  formatSha256Sums,
  ghReleaseCreateArgs,
  ghReleaseNotes,
  ghReleasePublishArgs,
  UPDATE_SUMS,
  validateManifest,
  workPath
} from './release-r2-lib.mjs'
import { runTool, wranglerInvocation } from './release-tools.mjs'
import { assertSignedSums, loadSigningKey, signSshsig } from './release-signing.mjs'

const root = resolve(import.meta.dirname, '..')
const BUCKET = process.env.R2_BUCKET ?? 'movie-ade-releases'

function parseArgs(argv) {
  const args = { command: argv[0], from: 'staging', repo: process.env.RELEASE_REPO ?? 'JapanMarketing-Dev/ferret', dryRun: false }
  if (args.command !== 'create' && args.command !== 'publish') throw new Error('使い方: node scripts/release-github.mjs create|publish --version <v> [--dry-run]')
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i]
    const value = () => argv[++i]
    if (key === '--version') args.version = value()
    else if (key === '--from') args.from = value()
    else if (key === '--manifest') args.manifest = value()
    else if (key === '--repo') args.repo = value()
    else if (key === '--target') args.target = value()
    else if (key === '--dry-run') args.dryRun = true
    else throw new Error(`知らない引数です: ${key}`)
  }
  args.version ??= JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  assertValidVersion(args.version)
  if (args.from !== 'staging' && args.from !== 'releases') throw new Error('--from は staging か releases です')
  return args
}

/** manifest を読んで形を確かめる（手元のファイルか、R2 の API） */
function readManifest(args) {
  if (args.manifest) return validateManifest(JSON.parse(readFileSync(resolve(root, args.manifest), 'utf8')), args.version)
  const key = `${args.from}/${args.version}/manifest.json`
  const r = runTool(wranglerInvocation(['r2', 'object', 'get', `${BUCKET}/${key}`, '--remote', '--pipe']), { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${key} を読めませんでした:\n${r.stderr || r.stdout}`)
  return validateManifest(JSON.parse(String(r.stdout)), args.version)
}

function gh(ghArgs, dryRun) {
  console.log(`gh ${ghArgs.map((a) => (/^[\w./=:@-]+$/.test(a) ? a : JSON.stringify(a))).join(' ')}`)
  if (dryRun) return
  const r = runTool({ command: 'gh', args: ghArgs }, { cwd: root, stdio: 'inherit' })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`gh が失敗しました（終了コード ${r.status}）`)
}

const args = parseArgs(process.argv.slice(2))
if (args.command === 'publish') {
  gh(ghReleasePublishArgs({ version: args.version, repo: args.repo }), args.dryRun)
} else {
  const manifest = readManifest(args)
  const work = mkdtempSync(join(tmpdir(), 'ferret-gh-release-'))
  try {
    // 添付するファイルの名前が SHA256SUMS になるよう、作業フォルダに同じ名前で置く
    const sumsFile = workPath(work, 'SHA256SUMS', nodePath)
    const sums = formatSha256Sums(manifest.files)
    writeFileSync(sumsFile, sums, { flag: 'wx' })
    console.log(`SHA256SUMS（${manifest.files.length} 件。manifest の値と同じ）:\n${sums}`)
    // R2 の書き込みとは別の鍵で署名する。出す前に、リポジトリの公開鍵で確かめられることを確かめる
    const sigFile = workPath(work, 'SHA256SUMS.sig', nodePath)
    const signature = signSshsig(Buffer.from(sums), loadSigningKey())
    assertSignedSums(Buffer.from(sums), signature)
    writeFileSync(sigFile, signature, { flag: 'wx' })
    // 自動更新用のファイル（macOS の zip）は別の SHA256SUMS に分ける（0.4.x のアプリが SHA256SUMS と files の一致を求めるため。release-r2-lib.mjs）
    const extraFiles = []
    if (manifest.updates?.length) {
      const updateSums = formatSha256Sums(manifest.updates)
      console.log(`${UPDATE_SUMS}（${manifest.updates.length} 件。自動更新用）:\n${updateSums}`)
      const updateSumsFile = workPath(work, UPDATE_SUMS, nodePath)
      const updateSigFile = workPath(work, `${UPDATE_SUMS}.sig`, nodePath)
      const updateSignature = signSshsig(Buffer.from(updateSums), loadSigningKey())
      assertSignedSums(Buffer.from(updateSums), updateSignature)
      writeFileSync(updateSumsFile, updateSums, { flag: 'wx' })
      writeFileSync(updateSigFile, updateSignature, { flag: 'wx' })
      extraFiles.push(updateSumsFile, updateSigFile)
    }
    gh(
      ghReleaseCreateArgs({
        version: args.version,
        repo: args.repo,
        sumsFile,
        sigFile,
        extraFiles,
        notes: ghReleaseNotes(args.version),
        target: args.target,
        prerelease: manifest.prerelease,
        product: manifest.product
      }),
      args.dryRun
    )
    if (args.dryRun) console.log('（--dry-run: gh は動かしていません）')
    else console.log(`下書きを作りました。promote のあとで公開: node scripts/release-github.mjs publish --version ${args.version}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
