/**
 * 版ごとの SHA256SUMS を、R2 とは別の場所（GitHub Release）に置く。インストーラーは R2 だけに置き、GitHub には付けない。
 * R2 のトークンが漏れて配布物と manifest を両方書き換えられても、GitHub の SHA256SUMS と突き合わせれば気づける。
 *
 * 手順の中の位置（README の「Releases」）:
 *   1. node scripts/release-r2.mjs stage …
 *   2. node scripts/release-github.mjs create --version <v> [--target <public main の commit>] [--dry-run]
 *        → staging の manifest から SHA256SUMS を作り、それだけを付けた GitHub Release の下書きを作る
 *   3. gh release download v<v> --repo <repo> --pattern SHA256SUMS --dir <フォルダ>
 *      node scripts/release-r2.mjs promote --version <v> --expect-sums <フォルダ>/SHA256SUMS
 *        → R2 の manifest が GitHub の SHA256SUMS と一致しなければ公開しない
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
  validateManifest,
  workPath
} from './release-r2-lib.mjs'
import { runTool, wranglerInvocation } from './release-tools.mjs'

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
    gh(
      ghReleaseCreateArgs({
        version: args.version,
        repo: args.repo,
        sumsFile,
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
