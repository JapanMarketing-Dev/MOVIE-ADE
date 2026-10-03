/**
 * リリースまわりのスクリプトが外の道具（wrangler・sentry・@sentry/cli）を起動するための共通の入口。
 *
 * - shell を通さない（どの OS でも）。引数に R2 の manifest・版・パスなど外から来た値が入っても、
 *   cmd.exe / sh に解釈されず、そのまま1つの引数として渡る
 * - 道具は devDependencies で版を固定し（pnpm-lock.yaml の integrity 付き）、node_modules の bin の JS を node で直接起動する
 *   （Windows でも .cmd を経由しないので shell が要らない）
 * - npx・pnpm dlx などで実行時に取ってくることはしない。入っていない・版が違うときは取りに行かずに止める
 *   （secrets を持つリリースのジョブで、lockfile の外のパッケージを動かさないため）
 *
 *   node scripts/release-tools.mjs wrangler <wrangler の引数…>   … 固定した wrangler をそのまま動かす（pnpm site:deploy が使う）
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isExactPackageSpec } from './release-r2-lib.mjs'

const root = resolve(import.meta.dirname, '..')

/**
 * devDependencies で版を固定した道具を、node_modules の bin の JS で起動する形。
 * package.json の指定が完全な版（1.2.3）でない・入っていない・入っている版が違うときは例外（取りに行かない）。
 * @param {string} pkgName
 * @param {string} binName
 * @param {string[]} args
 * @param {string} [rootDir] テスト用（既定はこのリポジトリ）
 * @returns {{ command: string, args: string[] }}
 */
export function pinnedInvocation(pkgName, binName, args, rootDir = root) {
  const want = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).devDependencies?.[pkgName]
  if (!isExactPackageSpec(`${pkgName}@${want}`)) throw new Error(`${pkgName} を devDependencies に完全な版（1.2.3）で固定してください（今: ${want}）`)
  const pkgFile = join(rootDir, 'node_modules', pkgName, 'package.json')
  if (!existsSync(pkgFile)) throw new Error(`固定した ${pkgName} ${want} が入っていません。先に pnpm install --frozen-lockfile を走らせてください（取りに行くことはしません）`)
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  if (pkg.version !== want) throw new Error(`node_modules の ${pkgName} が ${pkg.version} です（固定は ${want}）。pnpm install --frozen-lockfile で入れ直してください`)
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[binName]
  if (!bin) throw new Error(`${pkgName} に ${binName} の bin がありません`)
  return { command: process.execPath, args: [join(dirname(pkgFile), bin), ...args] }
}

/** 固定した wrangler（R2 への読み書き・Pages への公開） */
export const wranglerInvocation = (args) => pinnedInvocation('wrangler', 'wrangler', args)
/** 固定した sentry CLI（ソースマップ・リリース） */
export const sentryInvocation = (args) => pinnedInvocation('sentry', 'sentry', args)
/** 固定した @sentry/cli（ネイティブの記号。新しい sentry CLI に無い debug-files upload に使う） */
export const sentryCliInvocation = (args) => pinnedInvocation('@sentry/cli', 'sentry-cli', args)

/**
 * node_modules に入っている開発用の道具（electron-vite・electron-builder）の bin を、node で直接起動する形。
 * Windows の node_modules/.bin は .cmd なので shell が要るが、bin の JS を node で動かせば要らない。
 * @param {string} pkgName
 * @param {string} binName
 * @param {string[]} args
 * @returns {{ command: string, args: string[] }}
 */
export function localBinInvocation(pkgName, binName, args) {
  const pkgFile = join(root, 'node_modules', pkgName, 'package.json')
  if (!existsSync(pkgFile)) throw new Error(`${pkgName} が入っていません。先に pnpm install を走らせてください`)
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[binName]
  if (!bin) throw new Error(`${pkgName} に ${binName} の bin がありません`)
  return { command: process.execPath, args: [join(dirname(pkgFile), bin), ...args] }
}

/**
 * shell を通さずに起動する。opts で shell を指定しても無視する（ここを通る起動は必ず shell なし）。
 * @param {{ command: string, args: string[] }} invocation
 * @param {import('node:child_process').SpawnSyncOptions} [opts]
 */
export function runTool(invocation, opts = {}) {
  return spawnSync(invocation.command, invocation.args, { ...opts, shell: false })
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === import.meta.filename) {
  const [tool, ...rest] = process.argv.slice(2)
  if (tool !== 'wrangler') {
    console.error('使い方: node scripts/release-tools.mjs wrangler <引数…>')
    process.exit(2)
  }
  const r = runTool(wranglerInvocation(rest), { cwd: root, stdio: 'inherit' })
  process.exit(r.status ?? 1)
}
