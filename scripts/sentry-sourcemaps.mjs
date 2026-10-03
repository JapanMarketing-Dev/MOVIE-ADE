/**
 * 配布版のスタックトレースを Sentry で読めるよう、ビルドしたソースマップを上げる。
 *
 *   node scripts/sentry-sourcemaps.mjs [--dir out] [--dry-run]
 *
 * 必ず `pnpm build` のあと、electron-builder の前に走らせる。
 * `sentry sourcemap upload` が out/ の JS に debug ID を書き込む（JS が書き換わる）ので、
 * そのあとに詰めた配布物だけが、上げたソースマップと結び付く。.map 自体は配布物に入れない
 * （electron-builder の files で除いている。ソースマップは electron.vite.config.ts で hidden に出す）。
 *
 * release は `ferret@<package.json の version>`（src/shared/telemetry.ts の sentryRelease と同じ）。
 *
 * 認証:
 *   - CI … 環境変数 SENTRY_AUTH_TOKEN（GitHub Actions の secrets から渡す。トークンはコードに書かない）
 *   - 手元 … ログイン済みの `sentry` CLI（`sentry auth login`）
 * どちらも無いとき・FERRET_SENTRY_DSN（以前の MOVIE_ADE_SENTRY_DSN）を空にしてクラッシュレポートを止めているときは、
 * 警告だけ出して成功で終える（フォークした人のビルドを止めない）。
 * SENTRY_SOURCEMAPS=required のときだけ、上げられなければ失敗にする（公式の配布の CI 用）。
 *
 * 送り先は SENTRY_ORG / SENTRY_PROJECT で変えられる（既定 workspacepm / ferret）。
 * CLI は PATH の `sentry`、無ければ `npx sentry@<SENTRY_CLI_VERSION>` を使う。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const dir = resolve(root, option('--dir', 'out'))
const dryRun = flag('--dry-run')
const required = process.env.SENTRY_SOURCEMAPS === 'required'
const org = process.env.SENTRY_ORG || 'workspacepm'
const project = process.env.SENTRY_PROJECT || 'ferret'
const CLI_VERSION = process.env.SENTRY_CLI_VERSION || '0.44.1'
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const release = `ferret@${version}`

function skip(reason) {
  if (required) {
    console.error(`[sentry-sourcemaps] ${reason}（SENTRY_SOURCEMAPS=required のため止めます）`)
    process.exit(1)
  }
  console.warn(`[sentry-sourcemaps] ${reason}。ソースマップは上げずに続けます`)
  process.exit(0)
}

const dsnEnv = process.env.FERRET_SENTRY_DSN ?? process.env.MOVIE_ADE_SENTRY_DSN
if (dsnEnv !== undefined && !dsnEnv.trim()) {
  skip('FERRET_SENTRY_DSN が空（クラッシュレポートを送らない設定）')
}

function countMaps(d) {
  if (!existsSync(d)) return 0
  let n = 0
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) n += countMaps(join(d, e.name))
    else if (e.name.endsWith('.js.map')) n += 1
  }
  return n
}
const maps = countMaps(dir)
if (maps === 0) {
  console.error(`[sentry-sourcemaps] ${dir} に .js.map がありません。先に \`pnpm build\` を走らせてください`)
  process.exit(1)
}

/** PATH に sentry があればそれ、無ければ npx で取ってくる */
function cli() {
  const probe = spawnSync('sentry', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' })
  if (probe.status === 0) return ['sentry']
  return ['npx', '--yes', `sentry@${CLI_VERSION}`]
}
const [cmd, ...pre] = cli()
const env = { ...process.env, SENTRY_ORG: org, SENTRY_PROJECT: project }
const run = (rest, opts = {}) =>
  spawnSync(cmd, [...pre, ...rest], { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32', ...opts })

if (!process.env.SENTRY_AUTH_TOKEN?.trim()) {
  const status = run(['auth', 'status'], { stdio: 'ignore' })
  if (status.status !== 0) skip('SENTRY_AUTH_TOKEN が無く、sentry CLI にもログインしていません')
}

console.log(`[sentry-sourcemaps] ${org}/${project} の ${release} へ ${maps} 個のソースマップを上げます（${dir}）`)
if (dryRun) {
  // 書き換えずに、debug ID を入れる対象だけ見る
  const r = run(['sourcemap', 'inject', dir, '--dry-run'])
  process.exit(r.status ?? 1)
}
// release を先に作っておく（既にあれば何もしない）。イベントと同じ名前に結び付ける
run(['release', 'create', `${org}/${release}`, '--project', project])
// 配布版のスタックのファイル名は app:///out/... になる。debug ID で照合できないとき（予備）の名前も合わせる
const upload = run(['sourcemap', 'upload', dir, '--release', release, '--url-prefix', '~/out/'])
if (upload.status !== 0) {
  if (required) process.exit(upload.status ?? 1)
  console.warn('[sentry-sourcemaps] 上げられませんでした。配布物はそのまま作れますが、スタックトレースは読みにくくなります')
}

/*
 * ネイティブのモジュール（node-pty）の記号を上げる。ネイティブのクラッシュ（minidump）の node-pty の中のフレームを読めるようにする
 * （Electron 本体の記号は Sentry の組み込みの記号の置き場から引くので要らない）。
 * macOS は手元で作った build/Release、Windows は同梱の prebuilds（.pdb 付き）。Linux の build/Release はコンテナの中で作るので、ここでは上げない。
 * 新しい sentry CLI には記号を上げる命令が無いので、@sentry/cli の debug-files upload を使う。失敗してもビルドは止めない。
 */
const nativeDirs = ['node_modules/node-pty/build', 'node_modules/node-pty/prebuilds'].map((d) => join(root, d)).filter((d) => existsSync(d))
if (nativeDirs.length > 0) {
  // トークンは表示しない（CI は SENTRY_AUTH_TOKEN、手元はログイン済みの sentry CLI から子プロセスへ渡すだけ）
  const token = process.env.SENTRY_AUTH_TOKEN?.trim() || spawnSync(cmd, [...pre, 'auth', 'token'], { encoding: 'utf8', shell: process.platform === 'win32' }).stdout?.trim()
  const dif = spawnSync('npx', ['--yes', '@sentry/cli@2', 'debug-files', 'upload', '--org', org, '--project', project, ...nativeDirs], {
    cwd: root, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32', env: { ...process.env, SENTRY_AUTH_TOKEN: token ?? '' }
  })
  console.log(dif.status === 0 ? '[sentry-sourcemaps] node-pty の記号を上げました' : '[sentry-sourcemaps] node-pty の記号を上げられませんでした（ビルドは続けます）')
}
