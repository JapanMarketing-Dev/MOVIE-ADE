/**
 * Sentry のリリース（ferret@<version>）に、コミット・公開日・デプロイを結び付ける。
 * クラッシュの issue から「どのリリースで入ったか → 怪しいコミット」をたどれるようにする。
 *
 *   node scripts/sentry-release.mjs publish  --version 0.1.1 [--ref <sha>] [--since <tag>] [--dry-run]
 *     = commits + finalize + deploy（production）。release-r2.mjs の promote の最後に呼ぶ
 *   node scripts/sentry-release.mjs commits  --version 0.1.1 [--ref <sha>] [--since <tag>]
 *   node scripts/sentry-release.mjs finalize --version 0.1.1
 *   node scripts/sentry-release.mjs deploy   --version 0.1.1 [--env production]
 *
 * コミットは手元の git から作る（GitHub の連携が無くても使える）。各コミットに変更したファイル（patch_set）を付けるので、
 * スタックのファイルと突き合わせて怪しいコミットを出せる。範囲は --since（既定は --ref の1つ前のタグ）から --ref（既定 v<version>、無ければ HEAD）まで。
 * release は scripts/sentry-sourcemaps.mjs と src/shared/telemetry.ts の sentryRelease と同じ名前。
 *
 * 認証は sentry-sourcemaps.mjs と同じ（SENTRY_AUTH_TOKEN か、ログイン済みの sentry CLI）。どちらも無ければ警告だけで成功終了する
 * （公開の手順そのものは止めない）。SENTRY_RELEASE_REQUIRED=1 のときだけ失敗にする。
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const org = process.env.SENTRY_ORG || 'workspacepm'
const project = process.env.SENTRY_PROJECT || 'ferret'
const CLI_VERSION = process.env.SENTRY_CLI_VERSION || '0.44.1'
const repoName = process.env.SENTRY_REPO || 'JapanMarketing-Dev/ferret'

/** git log の1件分（--name-status 付き）を Sentry のコミットにする（単体テストから使うため export） */
export function parseGitLog(text, repository) {
  const commits = []
  for (const block of text.split('\u001e').map((b) => b.trim()).filter(Boolean)) {
    const [header, ...rest] = block.split('\n')
    const [id, authorName, authorEmail, timestamp, ...subject] = header.split('\u001f')
    const patchSet = []
    for (const line of rest) {
      const m = /^([AMDRC])\d*\t(?:[^\t]+\t)?(.+)$/.exec(line.trim())
      if (m) patchSet.push({ path: m[2], type: m[1] === 'D' ? 'D' : m[1] === 'A' ? 'A' : 'M' })
    }
    commits.push({ id, repository, author_name: authorName, author_email: authorEmail, timestamp, message: subject.join('\u001f'), patch_set: patchSet })
  }
  return commits
}

function parseArgs(argv) {
  const args = { command: argv[0], version: null, ref: null, since: null, env: 'production', dryRun: false }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--version') args.version = argv[++i]
    else if (a === '--ref') args.ref = argv[++i]
    else if (a === '--since') args.since = argv[++i]
    else if (a === '--env') args.env = argv[++i]
    else if (a === '--dry-run') args.dryRun = true
  }
  if (!args.version) args.version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  return args
}

const git = (...a) => {
  const r = spawnSync('git', a, { cwd: root, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

function cli() {
  const probe = spawnSync('sentry', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' })
  return probe.status === 0 ? ['sentry'] : ['npx', '--yes', `sentry@${CLI_VERSION}`]
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const release = `ferret@${args.version}`
  const required = process.env.SENTRY_RELEASE_REQUIRED === '1'
  const [cmd, ...pre] = cli()
  const run = (rest, opts = {}) => spawnSync(cmd, [...pre, ...rest], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', ...opts })
  const skip = (reason) => {
    console[required ? 'error' : 'warn'](`[sentry-release] ${reason}${required ? '' : '。Sentry のリリースの情報は付けずに続けます'}`)
    process.exit(required ? 1 : 0)
  }
  const dsnEnv = process.env.FERRET_SENTRY_DSN ?? process.env.MOVIE_ADE_SENTRY_DSN
  if (dsnEnv !== undefined && !dsnEnv.trim()) skip('FERRET_SENTRY_DSN が空（クラッシュレポートを送らない設定）')
  if (!process.env.SENTRY_AUTH_TOKEN?.trim() && run(['auth', 'status'], { stdio: 'ignore' }).status !== 0) {
    skip('SENTRY_AUTH_TOKEN が無く、sentry CLI にもログインしていません')
  }
  const steps = args.command === 'publish' ? ['commits', 'finalize', 'deploy'] : [args.command]
  let failed = false
  for (const step of steps) {
    if (step === 'commits') {
      const ref = args.ref ?? (git('rev-parse', '--verify', '--quiet', `v${args.version}^{commit}`) ? `v${args.version}` : 'HEAD')
      const since = args.since ?? git('describe', '--tags', '--abbrev=0', `${ref}^`)
      const range = since ? `${since}..${ref}` : ref
      const log = git('log', '--no-merges', '--name-status', '--format=%x1e%H%x1f%an%x1f%ae%x1f%aI%x1f%s', ...(since ? [range] : ['-n', '50', ref]))
      if (log === null) { console.warn(`[sentry-release] git log を読めませんでした（${range}）`); failed = true; continue }
      const commits = parseGitLog(log, repoName)
      console.log(`[sentry-release] ${release} に ${commits.length} 件のコミット（${range}）を付けます`)
      if (args.dryRun) continue
      // リリースが無ければ作る（あれば何もしない）
      run(['release', 'create', `${org}/${release}`, '--project', project], { stdio: 'ignore' })
      const dir = mkdtempSync(join(tmpdir(), 'sentry-release-'))
      const body = join(dir, 'commits.json')
      writeFileSync(body, JSON.stringify({ commits }))
      const r = run(['api', `organizations/${org}/releases/${encodeURIComponent(release)}/`, '-X', 'PUT', '--input', body, '--silent'])
      rmSync(dir, { recursive: true, force: true })
      if (r.status !== 0) failed = true
    } else if (step === 'finalize') {
      if (run(['release', 'finalize', `${org}/${release}`, ...(args.dryRun ? ['--dry-run'] : [])]).status !== 0) failed = true
    } else if (step === 'deploy') {
      if (run(['release', 'deploy', `${org}/${release}`, args.env, ...(args.dryRun ? ['--dry-run'] : [])]).status !== 0) failed = true
    } else {
      console.error(`[sentry-release] 知らない指定です: ${step}（publish / commits / finalize / deploy）`)
      process.exit(2)
    }
  }
  if (failed) {
    if (required) process.exit(1)
    console.warn('[sentry-release] 一部を付けられませんでした。公開そのものは済んでいます')
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
