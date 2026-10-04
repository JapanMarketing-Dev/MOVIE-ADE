#!/usr/bin/env node
/**
 * クラッシュが Sentry に届くかを、ビルドしたアプリを実際に落として確かめる（src/main/telemetry.ts の確認用の起動）。
 *
 * 単体テストには入れない。本物の Sentry（既定の DSN）へ environment=verification で送る（production を汚さない）。
 * 同じ userData で、次の順に起動する:
 *   js             … main の未処理の Promise の拒否・renderer の例外・ErrorBoundary・IPC の例外（main,renderer,boundary,ipc）
 *   crash-renderer … main のウインドウの renderer を落とす（render-process-gone と、renderer の minidump 由来のイベント）
 *   uncaught       … main で捕まえていない例外（送ってから自分で終わる）
 *   crash-main     … main のネイティブのクラッシュ（process.crash）。minidump は Crashpad が userData に書く
 *   after-crash    … ふつうに起動し、前の起動の minidump 由来のイベントを送る
 *
 *   pnpm build && node tools/qa/sentry-crash-verify.mjs                  # out/ を素の Electron で起動
 *   node tools/qa/sentry-crash-verify.mjs --app <配布物の実行ファイル>     # 展開済みのアプリ（linux-unpacked/ferret・win-unpacked/Ferret.exe・Ferret.app/Contents/MacOS/Ferret）
 *   オプション: --stages js,crash-main,after-crash（既定は全部）  --no-sandbox（root のコンテナ・CI の Linux）
 *
 * 最後にインストール ID（Sentry の user.id）を出す。届いたかは
 *   sentry explore workspacepm/ferret --dataset errors --query 'user.id:<ID>' --field title --field os.platform
 * で引く。使っている人の環境は使わない: HOME・userData・FERRET_CONFIG_DIR・CLAUDE_CONFIG_DIR・CODEX_HOME・ZDOTDIR は一時フォルダ、
 * ADE_E2E=1（ウインドウを出さない）・ADE_SYNTHETIC_MIC=1（マイクの許可を求めない）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** 段ごとの FERRET_SENTRY_TEST と、待つ長さ（自分で終わる段は、終わるまでの上限） */
export const STAGES = {
  js: { test: 'main,renderer,boundary,ipc', waitMs: 25_000, selfExit: false },
  'crash-renderer': { test: 'crash-renderer', waitMs: 25_000, selfExit: false },
  uncaught: { test: 'uncaught', waitMs: 45_000, selfExit: true },
  'crash-main': { test: 'crash-main', waitMs: 45_000, selfExit: true },
  'after-crash': { test: '', waitMs: 30_000, selfExit: false }
}

export function parseArgs(argv) {
  const opts = { app: null, stages: Object.keys(STAGES), noSandbox: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--app') opts.app = resolve(argv[++i] ?? '')
    else if (a === '--stages') opts.stages = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--no-sandbox') opts.noSandbox = true
    else throw new Error(`知らない引数: ${a}`)
  }
  for (const s of opts.stages) if (!(s in STAGES)) throw new Error(`知らない段: ${s}（${Object.keys(STAGES).join(', ')}）`)
  return opts
}

/** Crashpad が書いた minidump の数（userData/Crashpad の下の .dmp） */
function countDumps(dir) {
  let n = 0
  const walk = (d) => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(d, e.name))
      else if (e.name.endsWith('.dmp')) n++
    }
  }
  walk(dir)
  return n
}

function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGTERM')
}

function runStage(name, { command, args, env, userData }) {
  const stage = STAGES[name]
  return new Promise((done) => {
    const started = Date.now()
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...env, FERRET_SENTRY_TEST: stage.test },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const log = []
    child.stdout.on('data', (d) => log.push(String(d)))
    child.stderr.on('data', (d) => log.push(String(d)))
    const timer = setTimeout(() => {
      stop(child)
      // SIGTERM で終わらないときの念押し
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 10_000).unref()
    }, stage.waitMs)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      const ms = Date.now() - started
      const selfExited = ms < stage.waitMs
      done({ name, code, signal, ms, selfExited, dumps: countDumps(join(userData, 'Crashpad')), log: log.join('') })
    })
  })
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const base = mkdtempSync(join(tmpdir(), 'ferret-sentry-verify-'))
  const dirs = Object.fromEntries(['home', 'user-data', 'config', 'claude', 'codex', 'zdotdir', 'project'].map((n) => [n, join(base, n)]))
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })
  writeFileSync(join(dirs.zdotdir, '.zshrc'), "PROMPT='acme-shop %% '\n")
  writeFileSync(join(dirs.project, 'README.md'), '# acme-shop\n')

  const require = createRequire(join(ROOT, 'package.json'))
  const command = opts.app ?? require('electron')
  const args = [
    ...(opts.app ? [] : ['.']),
    `--user-data-dir=${dirs['user-data']}`,
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    ...(opts.noSandbox ? ['--no-sandbox'] : [])
  ]
  const env = {
    ...process.env,
    ADE_E2E: '1',
    ADE_SYNTHETIC_MIC: '1',
    ADE_PROJECT_DIR: dirs.project,
    FERRET_SENTRY_FORCE: '1',
    HOME: dirs.home,
    USERPROFILE: process.platform === 'win32' ? dirs.home : process.env.USERPROFILE,
    FERRET_CONFIG_DIR: dirs.config,
    CLAUDE_CONFIG_DIR: dirs.claude,
    CODEX_HOME: dirs.codex,
    ZDOTDIR: dirs.zdotdir
  }
  // 送り先の上書き（フォーク・空にして送らない）はここでは受けない。既定の DSN へ送る
  delete env.FERRET_SENTRY_DSN
  delete env.MOVIE_ADE_SENTRY_DSN
  delete env.VITEST

  console.log(`== Sentry クラッシュ確認 (${process.platform}-${process.arch}) 一時フォルダ: ${base}`)
  const results = []
  for (const name of opts.stages) {
    console.log(`-- ${name}: 起動（FERRET_SENTRY_TEST=${STAGES[name].test || '(なし)'}）`)
    const r = await runStage(name, { command, args, env, userData: dirs['user-data'] })
    results.push(r)
    console.log(`   終了 code=${r.code} signal=${r.signal} ${(r.ms / 1000).toFixed(1)}s 自分で終了=${r.selfExited} minidump=${r.dumps}`)
    if (process.env.FERRET_SENTRY_VERIFY_LOG === '1') console.log(r.log)
  }

  let installId = '(なし)'
  try {
    installId = readFileSync(join(dirs['user-data'], 'telemetry-install-id'), 'utf8').trim()
  } catch {
    // Sentry を初期化しなかった（設定・DSN・環境変数のどれかで送らない側になった）
  }
  console.log(`== インストール ID（Sentry の user.id）: ${installId}`)
  console.log(`   sentry explore workspacepm/ferret --dataset errors --query 'user.id:${installId}' --field title --field os.platform --field environment --period 1d`)

  // 段が想定どおりに終わったか（届いたかは Sentry で引いて確かめる）
  const problems = []
  for (const r of results) {
    if (STAGES[r.name].selfExit && !r.selfExited) problems.push(`${r.name}: 自分で終わらなかった`)
    if (!STAGES[r.name].selfExit && r.selfExited) problems.push(`${r.name}: 待つ前に終わった（code=${r.code} signal=${r.signal}）`)
  }
  const crash = results.find((r) => r.name === 'crash-main')
  if (crash && crash.dumps === 0) problems.push('crash-main: Crashpad が minidump を書いていない')
  const after = results.find((r) => r.name === 'after-crash')
  if (crash && after && after.dumps !== 0) problems.push('after-crash: 前の起動の minidump が残っている（送る処理が拾っていない）')
  if (installId === '(なし)') problems.push('Sentry を初期化していない（インストール ID が無い）')
  for (const p of problems) console.error(`NG ${p}`)
  if (problems.length) process.exitCode = 1
  else console.log('OK 全部の段が想定どおりに終わった')
}

// 単体テスト（test/unit/sentry-verify.test.ts）が段の表だけを読むときは起動しない
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
