#!/usr/bin/env node
/**
 * 録画 → 文字起こし → 指摘 → Agentへ送信 の通し確認（人が実機でやる流れを自動で1周する）。
 *
 * 単体テスト（pnpm test:unit）には入れない。実際にアプリを起動し、whisper.cpp で文字起こしするので数十秒かかる。
 *
 *   pnpm build                                   # out/ を作る（別の場所でビルドしたなら --app でその場所）
 *   node tools/qa/flow-check.mjs                 # 内蔵ブラウザのページを録る
 *   node tools/qa/flow-check.mjs --target preview  # ファイルのプレビュー（ade-preview://）を録る
 *   node tools/qa/flow-check.mjs --agent gemini  # ▾ で Gemini CLI（Claude Code / Codex 以外）を選んで送る
 *   node tools/qa/flow-check.mjs --claude-node   # claude が node で動き、子に codex（MCP）がいる形
 *   node tools/qa/flow-check.mjs --noise         # 話さず物音だけ（*claps* などのタグが見出しにならないか）
 *   node tools/qa/flow-check.mjs --no-agents --no-pen  # Agent を開かずに送信（既定の Agent が起動して届くか）
 *   オプション: --app <ビルド済みのフォルダ>  --out <結果の置き場>  --show（ウインドウを出す）
 *
 * 使っている人の環境を汚さない・OS のダイアログを出さないための約束:
 * - ADE_E2E=1（ウインドウを出さない・キーチェーンを使わない）、ADE_SYNTHETIC_MIC=1 ＋ ADE_QA_AUDIO（実機のマイクを開かず、
 *   macOS の `say` で作った英語の音声を録音の入力として流す）
 * - userData・FERRET_CONFIG_DIR・CLAUDE_CONFIG_DIR・CODEX_HOME・ZDOTDIR はすべて一時フォルダ
 * - claude / codex は本物を使わない。tools/qa/flow/fake-agent.c をその場でビルドした偽物を PATH の先頭に置く。
 *   claude は公式インストーラと同じ形（versions/<版> の実体を claude のリンクから起動）にして、前面プロセス名が版番号になる状況を再現する。
 *   偽物は受け取った入力を agent-input.log に書くので、送られた本文をそのまま確かめられる
 * - 文字起こしは端末内の whisper.cpp（whisper-cli ＋ ~/.cache/ade-movie/models/ggml-small.bin）。無ければ文字起こしの検査を飛ばす
 *
 * 結果（スクリーンショット・ログ・summary.json）は --out（既定は一時フォルダ）に置く。どれかの検査が落ちたら終了コード1。
 */
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const APP = resolve(opt('app', resolve(HERE, '../..')))
const TARGET = opt('target', 'page')
/** --no-pen: 話すだけ（ペンなし）。--no-agents: 起動時に Agent を開かない（送信で既定の Agent が起動するかを見る） */
const PEN = !args.includes('--no-pen')
/** --noise: 話さず、手を叩いたような物音だけを流す（whisper が「(gunshots)」「*claps*」のようなタグを付ける状況） */
const NOISE = args.includes('--noise')
/** --claude-node: claude を npm 版と同じく node で動かし、MCP サーバーとして codex を子に起動させる */
const CLAUDE_NODE = args.includes('--claude-node')
/** --agent <id>: 送信の ▾ でその Agent を選んで送る（例 gemini。動いていなければ起動してから送る） */
const SEND_AGENT = opt('agent', '')
const STARTUP_AGENTS = args.includes('--no-agents') ? [] : ['claude', 'codex']
const WORK = resolve(opt('out', '') || (await mkdtemp(join(tmpdir(), 'ferret-flow-'))))
const SHOTS = join(WORK, 'screenshots')
const SPEECH = 'Make the sign up button stand out.'
const MODEL = join(homedir(), '.cache/ade-movie/models/ggml-small.bin')
const require = createRequire(join(APP, 'package.json'))

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(fn, timeoutMs, stepMs = 250) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn().catch(() => undefined)
    if (last) return last
    await sleep(stepMs)
  }
  return last
}

// ───────── 準備（すべて WORK の中） ─────────

await mkdir(SHOTS, { recursive: true })
const dirs = Object.fromEntries(await Promise.all(['userdata', 'config', 'claude-config', 'codex-home', 'zdotdir', 'project', 'fake/bin', 'fake/versions'].map(async (name) => {
  await mkdir(join(WORK, name), { recursive: true })
  return [name, join(WORK, name)]
})))

// 偽の claude / codex
const fakeBinary = join(dirs['fake/versions'], '2.1.288')
execFileSync('cc', ['-O1', '-o', fakeBinary, join(HERE, 'flow/fake-agent.c')])
if (CLAUDE_NODE) {
  await copyFile(join(HERE, 'flow/fake-claude-node.cjs'), join(dirs['fake/bin'], 'claude'))
  await chmod(join(dirs['fake/bin'], 'claude'), 0o755)
} else {
  await symlink(fakeBinary, join(dirs['fake/bin'], 'claude')).catch(() => undefined)
}
execFileSync('cc', ['-O1', '-o', join(dirs['fake/bin'], 'codex'), join(HERE, 'flow/fake-agent.c')])
execFileSync('cc', ['-O1', '-o', join(dirs['fake/bin'], 'gemini'), join(HERE, 'flow/fake-agent.c')])
const AGENT_LOG = join(WORK, 'agent-input.log')

// PTY のシェル。個人の .zshrc を読まず、偽物を PATH の先頭に置く。プロンプトは中立に
for (const name of ['.zshenv', '.zprofile', '.zlogin']) await writeFile(join(dirs.zdotdir, name), '# flow-check\n')
await writeFile(join(dirs.zdotdir, '.zshrc'), `export PATH=${JSON.stringify(dirs['fake/bin'])}:$PATH\nPS1='qa %% '\n`)

// 設定（オンボーディング済み・英語・端末内の文字起こし）
await writeFile(join(dirs.config, 'settings.json'), JSON.stringify({
  locale: 'en',
  crashReports: false,
  crashReportsNoticeShown: true,
  onboarding: { completedAt: new Date().toISOString() },
  capture: { transcription: 'local', language: 'en', captureMic: true },
  agents: { startupAgents: STARTUP_AGENTS }
}, null, 2))

// 録音に流す音声（16kHz モノラル）。前後に無音を足して、話し終わりの区切りが付くようにする
const speechAiff = join(WORK, 'speech.aiff')
const speechWav = join(WORK, 'speech.wav')
if (NOISE) {
  // 1秒ごとに 75ms の破裂音（減衰するノイズ）。16kHz モノラルの WAV を直接書く
  const rate = 16_000
  const pcm = Buffer.alloc(rate * 6 * 2)
  for (let i = 0; i < rate * 6; i++) {
    const k = i % rate
    const v = k < 1200 ? (Math.random() * 2 - 1) * 20_000 * (1 - k / 1200) : (Math.random() * 2 - 1) * 60
    pcm.writeInt16LE(Math.round(v), i * 2)
  }
  const head = Buffer.alloc(44)
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28)
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(pcm.length, 40)
  await writeFile(speechWav, Buffer.concat([head, pcm]))
} else {
  execFileSync('say', ['-v', 'Samantha', '-o', speechAiff, `[[slnc 600]] ${SPEECH} [[slnc 1500]]`])
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', speechAiff, speechWav])
}

// 題材のページとファイル
const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Demo shop</title>
<style>body{font:16px -apple-system,sans-serif;margin:0;background:#f6f7f9;color:#222}header{padding:24px 40px;background:#fff;border-bottom:1px solid #ddd}
main{padding:40px}h1{margin:0 0 12px}p{max-width:520px;line-height:1.6}#signup{margin-top:24px;padding:10px 22px;font-size:15px;border:1px solid #bbb;background:#eee;color:#555;border-radius:6px}</style>
<header><strong>Demo shop</strong></header><main><h1>Fresh coffee, delivered</h1>
<p>Choose your beans, pick a schedule and we deliver to your door every week. Cancel any time.</p>
<button id="signup">Sign up</button></main></html>`
await writeFile(join(dirs.project, 'index.html'), PAGE)
await mkdir(join(dirs.project, 'config'), { recursive: true })
await writeFile(join(dirs.project, 'config/all-procurement.config.ts'), Array.from({ length: 40 }, (_, i) =>
  i === 0 ? 'export const procurement = {' : i === 39 ? '}' : `  supplier${i}: { name: 'Supplier ${i}', leadTimeDays: ${(i * 3) % 17 + 2}, active: ${i % 3 !== 0} },`).join('\n'))

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGE)
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const siteUrl = `http://127.0.0.1:${server.address().port}/`
const startUrl = TARGET === 'preview' ? 'ade-preview://project/config/all-procurement.config.ts' : siteUrl

// ───────── 起動 ─────────

const env = {
  ...process.env,
  ADE_E2E: '1',
  ...(args.includes('--show') ? { ADE_E2E_SHOW: '1' } : {}),
  ADE_SYNTHETIC_MIC: '1',
  ADE_QA_AUDIO: speechWav,
  ADE_DEMO: '0',
  ADE_E2E_STARTUP_AGENTS: '1',
  ADE_PROJECT_DIR: dirs.project,
  ADE_INITIAL_URL: startUrl,
  FERRET_CONFIG_DIR: dirs.config,
  CLAUDE_CONFIG_DIR: dirs['claude-config'],
  CODEX_HOME: dirs['codex-home'],
  ZDOTDIR: dirs.zdotdir,
  SHELL: '/bin/zsh',
  FAKE_AGENT_LOG: AGENT_LOG,
  // 偽物を「インストール済み」として見つけさせる（Agent の一覧は PATH を見る）
  PATH: `${dirs['fake/bin']}:${process.env.PATH ?? ''}`,
  ...(existsSync(MODEL) ? { ADE_WHISPER_MODEL: MODEL } : {})
}
delete env.ANTHROPIC_API_KEY
delete env.OPENAI_API_KEY

const app = await electron.launch({ executablePath: require('electron'), args: [APP, `--user-data-dir=${dirs.userdata}`], cwd: APP, env, timeout: 60_000 })
const mainLog = []
app.process().stdout?.on('data', (d) => mainLog.push(String(d)))
app.process().stderr?.on('data', (d) => mainLog.push(String(d)))
const isUi = (p) => p.url().includes('/renderer/index.html')
let ui = await until(async () => app.windows().find(isUi) ?? (await app.waitForEvent('window', { timeout: 2000 }).catch(() => null), app.windows().find(isUi)), 30_000)
const rendererErrors = []
ui.on('pageerror', (e) => rendererErrors.push(String(e)))
ui.on('console', (m) => { if (m.type() === 'error') rendererErrors.push(m.text()) })
await ui.waitForSelector('[data-testid="topbar"]', { timeout: 30_000 })
const browserPage = () => app.windows().find((p) => !isUi(p) && !p.url().includes('/recorder/index.html'))

/** UI と内蔵ブラウザ（別レイヤーの WebContentsView）を重ねて1枚にする（e2e/helpers.ts の captureComposite と同じ方法） */
async function shot(name) {
  await sleep(400)
  const uiShot = (await ui.screenshot()).toString('base64')
  const view = await app.evaluate(async ({ BrowserWindow, WebContentsView }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('/renderer/index.html'))
    const child = w?.contentView.children.find((c) => c instanceof WebContentsView)
    if (!child) return null
    const bounds = child.getBounds()
    if (bounds.width <= 0 || bounds.height <= 0 || !child.getVisible?.()) return null
    return { bounds, png: (await child.webContents.capturePage()).toPNG().toString('base64') }
  })
  const composite = await ui.evaluate(async ({ uiShot, view }) => {
    const load = (b64) => new Promise((done, fail) => { const i = new Image(); i.onload = () => done(i); i.onerror = fail; i.src = `data:image/png;base64,${b64}` })
    const base = await load(uiShot)
    const canvas = Object.assign(document.createElement('canvas'), { width: base.width, height: base.height })
    const ctx = canvas.getContext('2d')
    ctx.drawImage(base, 0, 0)
    if (view?.png) {
      const s = base.width / document.documentElement.clientWidth
      ctx.drawImage(await load(view.png), view.bounds.x * s, view.bounds.y * s, view.bounds.width * s, view.bounds.height * s)
    }
    return canvas.toDataURL('image/png').split(',')[1]
  }, { uiShot, view })
  const path = join(SHOTS, `${name}.png`)
  await writeFile(path, Buffer.from(composite, 'base64'))
  console.log(`      screenshot: ${path}`)
  return path
}

let exitCode = 0
try {
  // ① 起動して、Agent のタブが立ち上がるのを待つ
  await until(async () => browserPage()?.url().startsWith(startUrl.slice(0, 20)), 20_000)
  const tabs = await until(async () => {
    const list = await ui.evaluate(() => window.ade.invoke('terminal:list'))
    return list.length >= Math.max(1, STARTUP_AGENTS.length) ? list : undefined
  }, 20_000)
  if (STARTUP_AGENTS.length) {
  check('起動時に startupAgents（claude, codex）のタブが開く', tabs?.length >= 2, JSON.stringify(tabs?.map((x) => x.title ?? x.id)))
  const claudeState = await until(async () => {
    for (const tab of await ui.evaluate(() => window.ade.invoke('terminal:list'))) {
      const s = await ui.evaluate((id) => window.ade.invoke('terminal:agentState', id), tab.id)
      if (s.kind === 'claude-code' && s.state === 'idle') return { id: tab.id, ...s }
    }
  }, 20_000, 500)
  check(CLAUDE_NODE ? '偽の claude（node で動き、子に codex の MCP サーバー）を Claude Code として認識する' : '偽の claude（前面プロセス名が版番号）を Claude Code として認識する', claudeState, JSON.stringify(claudeState ?? null))
  }
  await shot('01-launched')

  // ② 録画開始（タイトルバーの録画ボタン）→ ペンで「Sign up」を囲む
  await ui.getByTestId('record-button').click()
  const recording = await until(async () => (await ui.evaluate(() => window.ade.invoke('recording:status'))).state === 'recording', 10_000)
  check('録画が始まる', recording)
  const page = browserPage()
  await page.waitForLoadState('domcontentloaded')
  await sleep(800)
  const box = TARGET === 'preview'
    ? await page.evaluate(() => { const r = document.querySelector('pre, main')?.getBoundingClientRect(); return r && { x: r.x + 60, y: r.y + 80, width: 260, height: 60 } })
    : await page.evaluate(() => { const r = document.getElementById('signup').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })
  if (PEN) {
  await ui.getByRole('button', { name: 'Pen', exact: true }).click()
  await sleep(300)
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const rx = box.width / 2 + 24
  const ry = box.height / 2 + 18
  await page.mouse.move(cx + rx, cy)
  await page.mouse.down()
  for (let a = 0; a <= Math.PI * 2.05; a += Math.PI / 16) {
    await page.mouse.move(cx + rx * Math.cos(a), cy + ry * Math.sin(a))
    await sleep(25)
  }
  await page.mouse.up()
  }
  await shot('02-recording-pen')
  // 音声（約4秒）が流れ終わるまで録る
  await sleep(4500)

  // ③ 停止 → 指摘ができるまで待つ
  await ui.getByTestId('feedback-record').click()
  const findings = await until(async () => (await ui.getByTestId('findings').count()) > 0 && (await ui.locator('[data-testid^="review-item-"]').count()) > 0, 120_000, 500)
  check('停止後に指摘の画面が出て、指摘が1件以上ある', findings)
  await sleep(600)
  await shot('03-findings')

  // 指摘の中身（保存された review.json / feedback.md）
  const reviewsDir = join(dirs.project, '.ferret/reviews')
  const session = (await readdir(reviewsDir)).filter((n) => /^\d{8}-\d{6}$/.test(n)).sort().at(-1)
  const sessionDir = join(reviewsDir, session)
  const transcript = await readFile(join(sessionDir, 'transcript.jsonl'), 'utf8').catch(() => '')
  const feedbackMd = await readFile(join(sessionDir, 'feedback.md'), 'utf8').catch(() => '')
  await writeFile(join(WORK, 'feedback.md'), feedbackMd)
  await writeFile(join(WORK, 'transcript.jsonl'), transcript)
  const cards = await ui.locator('[data-testid^="review-item-"]').evaluateAll((els) => els.map((el) => ({
    title: el.querySelector('.rv-card__title')?.value ?? '',
    request: el.querySelector('.rv-card__request')?.value ?? '',
    transcript: el.querySelector('.rv-card__transcript, .rv-card__quote')?.textContent ?? '',
    image: el.querySelector('.rv-card__shot img')?.getAttribute('src') ?? ''
  })))
  console.log('      cards:', JSON.stringify(cards.map(({ image, ...rest }) => rest)))
  const spoken = /sign.?up/i
  if (NOISE) {
    check('物音だけなら、ペンで囲んだ要素が見出しになる', cards.some((c) => /^Pen mark at /.test(c.title)), JSON.stringify(cards.map((c) => c.title)))
  } else if (existsSync(MODEL)) {
    check('文字起こしに話した言葉（sign up）が入る', spoken.test(transcript), transcript.trim().slice(0, 200))
    check('指摘の見出しか要望に話した言葉が入る', cards.some((c) => spoken.test(`${c.title} ${c.request}`)), JSON.stringify(cards.map((c) => c.title)))
  } else {
    check('文字起こしの検査（モデルが無いので飛ばした）', true, MODEL)
  }
  check('効果音のタグ（*claps* など）が見出しにならない', cards.every((c) => !/[*[(（♪]/.test(c.title.replace(/^Pen mark at .*/, ''))), JSON.stringify(cards.map((c) => c.title)))

  // 静止画: 囲んだ場所の中身が写っているか（白一色・帯だけでないこと、ペンの色があること）
  const first = cards.find((c) => c.image)
  if (first) {
    const b64 = first.image.replace(/^data:image\/\w+;base64,/, '')
    await writeFile(join(SHOTS, '04-finding-still.png'), Buffer.from(b64, 'base64'))
    console.log(`      screenshot: ${join(SHOTS, '04-finding-still.png')}`)
    const stats = await ui.evaluate(async (src) => {
      const img = await new Promise((done, fail) => { const i = new Image(); i.onload = () => done(i); i.onerror = fail; i.src = src })
      const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height })
      const ctx = c.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      let pen = 0
      let ink = 0
      const rows = new Set()
      for (let i = 0; i < d.length; i += 4) {
        const [r, g, b] = [d[i], d[i + 1], d[i + 2]]
        if (r > 170 && g < 110 && b < 200) pen++
        const lum = 0.3 * r + 0.59 * g + 0.11 * b
        if (lum < 140) { ink++; rows.add(Math.floor(i / 4 / c.width)) }
      }
      return { width: c.width, height: c.height, pen, ink, inkRows: rows.size }
    }, first.image)
    if (PEN) check('指摘の静止画にペンの線が写る', stats.pen > 300, JSON.stringify(stats))
    check('指摘の静止画に中身（文字や部品）が写る', stats.inkRows > stats.height * 0.05 && stats.height > 120, JSON.stringify(stats))
  } else {
    check('指摘に静止画がある', false)
  }

  // ④ 指摘の画面から次の録画を始めるボタン
  const recordAgain = ui.getByTestId('findings-record')
  check('指摘の画面に「Record feedback」ボタンがある', (await recordAgain.count()) > 0)

  // ⑤ Agentへ送信 → 偽の claude（--agent ならその Agent）に feedback.md の指示が届く
  if (SEND_AGENT) {
    await ui.getByTestId('send-target-toggle').click()
    const item = ui.getByTestId(`send-target-agent-${SEND_AGENT}`)
    check(`送信の ▾ に ${SEND_AGENT} が出る`, await item.isVisible().catch(() => false))
    await shot('05a-send-target-menu')
    await item.click()
    const label = await ui.getByTestId('send-to-agent').innerText()
    check('ボタンが選んだ宛先の名前になる', /Gemini|gemini/.test(label) || !SEND_AGENT.includes('gemini'), label)
  }
  await ui.getByTestId('send-to-agent').click()
  // Agent が居なければ既定の Agent が起動してから送られる（最大 45 秒）
  const toast = await until(async () => {
    const text = (await ui.getByTestId('toast-host').innerText()).trim()
    return /Sent the instructions|pressed Enter|Pasted into|Start Codex|did not get ready|could not|failed|waiting for confirmation|Wait until/i.test(text) ? text : undefined
  }, 60_000)
  await sleep(800)
  const received = await readFile(AGENT_LOG, 'utf8').catch(() => '')
  await shot('05-sent')
  check('送信の結果が成功として出る', toast && !/Start Codex or Claude Code/i.test(toast) && /Sent the instructions|pressed Enter/i.test(toast), toast)
  const expected = SEND_AGENT || 'claude'
  check(`${expected} のターミナルに feedback.md の指示が届く`, new RegExp(`(^|\\n)${expected}:[^\\n]*feedback\\.md`).test(received), received.slice(0, 300).replace(/\x1b/g, '\\e'))

  // ⑥ 「Record feedback」から次の録画が始まる
  if ((await recordAgain.count()) > 0) {
    await recordAgain.first().click()
    const again = await until(async () => (await ui.evaluate(() => window.ade.invoke('recording:status'))).state === 'recording', 10_000)
    check('「Record feedback」で録画が始まる', again)
    await shot('06-record-again')
    if (again) await ui.evaluate(() => window.ade.invoke('recording:stop')).catch(() => undefined)
  }
} catch (err) {
  check('通し確認が最後まで進む', false, String(err?.stack ?? err))
  await shot('99-error').catch(() => undefined)
} finally {
  await writeFile(join(WORK, 'main.log'), mainLog.join(''))
  await writeFile(join(WORK, 'renderer-errors.log'), rendererErrors.join('\n'))
  await writeFile(join(WORK, 'summary.json'), JSON.stringify({ target: TARGET, pen: PEN, noise: NOISE, claudeNode: CLAUDE_NODE, sendAgent: SEND_AGENT, startupAgents: STARTUP_AGENTS, work: WORK, checks }, null, 2))
  await app.close().catch(() => undefined)
  server.close()
  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} passed. results: ${WORK}`)
  if (failed.length) exitCode = 1
}
process.exit(exitCode)
