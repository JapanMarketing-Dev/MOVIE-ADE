import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { setLocale } from '@shared/i18n'
import {
  DECISION_ENV,
  LEGACY_DECISION_ENV,
  DEFAULT_DECISION_PREFERENCES,
  applyDecisionPreset,
  decisionTerminalEnvChanged,
  decisionAuthHeader,
  resolveDecision,
  sanitizeDecisionPreferences,
  type DecisionPreferences
} from '@shared/decision'
import { defaultAgentPrompt, renderAgentPrompt } from '@shared/agentPrompt'
import { formatHeaderLines, parseHeaderLines } from '@shared/aiProviders'
import type { FeedbackDocument, FeedbackItem } from '../../src/main/pipeline/types'
import { DECISION_NODE_LINE, DECISION_QUESTIONS_JSON, renderFeedbackMarkdown } from '../../src/main/pipeline/feedback'
import { isInheritedAgentSessionEnv } from '../../src/main/inheritedAgentEnv'
import { DecisionRelay, LEGACY_RELAY_TOKEN_HEADER, RELAY_TOKEN_HEADER, RelayConfigError, type RelayUpstream } from '../../src/main/decision/relay'
import { DecisionService } from '../../src/main/decision/service'
import { CallLog, aggregateCalls, callLogFile, estimateCost, extractUsage, sanitizeCallRecord } from '../../src/main/decision/callLog'
import { issueFromFeedback } from '../../src/main/github/parse'
import { projectLabel, type ApiCallRecord } from '@shared/apiUsage'

// settings.ts は保存先を決めるためだけに electron の app を読む。単体テストでは呼ばれない
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-unit' } }))
const { sanitize } = await import('../../src/main/settings')

setLocale('en')

const SECRET = 'sk-test-SECRET-value-1234567890'
const dirs: string[] = []
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }) })
const tempDir = async () => { const d = await mkdtemp(join(tmpdir(), 'ade-decision-')); dirs.push(d); return d }

describe('判定モデルの設定', () => {
  it('既定は Ollama + clef-flash で無効。壊れた値は捨て、http(s) 以外の URL は使わない', () => {
    expect(sanitizeDecisionPreferences(undefined)).toEqual(DEFAULT_DECISION_PREFERENCES)
    expect(sanitizeDecisionPreferences({ enabled: 'yes', preset: 'nope', endpoint: 'file:///etc/passwd', model: 'has space', passThreshold: 3, headers: { 'Content-Type': 'x', 'bad name': 'y', Authorization: 'Bearer plain-secret' }, headersEnv: { 'X-A': '1BAD' } }))
      .toEqual({ enabled: false, preset: 'ollama', passThreshold: 0.99 })
    expect(resolveDecision(DEFAULT_DECISION_PREFERENCES)).toMatchObject({ url: 'http://localhost:11434/v1/systemone', model: 'clef-flash', images: true, authScheme: 'none', passThreshold: 0.7, missing: [] })
  })

  it('以前の backend / baseUrl を preset / 完全な URL へ移す', () => {
    expect(sanitizeDecisionPreferences({ enabled: true, backend: 'typesafe', baseUrl: 'https://api.typesafe.ai/' }))
      .toEqual({ enabled: true, preset: 'typesafe', endpoint: 'https://api.typesafe.ai/v1/systemone' })
  })

  it('settings.json の decision を整える。未設定なら書かない', () => {
    expect(sanitize({})).not.toHaveProperty('decision')
    expect(sanitize({ decision: { enabled: true, preset: 'cloudflare', accountId: 'abc123', apiKeyEnv: 'CLOUDFLARE_API_TOKEN' } }).decision)
      .toEqual({ enabled: true, preset: 'cloudflare', accountId: 'abc123', apiKeyEnv: 'CLOUDFLARE_API_TOKEN' })
  })

  it('プリセットは欄を埋めるだけ（有効の状態・しきい値・キーは持ち越す）', () => {
    const base: DecisionPreferences = { enabled: true, preset: 'ollama', passThreshold: 0.8, apiKey: SECRET }
    expect(applyDecisionPreset(base, 'vercel')).toEqual({ enabled: true, preset: 'vercel', endpoint: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone',
      model: 'typesafe-ai/jev', images: false, imageFormat: 'base64', authScheme: 'bearer', apiKeyEnv: 'AI_GATEWAY_API_KEY', apiKey: SECRET, passThreshold: 0.8 })
    expect(applyDecisionPreset(base, 'typesafe')).toMatchObject({ endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', apiKeyEnv: 'TYPESAFE_API_KEY' })
    // Cloudflare は data URI でないと 422（実機で確認）
    expect(applyDecisionPreset(base, 'cloudflare')).toMatchObject({ model: 'clef-flash', images: true, imageFormat: 'data-uri', apiKeyEnv: 'CLOUDFLARE_API_TOKEN' })
    expect(applyDecisionPreset(base, 'custom')).toEqual({ enabled: true, preset: 'custom', images: false, imageFormat: 'base64', authScheme: 'bearer', apiKey: SECRET, passThreshold: 0.8 })
    // 選んだあとも書き換えられる
    expect(resolveDecision({ ...applyDecisionPreset(base, 'ollama'), model: 'clef', endpoint: 'http://gpu-box:11434/v1/systemone' })).toMatchObject({ url: 'http://gpu-box:11434/v1/systemone', model: 'clef' })
  })

  it('Cloudflare: {account_id} は設定、無ければ CLOUDFLARE_ACCOUNT_ID で置き換え、{model} はモデル名', () => {
    const cf = applyDecisionPreset({ enabled: true, preset: 'ollama' }, 'cloudflare')
    expect(resolveDecision({ ...cf, accountId: 'acc1' }).url).toBe('https://api.cloudflare.com/client/v4/accounts/acc1/ai/run/@cf/cloudflare/clef-flash')
    expect(resolveDecision({ ...cf, model: 'clef' }, (name) => (name === 'CLOUDFLARE_ACCOUNT_ID' ? 'fromenv' : undefined)).url).toBe('https://api.cloudflare.com/client/v4/accounts/fromenv/ai/run/@cf/cloudflare/clef')
    expect(resolveDecision(cf).missing).toEqual(['account_id'])
    expect(resolveDecision({ enabled: true, preset: 'custom' }).missing).toContain('endpoint')
  })

  it('追加のヘッダー（値そのまま / { env }）と認証の付け方。以前の headersEnv は { env } へ移る', () => {
    const headers = parseHeaderLines('X-Team: ade\ncf-aig-authorization: ${CF_AIG}\nbroken line')
    expect(headers).toEqual({ 'X-Team': 'ade', 'cf-aig-authorization': { env: 'CF_AIG' } })
    expect(formatHeaderLines(headers)).toBe('X-Team: ade\ncf-aig-authorization: ${CF_AIG}')
    const prefs = sanitizeDecisionPreferences({ enabled: true, preset: 'custom', endpoint: 'https://x.test/v1/systemone', model: 'm', headers, authScheme: 'header', authHeader: 'x-api-key' })
    expect(prefs.headers).toEqual(headers)
    expect(sanitizeDecisionPreferences({ headersEnv: { 'X-Token': 'MY_TOKEN' } }).headers).toEqual({ 'X-Token': { env: 'MY_TOKEN' } })
    const env = (name: string) => (name === 'CF_AIG' ? 'gw-token' : undefined)
    const resolved = resolveDecision(prefs, env)
    expect(resolved.headers).toEqual({ 'X-Team': 'ade', 'cf-aig-authorization': 'gw-token' })
    expect(decisionAuthHeader(resolved, 'k1')).toEqual({ 'x-api-key': 'k1' })
    expect(decisionAuthHeader({ authScheme: 'bearer', authHeader: 'Authorization' }, 'k1')).toEqual({ Authorization: 'Bearer k1' })
    expect(decisionAuthHeader({ authScheme: 'none', authHeader: 'Authorization' }, 'k1')).toEqual({})
    expect(decisionAuthHeader({ authScheme: 'bearer', authHeader: 'Authorization' }, undefined)).toEqual({})
    // 見つからない環境変数のヘッダーは付けない
    expect(resolveDecision(prefs).headers).toEqual({ 'X-Team': 'ade' })
  })
})

describe('Agent への指示文', () => {
  const target = { relativeDir: '.ade-movie/reviews/20261003-101500', feedbackMd: '/p/.ade-movie/reviews/20261003-101500/feedback.md' }

  it('無効なら今までと同じ。有効なときだけ受け入れ確認の1文としきい値が付く', () => {
    expect(renderAgentPrompt(target)).toBe(defaultAgentPrompt().replace('{{path}}', target.feedbackMd).replace('{{progress}}', target.feedbackMd.replace(/feedback\.md$/, 'progress.json')))
    expect(renderAgentPrompt(target, null, undefined, null)).toBe(renderAgentPrompt(target))
    const on = renderAgentPrompt(target, null, 'en', { threshold: 0.8 })
    expect(on.startsWith(renderAgentPrompt(target, null, 'en'))).toBe(true)
    expect(on).toContain('Acceptance check')
    expect(on).toContain('until every finding passes in the same round')
    expect(on).toContain('≥ 0.8')
    expect(on).not.toContain('{{')
    expect(renderAgentPrompt(target, null, 'ja', { threshold: 0.7 })).toContain('受け入れ確認')
  })

  it('利用者の文に {{decisionCheck}} があればそこへ入れ、無効なら空にする', () => {
    expect(renderAgentPrompt(target, 'Fix {{relpath}}. {{decisionCheck}}', 'en', { threshold: 0.7 })).toMatch(/^Fix \.ade-movie\/reviews\/20261003-101500\/feedback\.md\. The acceptance check/)
    expect(renderAgentPrompt(target, 'Fix {{relpath}}. {{decisionCheck}}', 'en', null)).toBe('Fix .ade-movie/reviews/20261003-101500/feedback.md.')
    expect(renderAgentPrompt(target, 'Pass at {{threshold}}', 'en', { threshold: 0.9 })).toContain('Pass at 0.9')
  })
})

const item = (n: number, extra: Partial<FeedbackItem> = {}): FeedbackItem => ({
  id: `i${n}`, index: n, t: n * 1000, title: `Finding ${n}`, request: `Make thing ${n} bigger`, status: 'decided', quotes: [],
  images: [`./0${n}.png`], frameTimes: [n * 1000], contextTime: n * 1000, context: { url: 'http://localhost:3000/pricing' }, draftIds: [], annotationIds: [], include: true, ...extra
})
const doc: FeedbackDocument = {
  meta: { id: '20261003-101500', startedAt: '2026-10-03T10:15:00+09:00', durationMs: 30_000, targetUrl: 'http://localhost:3000/pricing', twoSpeakers: false },
  items: [item(1), item(2)], dropped: [], organizedByLlm: true
}
const reviewDir = '/Users/me/app/.ade-movie/reviews/20261003-101500'

describe('feedback.md の受け入れ確認の節', () => {
  const md = renderFeedbackMarkdown(doc, { locale: 'en', decision: { threshold: 0.75, dir: reviewDir } })

  it('無効なら節も BEFORE の絶対パスも書かない', () => {
    const off = renderFeedbackMarkdown(doc, { locale: 'en' })
    expect(off).not.toContain('Acceptance check')
    expect(off).not.toContain('BEFORE image')
    expect(off).not.toContain('MOVIE_ADE_DECISION')
  })

  it('各指摘に BEFORE（注釈付きの静止画）の絶対パスと「完了の条件」を書く', () => {
    // 絶対パスは OS の区切りで組み立てる（Windows は \\）。期待値も join で作る
    expect(md).toContain(`- BEFORE image (for the acceptance check): ${join(reviewDir, '01.png')}`)
    expect(md).toContain(`- BEFORE image (for the acceptance check): ${join(reviewDir, '02.png')}`)
    expect(md.match(/^- Done when: /gm)).toHaveLength(2)
  })

  it('全件が同じ回で合格するまで、全件を判定し直すループと、止めてよい場合を書く', () => {
    expect(md).toContain('## Acceptance check (decision model)')
    expect(md).toContain('Re-judge ALL findings every round')
    expect(md).toContain('Stop only when every finding passes in the same round')
    expect(md).toContain('`answers.done.noul` ≥ 0.75')
    expect(md).toContain('(a) the decision API is unreachable')
    expect(md).toContain('(b) a finding is out of scope or impossible')
    expect(md).toContain('(c) the same finding has failed for 3 rounds')
    expect(md).toContain('Never edit the BEFORE images, the state text, the questions or the threshold')
    expect(md).toContain('.result.answers')
    expect(md).toContain('round n · passed x/y')
    // 古い Ollama（0.35.0）は本文が 64 KiB まで。画像を縮め、それでも 413 なら更新か Cloudflare を案内させる
    expect(md).toContain('at most 1024px wide')
    expect(md).toContain('0.35.1 or later')
    expect(md).toContain('Cloudflare Workers AI')
    expect(md).not.toContain('{{')
  })

  it('キー・認証のヘッダーは書かない（Agent は中継の URL だけを使う）', () => {
    for (const text of [md, renderAgentPrompt({ relativeDir: 'x' }, null, 'en', { threshold: 0.7 })]) {
      expect(text).not.toMatch(/Authorization|Bearer|API_KEY=|sk-/)
      expect(text).not.toContain(SECRET)
    }
  })

  it('問いの JSON テンプレートは JSON として読め、shell の単一引用符で囲める', () => {
    const q = /Q='([^']*)'/.exec(md)?.[1]
    expect(q).toBe(DECISION_QUESTIONS_JSON)
    const parsed = JSON.parse(q!) as Record<string, { type: string; criteria: Record<string, string> }>
    expect(parsed.done!.type).toBe('noul')
    expect(parsed.status!.type).toBe('choice')
    expect(Object.keys(parsed.status!.criteria)).toEqual(['done', 'partial', 'not_done', 'cannot_tell'])
  })

  it('依頼の本文を作る node の1行が動き、画像は FERRET_DECISION_IMAGES=1 のときだけ付く', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'before.png'), Buffer.from('BEFORE'))
    await writeFile(join(dir, 'after.png'), Buffer.from('AFTER'))
    const script = /^node -e '(.*)'$/.exec(DECISION_NODE_LINE)![1]!
    const run = (images: string, format = 'base64') => {
      execFileSync(process.execPath, ['-e', script], { cwd: dir, env: { ...process.env, FERRET_DECISION_MODEL: 'clef-flash', FERRET_DECISION_IMAGES: images, FERRET_DECISION_IMAGE_FORMAT: format,
        STATE: 'Finding "1" / Done when: it\'s bigger', BEFORE: join(dir, 'before.png'), AFTER: join(dir, 'after.png'), Q: DECISION_QUESTIONS_JSON } })
      return readFile(join(dir, 'req.json'), 'utf8').then((t) => JSON.parse(t) as Record<string, unknown>)
    }
    const withImages = await run('1')
    expect(withImages).toEqual({ model: 'clef-flash', state: 'Finding "1" / Done when: it\'s bigger', questions: JSON.parse(DECISION_QUESTIONS_JSON),
      images: [Buffer.from('BEFORE').toString('base64'), Buffer.from('AFTER').toString('base64')] })
    expect(await run('0')).not.toHaveProperty('images')
    // Cloudflare 向けは data URI（拡張子で png / jpeg）
    expect((await run('1', 'data-uri')).images).toEqual([`data:image/png;base64,${Buffer.from('BEFORE').toString('base64')}`, `data:image/png;base64,${Buffer.from('AFTER').toString('base64')}`])
  })

  it('GitHub へは受け入れ確認の節と BEFORE の絶対パスを出さない', () => {
    const { body } = issueFromFeedback(md)
    expect(body).not.toContain('Acceptance check')
    expect(body).not.toContain(reviewDir)
    expect(body).toContain('Finding 1')
  })
})

describe('Agent の環境変数', () => {
  it('親から受け継いだ変数の掃除で FERRET_DECISION_*（と旧名）を消さない', () => {
    for (const name of [...Object.values(DECISION_ENV), ...Object.values(LEGACY_DECISION_ENV)]) expect(isInheritedAgentSessionEnv(name, 'x')).toBe(false)
  })

  it('有効なときだけ中継の URL・モデル・画像の可否を渡し、キーは渡さない。キーは起動時に読まない', async () => {
    let prefs: DecisionPreferences = { enabled: false, preset: 'vercel', apiKey: SECRET }
    const readKey = vi.fn(async () => SECRET)
    const service = new DecisionService({ prefs: () => prefs, readKey, getEnv: () => undefined, onCall: () => {} })
    expect(await service.launchEnv()).toEqual({})
    prefs = { ...applyDecisionPreset(prefs, 'vercel'), enabled: true }
    const env = await service.launchEnv({ agent: 'Claude Code' })
    expect(Object.keys(env).sort()).toEqual([...Object.values(DECISION_ENV), ...Object.values(LEGACY_DECISION_ENV)].sort())
    // 改名前の MOVIE_ADE_DECISION_* にも同じ値（非推奨。1リリースだけ）
    for (const key of Object.keys(DECISION_ENV) as (keyof typeof DECISION_ENV)[]) expect(env[LEGACY_DECISION_ENV[key]]).toBe(env[DECISION_ENV[key]])
    expect(env[DECISION_ENV.imageFormat]).toBe('base64')
    expect(env[DECISION_ENV.url]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/systemone\?t=[\w-]{20,}$/)
    expect(env[DECISION_ENV.model]).toBe('typesafe-ai/jev')
    expect(env[DECISION_ENV.images]).toBe('0')
    expect(JSON.stringify(env)).not.toContain(SECRET)
    expect(readKey).not.toHaveBeenCalled()
    // 起動ごとに違う合言葉
    expect((await service.launchEnv())[DECISION_ENV.url]).not.toBe(env[DECISION_ENV.url])
    await service.stop()
  })

  it('無効 → 有効にしても中継のポートと出した合言葉は変わらない（開いたままのターミナルの URL が使える）', async () => {
    let prefs: DecisionPreferences = { enabled: true, preset: 'custom', endpoint: 'http://127.0.0.1:1/v1/systemone', model: 'clef-flash', authScheme: 'none' }
    const service = new DecisionService({ prefs: () => prefs, readKey: async () => undefined, getEnv: () => undefined, onCall: () => {} })
    const url = (await service.launchEnv())[DECISION_ENV.url]!
    const port = service.port
    prefs = { ...prefs, enabled: false }
    await service.sync()
    expect(service.port).toBe(port)
    expect(await service.launchEnv()).toEqual({})
    // 無効のあいだは理由付きで断る
    const off = await fetch(url, { method: 'POST', body: '{}' })
    expect(off.status).toBe(400)
    expect(((await off.json()) as { message: string }).message).toContain('turned off')
    prefs = { ...prefs, enabled: true }
    await service.sync()
    expect(service.port).toBe(port)
    // 前の合言葉のまま中継まで届く（接続先が無いので 502）
    expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(502)
    await service.stop()
  })

  it('ターミナルの開き直しを促すのは、有効・モデル・画像の可否が変わったときだけ', () => {
    const base: DecisionPreferences = { enabled: true, preset: 'ollama' }
    expect(decisionTerminalEnvChanged(base, { ...base, enabled: false })).toBe(true)
    expect(decisionTerminalEnvChanged(base, { ...base, model: 'clef' })).toBe(true)
    expect(decisionTerminalEnvChanged(base, { ...base, images: false })).toBe(true)
    expect(decisionTerminalEnvChanged(base, { ...base, imageFormat: 'data-uri' })).toBe(true)
    expect(decisionTerminalEnvChanged(base, { ...base, model: 'clef-flash', images: true })).toBe(false)
    expect(decisionTerminalEnvChanged(base, { ...base, endpoint: 'http://gpu:11434/v1/systemone', passThreshold: 0.9, apiKeyEnv: 'X' })).toBe(false)
  })
})

describe('ローカル中継', () => {
  let upstream: Server
  let upstreamUrl = ''
  const seen: Array<{ headers: IncomingMessage['headers']; body: string; url: string }> = []
  let reply: { status: number; body: string; type?: string } = { status: 200, body: '{}' }

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), url: req.url ?? '' })
        res.writeHead(reply.status, { 'content-type': reply.type ?? 'application/json' })
        res.end(reply.body)
      })
    })
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1/systemone`
  })
  afterAll(() => new Promise<void>((r) => upstream.close(() => r())))

  const makeRelay = (over: Partial<RelayUpstream> = {}, maxBodyBytes?: number) => {
    const calls: ApiCallRecord[] = []
    const relay = new DecisionRelay({
      upstream: async () => ({ url: upstreamUrl, headers: { Authorization: `Bearer ${SECRET}`, 'X-Extra': 'on' }, provider: 'vercel', model: 'typesafe-ai/jev', timeoutMs: 5000, ...over }),
      onCall: (r) => calls.push(r),
      ...(maxBodyBytes ? { maxBodyBytes } : {})
    })
    return { relay, calls }
  }
  const body = JSON.stringify({ model: 'typesafe-ai/jev', state: 'Finding 1 secret-state-text', images: ['QkVGT1JF', 'QUZURVI='], questions: JSON.parse(DECISION_QUESTIONS_JSON) })

  it('合言葉が合えば、キーと追加のヘッダーを付けて本文を変えずに送り、応答を変えずに返す', async () => {
    const { relay, calls } = makeRelay()
    await relay.start()
    const answer = '{"model":"typesafe-ai/jev","answers":{"done":{"type":"noul","noul":0.91}},"usage":{"input_tokens":1200,"output_tokens":8},"provider_metadata":{"gateway":{"cost":"0.00042"}}}'
    reply = { status: 200, body: answer }
    const res = await fetch(relay.urlFor(relay.issue({ projectId: 'p1', agent: 'Codex' })), { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(answer)
    const got = seen.at(-1)!
    expect(got.body).toBe(body)
    expect(got.headers.authorization).toBe(`Bearer ${SECRET}`)
    expect(got.headers['x-extra']).toBe('on')
    // 記録は数だけ。画像・state・問い・キーは残さない
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatchObject({ kind: 'decision', projectId: 'p1', agent: 'Codex', provider: 'vercel', model: 'typesafe-ai/jev', status: 200, images: 2,
      inputTokens: 1200, outputTokens: 8, costUsd: 0.00042, costSource: 'provider', requestBytes: Buffer.byteLength(body) })
    const recorded = JSON.stringify(calls[0])
    for (const leaked of [SECRET, 'QkVGT1JF', 'secret-state-text', 'Is the requested change']) expect(recorded).not.toContain(leaked)
    await relay.stop()
  })

  it('合言葉が無い・違う依頼は断り、接続先へ送らない', async () => {
    const { relay, calls } = makeRelay()
    await relay.start()
    const before = seen.length
    const base = relay.urlFor('x').replace(/\?t=.*$/, '')
    expect((await fetch(base, { method: 'POST', body })).status).toBe(401)
    expect((await fetch(`${base}?t=wrong`, { method: 'POST', body })).status).toBe(401)
    const token = relay.issue()
    expect((await fetch(base, { method: 'POST', body, headers: { [RELAY_TOKEN_HEADER]: token } })).status).toBe(200)
    // 改名前のヘッダー名も受け付ける
    expect((await fetch(base, { method: 'POST', body, headers: { [LEGACY_RELAY_TOKEN_HEADER]: token } })).status).toBe(200)
    relay.revoke(token)
    expect((await fetch(`${base}?t=${token}`, { method: 'POST', body })).status).toBe(401)
    expect(seen.length).toBe(before + 2)
    expect(calls).toHaveLength(2)
    await relay.stop()
  })

  it('4xx / 5xx と Cloudflare の { result, success } の包みはそのまま返す', async () => {
    const { relay } = makeRelay()
    await relay.start()
    const url = relay.urlFor(relay.issue())
    reply = { status: 429, body: '{"message":"slow down","error_type":"rate_limit"}' }
    let res = await fetch(url, { method: 'POST', body })
    expect([res.status, await res.text()]).toEqual([429, reply.body])
    const wrapped = '{"result":{"answers":{"done":{"type":"noul","noul":0.4}},"usage":{"input_tokens":10,"output_tokens":2}},"success":true,"errors":[],"messages":[]}'
    reply = { status: 200, body: wrapped }
    res = await fetch(url, { method: 'POST', body })
    expect(await res.text()).toBe(wrapped)
    await relay.stop()
  })

  it('大きすぎる本文は 413、接続先に届かなければ 502、設定が足りなければ 400（JSON の理由付き）', async () => {
    const small = makeRelay({}, 64)
    await small.relay.start()
    let res = await fetch(small.relay.urlFor(small.relay.issue()), { method: 'POST', body })
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error_type: string }).error_type).toBe('relay_too_large')
    await small.relay.stop()

    const down = makeRelay({ url: 'http://127.0.0.1:1/v1/systemone' })
    await down.relay.start()
    res = await fetch(down.relay.urlFor(down.relay.issue()), { method: 'POST', body })
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error_type: string }).error_type).toBe('relay_upstream_unreachable')
    await vi.waitFor(() => expect(down.calls[0]?.status).toBe(0))
    await down.relay.stop()

    const misconfigured = new DecisionRelay({ upstream: async () => { throw new RelayConfigError('Set the Cloudflare account ID') } })
    await misconfigured.start()
    res = await fetch(misconfigured.urlFor(misconfigured.issue()), { method: 'POST', body })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { message: string }).message).toContain('account ID')
    await misconfigured.stop()
  })

  it('費用が応答に無ければ、単価を設定したときだけ見積もる', async () => {
    const priced = makeRelay({ pricing: { inputPer1M: 1, outputPer1M: 4 } })
    await priced.relay.start()
    reply = { status: 200, body: '{"answers":{},"usage":{"input_tokens":1000000,"output_tokens":500000}}' }
    await fetch(priced.relay.urlFor(priced.relay.issue()), { method: 'POST', body })
    await vi.waitFor(() => expect(priced.calls[0]).toMatchObject({ costUsd: 3, costSource: 'estimate' }))
    await priced.relay.stop()
    const unpriced = makeRelay()
    await unpriced.relay.start()
    await fetch(unpriced.relay.urlFor(unpriced.relay.issue()), { method: 'POST', body })
    await vi.waitFor(() => expect(unpriced.calls).toHaveLength(1))
    expect(unpriced.calls[0]).not.toHaveProperty('costUsd')
    await unpriced.relay.stop()
  })

  it('中継のサービスは最初の依頼のときに初めてキーを読み、設定が変わるまで覚える', async () => {
    reply = { status: 200, body: '{}' }
    const readKey = vi.fn(async () => SECRET)
    const prefs: DecisionPreferences = { enabled: true, preset: 'custom', endpoint: upstreamUrl, model: 'clef-flash', authScheme: 'bearer' }
    const service = new DecisionService({ prefs: () => prefs, readKey, getEnv: () => undefined, onCall: () => {} })
    const url = (await service.launchEnv())[DECISION_ENV.url]!
    expect(readKey).not.toHaveBeenCalled()
    await fetch(url, { method: 'POST', body })
    await fetch(url, { method: 'POST', body })
    expect(readKey).toHaveBeenCalledTimes(1)
    expect(seen.at(-1)!.headers.authorization).toBe(`Bearer ${SECRET}`)
    await service.stop()
  })
})

describe('API 呼び出しの記録', () => {
  it('プロジェクトごとの見出しは名前、消したプロジェクトは ID、プロジェクトなしは専用の文', () => {
    const names = { p1: 'demo-site' }
    expect(projectLabel('p1', names, 'No project')).toBe('demo-site')
    expect(projectLabel('gone', names, 'No project')).toBe('gone')
    expect(projectLabel('', names, 'No project')).toBe('No project')
  })

  it('応答からトークン数と費用を取り出す（Cloudflare の包みも）。単価は設定したときだけ', () => {
    expect(extractUsage({ usage: { input_tokens: 5, output_tokens: 2 }, provider_metadata: { gateway: { cost: 0.001 } } })).toEqual({ inputTokens: 5, outputTokens: 2, costUsd: 0.001 })
    expect(extractUsage({ result: { usage: { input_tokens: 7, output_tokens: 1 } }, success: true })).toEqual({ inputTokens: 7, outputTokens: 1 })
    expect(extractUsage('nope')).toEqual({})
    expect(estimateCost({ inputTokens: 2_000_000 }, { inputPer1M: 0.5 })).toBe(1)
    expect(estimateCost({ inputTokens: 10, outputTokens: 10 }, { inputPer1M: 0.5 })).toBeUndefined()
    expect(estimateCost({ inputTokens: 10 }, undefined)).toBeUndefined()
  })

  it('知らない項目（本文・画像）は記録に持ち込まない', () => {
    const r = sanitizeCallRecord({ ts: '2026-10-03T01:00:00.000Z', kind: 'decision', model: 'm', status: 200, latencyMs: 5, images: ['AAAA'], state: 'text', apiKey: SECRET })
    expect(r).toEqual({ ts: '2026-10-03T01:00:00.000Z', kind: 'decision', model: 'm', status: 200, latencyMs: 5 })
    expect(sanitizeCallRecord({ ts: 'x', kind: 'decision', model: 'm' })).toBeNull()
  })

  it('月ごとのファイルに追記し（月が変われば別のファイル）、今日・今月・プロジェクト・モデル・種類ごとに集計する', async () => {
    const dir = await tempDir()
    const now = new Date(2026, 9, 3, 15, 0)
    const log = new CallLog(dir, () => now)
    const at = (d: Date) => d.toISOString()
    await log.append({ ts: at(new Date(2026, 8, 30, 12)), kind: 'decision', model: 'clef-flash', status: 200, latencyMs: 1, inputTokens: 999 })
    await log.append({ ts: at(new Date(2026, 9, 1, 9)), kind: 'decision', projectId: 'p1', model: 'clef-flash', status: 200, latencyMs: 10, inputTokens: 100, outputTokens: 5 })
    await log.append({ ts: at(new Date(2026, 9, 3, 10)), kind: 'decision', projectId: 'p1', model: 'clef-flash', status: 429, latencyMs: 10 })
    await log.append({ ts: at(new Date(2026, 9, 3, 11)), kind: 'transcription', projectId: 'p2', model: 'gpt-transcribe', status: 200, latencyMs: 10, costUsd: 0.02, costSource: 'estimate' })
    expect(callLogFile(dir, new Date(2026, 8, 30))).toMatch(/decision-2026-09\.jsonl$/)
    expect((await readFile(callLogFile(dir, new Date(2026, 8, 30)), 'utf8')).trim().split('\n')).toHaveLength(1)
    const records = await log.month(now)
    expect(records).toHaveLength(3)
    const s = aggregateCalls(records, now)
    expect(s.month).toEqual({ calls: 3, errors: 1, inputTokens: 100, outputTokens: 5, costUsd: 0.02, costKnown: 1 })
    expect(s.today).toMatchObject({ calls: 2, errors: 1, costKnown: 1 })
    expect(s.byProject.p1).toMatchObject({ calls: 2 })
    expect(s.byProject.p2).toMatchObject({ calls: 1, costUsd: 0.02 })
    expect(s.byModel['clef-flash']).toMatchObject({ calls: 2, inputTokens: 100 })
    expect(s.byKind.transcription).toMatchObject({ calls: 1 })
    expect(s.recent[0]!.kind).toBe('transcription')
    const summary = await log.summary({ enabled: true, model: 'clef-flash', provider: 'ollama' })
    expect(summary.logFile).toBe(callLogFile(dir, now))
  })
})
