import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setLocale } from '@shared/i18n'
import type { Env, LimiterStorage } from '../../workers/feedback-relay/src/env'
import { handle } from '../../workers/feedback-relay/src/index'
import { FeedbackLimiter, askLimiter, limiterKey } from '../../workers/feedback-relay/src/limiter'
import { PER_SENDER_LIMITS } from '../../workers/feedback-relay/src/limits'

/**
 * Codex のセキュリティスキャン7回目の [1]〜[15] を、同じ種類のコードが戻ったら落ちる形で止める。
 * 各節の見出しに番号を書く。
 */

const repo = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(join(repo, p), 'utf8')

beforeEach(() => setLocale('en'))

// ───────────────────────── [14] 本文を読んだあとの送り主の枠の断りも、全体の予約を戻す ─────────────────────────

class MemoryStorage implements LimiterStorage {
  data = new Map<string, unknown>()
  async get<T>(key: string) { return this.data.get(key) as T | undefined }
  async put<T>(key: string, value: T) { this.data.set(key, value) }
  async deleteAll() { this.data.clear() }
  async setAlarm() {}
}

function fakeEnv() {
  const limiters = new Map<string, { storage: MemoryStorage; obj: FeedbackLimiter }>()
  const env = {
    GITHUB_TOKEN: ['fake', 'token'].join('-'),
    RATE_LIMIT_SALT: 'test-salt',
    GITHUB_REPO: 'JapanMarketing-Dev/ferret',
    PUBLIC_BASE: 'https://feedback.example.test',
    MEDIA: { async put() {}, async get() { return null }, async delete() {} },
    LIMITER: {
      idFromName: (name: string) => name,
      get(id: unknown) {
        const name = id as string
        if (!limiters.has(name)) {
          const storage = new MemoryStorage()
          limiters.set(name, { storage, obj: new FeedbackLimiter({ storage } as never) })
        }
        return { fetch: (r: Request) => limiters.get(name)!.obj.fetch(r) }
      }
    }
  } as unknown as Env
  const times = (name: string) => ((limiters.get(name)?.storage.data.get('times') as number[] | undefined) ?? []).length
  return { env, times }
}

describe('security-7 [14] a refusal by the installation-ID quota gives back the shared pre-parse reservation', () => {
  const T0 = 1_800_000_000_000
  const INSTALL = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
  const noGithub = { fetch: vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch, now: () => T0 }

  it('an installation ID that used up its quota, sent from a fresh IP, does not consume the pre-parse budget', async () => {
    const { env, times } = fakeEnv()
    const installKey = await limiterKey(env.RATE_LIMIT_SALT, 'install', INSTALL)
    const perSenderMax = Math.min(...PER_SENDER_LIMITS.map((w) => w.max))
    for (let i = 0; i < perSenderMax; i++) await askLimiter(env, installKey, 'hit', PER_SENDER_LIMITS, T0)
    for (let i = 0; i < 5; i++) {
      const f = new FormData()
      for (const [k, v] of Object.entries({ kind: 'bug', title: `t${i}`, body: 'It stops.', appVersion: '0.2.0', platform: 'darwin', arch: 'arm64', osRelease: '25.6.0', installId: INSTALL })) f.append(k, v)
      const res = await handle(new Request('https://feedback.example.test/v1/issues', { method: 'POST', body: f, headers: { 'cf-connecting-ip': `198.51.100.${i + 1}` } }), env, noGithub)
      expect(res.status).toBe(429)
    }
    expect(times('preparse')).toBe(0)
  })

  it('every sender limiter refusal in submit, before or after the body, goes through refuseBySender (shape check)', () => {
    const relay = read('workers/feedback-relay/src/index.ts')
    const submit = relay.slice(relay.indexOf('async function submit('), relay.indexOf('\nasync function admit('))
    expect(submit.length).toBeGreaterThan(100)
    const singleLine = [...submit.matchAll(/if \(!(\w+)\.allowed\) (.*)/g)]
    expect(singleLine.map((m) => m[1])).toEqual(expect.arrayContaining(['attempt', 'ipPeek', 'admission']))
    for (const m of singleLine) {
      // 全体の枠そのもの（preparse・global）は送り主の枠ではない
      if (m[1] === 'preparse' || m[1] === 'globalHit') continue
      expect(m[2]).toMatch(/^return refuseBySender\(/)
    }
    // 送り主の枠の断りで、fail('rate_limited' を直に返す所は無い（全体の枠と refuseBySender の中だけ）
    expect(submit.match(/fail\('rate_limited'/g)).toHaveLength(3)
  })
})

// ───────────────────────── 共通 ─────────────────────────

async function tempDir(prefix: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { realpathSync } = await import('node:fs')
  return realpathSync(await mkdtemp(join(tmpdir(), prefix)))
}

/** System One の最小の依頼 */
const SYSTEM_ONE = (extra: Record<string, unknown> = {}) => JSON.stringify({ model: 'cheap-model', state: 's', questions: { ok: { type: 'noul' } }, ...extra })

// ───────────────────────── [1] クリップボードの中身を renderer へ返さない ─────────────────────────

describe('security-7 [1] the app screen cannot read the clipboard', () => {
  it('no IPC channel returns clipboard text, and terminal paste is a one-use grant after a key press', async () => {
    const ipc = read('src/shared/ipc.ts')
    expect(ipc).not.toMatch(/'terminal:clipboardText'/)
    expect(ipc).toMatch(/'terminal:paste': \(\) => boolean/)
    const main = read('src/main/index.ts')
    expect(main).not.toMatch(/clipboard\.readText\(\)/)
    // 貼り付けは、押した直後・窓と端末にフォーカスがあるときに、OS の貼り付けをその窓に行わせるだけ
    expect(main).toMatch(/'terminal:paste': \(\) => \{[\s\S]{0,300}gestures\.consume\('paste'\)[\s\S]{0,120}win\.webContents\.paste\(\)/)
    const { UserGestures } = await import('../../src/main/captureConsent')
    let now = 1000
    const gestures = new UserGestures(() => now)
    expect(gestures.consume('paste')).toBe(false)
    gestures.noteGesture()
    expect(gestures.consume('paste')).toBe(true)
    expect(gestures.consume('paste')).toBe(false)
    gestures.noteGesture()
    now += 6000
    expect(gestures.consume('paste')).toBe(false)
  })

  it('the file tree paste returns only the names it created, never clipboard contents or source paths', async () => {
    const ipc = read('src/shared/ipc.ts')
    expect(ipc).toMatch(/'fs:pasteClipboard': \(destRel: string\) => \{ kind: 'files' \| 'image' \| 'none'; created: string\[\] \}/)
    expect(read('src/main/index.ts')).toMatch(/'fs:pasteClipboard': async \(destRel\) => \{\n\s+if \(typeof destRel !== 'string' \|\| !gestures\.consume\('paste'\)\)/)
  })
})

describe('file tree paste from the OS clipboard (clipboardFiles.ts)', () => {
  it('reads files from text/uri-list, macOS NSFilenamesPboardType, Windows FileNameW and GNOME', async () => {
    const { pathFromFileNameW, pathsFromFilenamesPlist, pathsFromUriList, readClipboardPaste } = await import('../../src/main/clipboardFiles')
    const { pathToFileURL } = await import('node:url')
    const { resolve: abs } = await import('node:path')
    // この OS の絶対パスで確かめる（Windows では file:///C:/… になる）
    const a = abs('/work/taro/a b.png')
    const c = abs('/work/taro/c.mp4')
    expect(pathsFromUriList(`${pathToFileURL(a).href}\r\n${pathToFileURL(c).href}\n# comment`)).toEqual([a, c])
    expect(pathsFromUriList(`copy\n${pathToFileURL(c).href}`)).toEqual([c])
    expect(pathsFromFilenamesPlist('<plist><array><string>/Users/taro/a&amp;b.png</string><string>relative</string></array></plist>')).toEqual(['/Users/taro/a&b.png'])
    expect(pathFromFileNameW(Buffer.from('C:\\Users\\taro\\v.mp4\0', 'utf16le'))).toEqual(['C:\\Users\\taro\\v.mp4'])
    const blob = (text: string) => new Blob([text])
    const files = await readClipboardPaste({ read: async () => [{ types: ['text/uri-list'], getType: async () => blob(`${pathToFileURL(a).href}\r\n${pathToFileURL(a).href}`) }] })
    expect(files).toEqual({ kind: 'files', paths: [a] })
    const plist = await readClipboardPaste({ read: async () => [{ types: ['electron application/osclipboard;format="NSFilenamesPboardType"'], getType: async () => blob('<string>/Users/taro/b.mov</string>') }] })
    expect(plist).toEqual({ kind: 'files', paths: ['/Users/taro/b.mov'] })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const image = await readClipboardPaste({ read: async () => [{ types: ['image/png'], getType: async () => new Blob([png]) }] })
    expect(image.kind).toBe('image')
    expect(await readClipboardPaste({ read: async () => [{ types: ['text/plain'], getType: async () => blob('secret') }] })).toEqual({ kind: 'none' })
  })

  it('writes a pasted image inside the project with a unique name and refuses folders outside', async () => {
    const { writePastedImage } = await import('../../src/main/clipboardFiles')
    const { mkdir, readFile, symlink } = await import('node:fs/promises')
    const root = await tempDir('ferret-paste-')
    const outside = await tempDir('ferret-paste-out-')
    await mkdir(join(root, 'assets'))
    await symlink(outside, join(root, 'link'))
    const at = new Date(2026, 9, 6, 13, 5, 9)
    const first = await writePastedImage(root, 'assets', Buffer.from('png'), 'png', at)
    const second = await writePastedImage(root, 'assets', Buffer.from('png2'), 'png', at)
    expect(first).toBe('assets/pasted-20261006-130509.png')
    expect(second).toBe('assets/pasted-20261006-130509-2.png')
    expect(await readFile(join(root, second), 'utf8')).toBe('png2')
    await expect(writePastedImage(root, 'link', Buffer.from('x'), 'png', at)).rejects.toThrow()
    await expect(writePastedImage(root, '../', Buffer.from('x'), 'png', at)).rejects.toThrow()
  })
})

// ───────────────────────── [2][6] プロジェクトの HTML は ade-page で、外へ通信させない ─────────────────────────

describe('security-7 [2][6] project HTML is served only from the project, with no network', () => {
  it('the address bar never opens file: URLs, and screenshots skip a view that shows one', async () => {
    const { isTypedNavigationAllowed, isPageNavigationAllowed, isSnapshotableBrowserUrl } = await import('../../src/main/webPolicy')
    for (const url of ['file:///etc/passwd', 'file:///Users/taro/.ssh/id_ed25519', 'FILE:///etc/hosts']) {
      expect(isTypedNavigationAllowed(url), url).toBe(false)
      expect(isSnapshotableBrowserUrl(url), url).toBe(false)
    }
    expect(isTypedNavigationAllowed('ade-page://project/index.html')).toBe(true)
    expect(isSnapshotableBrowserUrl('https://example.com')).toBe(true)
    // プロジェクトのページから外へは、リンク・スクリプトで移れない
    expect(isPageNavigationAllowed('https://tracker.example/p?x=1', 'ade-page://project/a.html')).toBe(false)
    expect(isPageNavigationAllowed('http://127.0.0.1:9999/', 'ade-page://project/a.html')).toBe(false)
    const browser = read('src/main/browser.ts')
    expect(browser).toMatch(/if \(isProjectPageUrl\(wc\.getURL\(\)\) && !isProjectPageUrl\(details\.url\)\) \{/)
    // renderer は絶対パスの file:// を作らない
    expect(read('src/renderer/editor/useOpenFiles.ts')).not.toMatch(/projectFileUrl|file:\/\//)
  })

  it('serves files inside the project with a no-network CSP, and refuses outside files, links and folders', async () => {
    const { projectPageResponse, PROJECT_PAGE_CSP } = await import('../../src/main/projectPage')
    const { mkdir, symlink, writeFile } = await import('node:fs/promises')
    const root = await tempDir('ferret-page-')
    const outside = await tempDir('ferret-page-out-')
    await mkdir(join(root, 'site'))
    await writeFile(join(root, 'site', 'index.html'), '<img src="https://tracker.example/p.png"><script src="app.js"></script>')
    await writeFile(join(root, 'site', 'app.js'), 'fetch("https://evil.example")')
    await writeFile(join(outside, 'secret.html'), 'secret')
    await symlink(join(outside, 'secret.html'), join(root, 'site', 'leak.html'))
    const ok = await projectPageResponse(root, 'ade-page://project/site/index.html')
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toMatch(/^text\/html/)
    expect(ok.headers.get('content-security-policy')).toBe(PROJECT_PAGE_CSP)
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await ok.text()).toContain('tracker.example')
    expect((await projectPageResponse(root, 'ade-page://project/site/app.js')).headers.get('content-type')).toMatch(/^text\/javascript/)
    for (const url of ['ade-page://project/site/leak.html', 'ade-page://project/site', 'ade-page://project/%2E%2E/x', 'ade-page://project/missing.html', 'ade-page://other/site/index.html']) {
      expect((await projectPageResponse(root, url)).status, url).toBe(404)
    }
    expect((await projectPageResponse(null, 'ade-page://project/site/index.html')).status).toBe(404)
    // 外への通信を止める CSP（同じオリジンと data: / blob: だけ。フォームの送信も無し）
    for (const directive of ["default-src 'self' data: blob:", "connect-src 'self'", "img-src 'self' data: blob:", "form-action 'none'", "frame-src 'self'"]) {
      expect(PROJECT_PAGE_CSP).toContain(directive)
    }
    expect(PROJECT_PAGE_CSP).not.toMatch(/https?:|\*/)
  })
})

// ───────────────────────── [3][8] 署名の鍵は CI に置かない ─────────────────────────

describe('security-7 [3][8] no workflow holds the release signing key or signs artifact-store bytes', () => {
  it('release.yml has no secrets, no signing and no R2 steps', () => {
    const wf = read('.github/workflows/release.yml')
    const code = wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    expect(code).not.toMatch(/secrets\.|release-signing\.mjs|release-r2\.mjs|download-artifact|gh release/)
  })
})

// ───────────────────────── [4] キーを変えたら古いキーの合言葉を止める ─────────────────────────

describe('security-7 [4] changing a saved key ends relay tokens that could use the old key', () => {
  it('the key store tells listeners synchronously when a key changes or is removed', async () => {
    const { SttKeyStore, NO_CIPHER } = await import('../../src/main/pipeline/stt/keys')
    const store = new SttKeyStore(join(await tempDir('ferret-keys-'), 'k.bin'), NO_CIPHER)
    const seen: string[] = []
    store.onChange((p) => seen.push(p))
    const pending = store.set('openai', ['sk', 'a'.repeat(30)].join('-'))
    await pending
    await store.set('openai', '')
    expect(seen).toEqual(['openai', 'openai'])
  })

  it('credentialsChanged revokes issued tokens, and a key read that finishes after the change is not cached', async () => {
    const { DecisionService } = await import('../../src/main/decision/service')
    const { DECISION_ENV } = await import('@shared/decision')
    const { createServer } = await import('node:http')
    const auth: string[] = []
    const upstream = createServer((req, res) => {
      auth.push(String(req.headers.authorization))
      req.resume()
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"answers":{}}') })
    })
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
    const endpoint = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1/systemone`
    let key = 'old-key'
    let release: (() => void) | null = null
    const readKey = vi.fn(async () => {
      const value = key
      if (value === 'slow') await new Promise<void>((r) => { release = r })
      return value
    })
    const service = new DecisionService({ prefs: () => ({ enabled: true, preset: 'custom', endpoint, model: 'm', authScheme: 'bearer' }), readKey, getEnv: () => undefined, onCall: () => {} })
    try {
      const url = (await service.launchEnv())[DECISION_ENV.url]!
      expect((await fetch(url, { method: 'POST', body: SYSTEM_ONE() })).status).toBe(200)
      expect(auth.at(-1)).toBe('Bearer old-key')
      // キーを変えた：出した合言葉はもう使えない
      key = 'new-key'
      service.credentialsChanged()
      expect((await fetch(url, { method: 'POST', body: SYSTEM_ONE() })).status).toBe(401)
      // 読んでいる途中でキーが変わったら、その読んだキーは使わず、覚えない
      key = 'slow'
      const url2 = (await service.launchEnv())[DECISION_ENV.url]!
      const inflight = fetch(url2, { method: 'POST', body: SYSTEM_ONE() })
      await vi.waitFor(() => expect(release).not.toBeNull())
      key = 'newest-key'
      service.credentialsChanged()
      release!()
      expect((await inflight.catch(() => null))?.status ?? 0).not.toBe(200)
      const url3 = (await service.launchEnv())[DECISION_ENV.url]!
      expect((await fetch(url3, { method: 'POST', body: SYSTEM_ONE() })).status).toBe(200)
      expect(auth.at(-1)).toBe('Bearer newest-key')
      expect(auth).not.toContain('Bearer slow')
    } finally {
      await service.stop()
      await new Promise<void>((r) => upstream.close(() => r()))
    }
  })
})

// ───────────────────────── [5] 自動の git はリポジトリの設定のコマンドを動かさない ─────────────────────────

describe('security-7 [5] automatic Git commands never run repository-configured commands', () => {
  it('status, the remote lookup and the file-tree colors do not run a core.fsmonitor or hook command', async () => {
    const { execFileSync } = await import('node:child_process')
    const { existsSync } = await import('node:fs')
    const { writeFile, chmod } = await import('node:fs/promises')
    const dir = await tempDir('ferret-fsmonitor-')
    const sentinel = join(dir, 'ran')
    const hook = join(dir, 'monitor.sh')
    await writeFile(hook, `#!/bin/sh\ntouch '${sentinel}'\n`)
    await chmod(hook, 0o755)
    const project = join(dir, 'project')
    execFileSync('git', ['init', '--quiet', project])
    execFileSync('git', ['-C', project, 'config', 'core.fsmonitor', hook])
    await writeFile(join(project, 'a.txt'), 'x')
    const { readGitStatus } = await import('../../src/main/github/gitSync')
    const { readGitDecorations } = await import('../../src/main/gitDecorations')
    expect((await readGitStatus(project)).isGit).toBe(true)
    await readGitDecorations(project)
    expect(existsSync(sentinel)).toBe(false)
  })

  it('every automatic git call site passes AUTOMATIC_GIT_CONFIG and resolves git to a trusted absolute path (shape check)', () => {
    for (const file of ['src/main/github/gitSync.ts', 'src/main/gitDecorations.ts', 'src/main/github/index.ts', 'src/main/github/repoStatus.ts', 'src/main/sessions/gitexclude.ts', 'src/main/failover/service.ts']) {
      const text = read(file)
      expect(text, file).toMatch(/AUTOMATIC_GIT_CONFIG/)
      expect(text, file).not.toMatch(/(?:execFile|execFileAsync|spawn|run)\('git',/)
    }
    expect(read('src/main/github/gitSync.ts')).toMatch(/'-c', 'core\.fsmonitor=false', '-c', 'protocol\.ext\.allow=never', '-c', 'protocol\.file\.allow=never'/)
  })
})

// ───────────────────────── [7] 中継は1回の上限をまるごと先に予約する ─────────────────────────

describe('security-7 [7] the decision relay reserves the worst case of each request before sending', () => {
  const upstreamFetch = () => vi.fn(async () => new Response('{"answers":{},"usage":{"input_tokens":10,"output_tokens":2}}', { status: 200 })) as unknown as typeof fetch

  it('refuses a request whose worst case exceeds the remaining budget before fetch, and rewrites the model', async () => {
    const { DecisionRelay } = await import('../../src/main/decision/relay')
    const doFetch = upstreamFetch()
    const relay = new DecisionRelay({ upstream: async () => ({ url: 'https://api.example.test/v1/systemone', headers: {}, provider: 'custom', model: 'cheap-model', timeoutMs: 5000 }), fetch: doFetch, budget: { tokensPerToken: 100_000 } })
    await relay.start()
    try {
      const url = relay.urlFor(relay.issue())
      // 大きな state（200KB）で 1回の上限が残りを超える。送らずに断る
      const big = await fetch(url, { method: 'POST', body: SYSTEM_ONE({ state: 'x'.repeat(200 * 1024) }) })
      expect(big.status).toBe(429)
      expect(((await big.json()) as { error_type: string }).error_type).toBe('relay_request_too_large')
      expect(doFetch).not.toHaveBeenCalled()
      // 形の違う本文・知らない項目も送らない
      for (const body of ['{}', '{"model":"m","state":"s","questions":{"q":{"type":"noul"}},"max_tokens":999999}', 'not json']) {
        const res = await fetch(url, { method: 'POST', body })
        expect(res.status, body).toBe(400)
      }
      expect(doFetch).not.toHaveBeenCalled()
      // 収まる依頼は、model を設定のものにして送る（Agent が高いモデルを選べない）
      expect((await fetch(url, { method: 'POST', body: SYSTEM_ONE({ model: 'expensive-model' }) })).status).toBe(200)
      const sent = JSON.parse(String((doFetch as unknown as { mock: { calls: Array<[string, { body: Uint8Array }]> } }).mock.calls[0]![1].body.constructor === Uint8Array
        ? Buffer.from((doFetch as unknown as { mock: { calls: Array<[string, { body: Uint8Array }]> } }).mock.calls[0]![1].body).toString('utf8') : ''))
      expect(sent.model).toBe('cheap-model')
    } finally {
      await relay.stop()
    }
  })

  it('an endpoint with no price still counts against the dollar budget, unless it runs on this computer', async () => {
    const { budgetPricing, FALLBACK_PRICING, checkDecisionRequest, costOf } = await import('../../src/main/decision/requestBound')
    expect(budgetPricing('https://api.example.test/x', undefined)).toEqual(FALLBACK_PRICING)
    expect(budgetPricing('http://localhost:11434/v1/systemone', undefined)).toEqual({ inputPer1M: 0, outputPer1M: 0 })
    expect(budgetPricing('https://api.example.test/x', { inputPer1M: 1 })).toEqual({ inputPer1M: 1, outputPer1M: FALLBACK_PRICING.outputPer1M })
    const checked = checkDecisionRequest(Buffer.from(SYSTEM_ONE({ images: ['AAAA', 'BBBB'] })), 'm')
    if (!checked.ok) throw new Error('should accept')
    expect(checked.images).toBe(2)
    expect(costOf({ input: checked.inputTokens, output: checked.outputTokens }, FALLBACK_PRICING)).toBeGreaterThan(0)
    // 画像の数・state の大きさの上限
    expect(checkDecisionRequest(Buffer.from(SYSTEM_ONE({ images: ['a', 'b', 'c', 'd', 'e'] })), 'm').ok).toBe(false)
  })
})

// ───────────────────────── [9] 裏の fetch は認めたリモートだけ ─────────────────────────

describe('security-7 [9] the background fetch runs only for a remote the user approved, stored outside the project', () => {
  it('canonicalizes remotes, keeps approvals per folder and remote, and forgets them when the remote changes', async () => {
    const { FetchConsentStore, canonicalRemote, remoteLabel } = await import('../../src/main/github/fetchConsent')
    expect(canonicalRemote('git@github.com:Acme/Shop.git')).toBe('ssh://github.com/Acme/Shop')
    expect(canonicalRemote('https://user:token@GitHub.com/acme/shop.git/')).toBe('https://github.com/acme/shop')
    expect(canonicalRemote('ssh://git@gitlab.example:2222/a/b.git')).toBe('ssh://gitlab.example:2222/a/b')
    expect(canonicalRemote('/tmp/remote.git')).toBeNull()
    expect(canonicalRemote('C:\\Users\\taro\\remote.git')).toBeNull()
    expect(canonicalRemote('C:/Users/taro/remote.git')).toBeNull()
    expect(canonicalRemote('\\\\server\\share\\repo.git')).toBeNull()
    expect(canonicalRemote('ext::sh -c touch% /tmp/x')).toBeNull()
    expect(canonicalRemote('origin')).toBeNull()
    expect(remoteLabel('https://github.com/acme/shop')).toBe('github.com/acme/shop')
    const file = join(await tempDir('ferret-consent-'), 'git-auto-fetch.json')
    const store = new FetchConsentStore(file)
    expect(store.consent('/p', 'https://github.com/acme/shop')).toBe('unknown')
    store.decide('/p', 'https://github.com/acme/shop', true)
    expect(new FetchConsentStore(file).consent('/p', 'https://github.com/acme/shop')).toBe('approved')
    expect(new FetchConsentStore(file).consent('/p', 'https://github.com/evil/shop')).toBe('unknown')
    store.decide('/p', 'https://github.com/acme/shop', false)
    expect(new FetchConsentStore(file).consent('/p', 'https://github.com/acme/shop')).toBe('declined')
  })
})

// ───────────────────────── [10][12] キー付きの依頼・更新の取得はリダイレクトを追わない ─────────────────────────

describe('security-7 [10][12] credential-bearing and update requests do not follow redirects', () => {
  it('mainFetch refuses a redirect to another origin before sending the body or headers again', async () => {
    const { createServer } = await import('node:http')
    const { mainFetch } = await import('../../src/main/netFetch')
    const hits: string[] = []
    const target = createServer((req, res) => { hits.push(String(req.headers['x-api-key'])); res.end('stolen') })
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()))
    const targetPort = (target.address() as { port: number }).port
    const origin = createServer((_req, res) => { res.writeHead(307, { location: `http://localhost:${targetPort}/` }); res.end() })
    await new Promise<void>((r) => origin.listen(0, '127.0.0.1', () => r()))
    try {
      await expect(mainFetch(`http://127.0.0.1:${(origin.address() as { port: number }).port}/v1/audio`, { method: 'POST', headers: { 'x-api-key': 'k' }, body: 'audio' })).rejects.toThrow()
      expect(hits).toHaveLength(0)
    } finally {
      await new Promise<void>((r) => origin.close(() => r()))
      await new Promise<void>((r) => target.close(() => r()))
    }
  })

  it('update metadata, signatures, installers and usage requests pass redirect: error (shape check)', () => {
    const check = read('src/main/updateCheck.ts')
    expect(check.match(/fetcher\([^\n]*redirect: 'error'/g)).toHaveLength(3)
    expect(check).not.toMatch(/fetcher\((?![^\n]*redirect: 'error')[^\n]*\{ signal/)
    expect(read('src/main/updateDownload.ts')).toMatch(/fetcher\(file\.url, \{ signal, redirect: 'error' \}\)/)
    expect(read('src/main/usage/service.ts')).toMatch(/net\.fetch\(url, \{ \.\.\.init, redirect: 'error' \}\)/)
    expect(read('src/main/decision/relay.ts')).toMatch(/redirect: 'error'/)
    expect(read('src/main/netFetch.ts')).toMatch(/redirect: init\?\.redirect \?\? 'error'/)
  })
})

// ───────────────────────── [11] Linux の見張りは読む項目の数と時間で止まる ─────────────────────────

describe('security-7 [11] the Linux folder watcher stops discovery at an entry and time budget', () => {
  it('streams directory entries with opendir and charges each one against the budget (shape check)', async () => {
    const text = read('src/main/linuxTreeWatch.ts')
    expect(text).not.toMatch(/readdir\(/)
    expect(text).toMatch(/for await \(const entry of dir\) \{\n\s+if \(this\.closed\) return\n\s+this\.scanned \+= 1\n\s+if \(!this\.budgetLeft\(\)\) return/)
    const { MAX_SCANNED_ENTRIES, MAX_DISCOVERY_MS } = await import('../../src/main/linuxTreeWatch')
    expect(MAX_SCANNED_ENTRIES).toBeLessThanOrEqual(200_000)
    expect(MAX_DISCOVERY_MS).toBeLessThanOrEqual(30_000)
  })
})

// ───────────────────────── [13] 確かめたものを開き直さない ─────────────────────────

describe('security-7 [13] review media and listings use what was checked, not a reopened path', () => {
  it('there is no path-based media helper, and the review routes stream from a checked handle', () => {
    const range = read('src/main/mediaRange.ts')
    expect(range).not.toMatch(/export async function mediaResponse\(/)
    expect(range).not.toMatch(/createReadStream\(file/)
    const main = read('src/main/index.ts')
    expect(main).toMatch(/openContained\(review\.dir, file, 'read'\)[\s\S]{0,400}mediaResponseFromHandle\(handle/)
    expect(main).toMatch(/readAfterFile\(reviewDir, file\)/)
    expect(main).not.toMatch(/readFileNoFollow\(file, null\)/)
    expect(read('src/main/files.ts')).toMatch(/const listed = await openListedDir\(root, dir\)/)
  })

  it('readAfterFile refuses a file reached through a folder swapped for a link to the outside', async () => {
    const { readAfterFile } = await import('../../src/main/afterShots')
    const { mkdir, rename, symlink, writeFile } = await import('node:fs/promises')
    const review = await tempDir('ferret-after-')
    const outside = await tempDir('ferret-after-out-')
    await mkdir(join(review, 'after'))
    await writeFile(join(review, 'after', 'i1.png'), 'inside')
    await writeFile(join(outside, 'i1.png'), 'outside-secret')
    expect((await readAfterFile(review, join(review, 'after', 'i1.png')))?.toString()).toBe('inside')
    // 確かめたあとで after/ を外へのリンクに差し替えた
    await rename(join(review, 'after'), join(review, 'after-old'))
    await symlink(outside, join(review, 'after'))
    expect(await readAfterFile(review, join(review, 'after', 'i1.png'))).toBeNull()
  })

  it('a listing of a folder swapped for a link to the outside is refused', async () => {
    const { listDirectory } = await import('../../src/main/files')
    const { mkdir, symlink, writeFile } = await import('node:fs/promises')
    const root = await tempDir('ferret-list-')
    const outside = await tempDir('ferret-list-out-')
    await writeFile(join(outside, 'secret.txt'), 'x')
    await mkdir(join(root, 'docs'))
    await symlink(outside, join(root, 'linked'))
    expect((await listDirectory(root, 'docs')).map((e) => e.name)).toEqual([])
    await expect(listDirectory(root, 'linked')).rejects.toThrow()
  })
})

// ───────────────────────── [15] rg・Whisper はプロジェクトの外の絶対パスから ─────────────────────────

describe('security-7 [15] helper discovery never picks a binary from a relative or project PATH entry', () => {
  it('findOnPath skips empty, relative and project entries', async () => {
    const { findOnPath } = await import('../../src/main/pipeline/environment')
    const exe = new Set(['./whisper-cli', 'bin/whisper-cli', '/work/acme/bin/whisper-cli', '/opt/homebrew/bin/whisper-cli'])
    const real = (p: string) => p
    expect(findOnPath('whisper-cli', '.:bin::/work/acme/bin:/opt/homebrew/bin', (p) => exe.has(p), { exclude: '/work/acme', realpath: real })).toBe('/opt/homebrew/bin/whisper-cli')
    expect(findOnPath('whisper-cli', '.:bin', (p) => exe.has(p), { exclude: '/work/acme', realpath: real })).toBeNull()
    // リンクの実体がプロジェクトの中でも使わない
    expect(findOnPath('whisper-cli', '/usr/local/bin', () => true, { exclude: '/work/acme', realpath: () => '/work/acme/evil' })).toBeNull()
  })

  it('rg is found with the trusted resolver, not by joining raw PATH entries', async () => {
    const files = read('src/main/files.ts')
    expect(files).toMatch(/resolveTrustedExecutable\('rg', \{ env: process\.env, cwd: root/)
    expect(files).not.toMatch(/existsSync\(candidate\)/)
    const { findRg } = await import('../../src/main/files')
    const { mkdir, writeFile, chmod } = await import('node:fs/promises')
    const root = await tempDir('ferret-rg-')
    await mkdir(join(root, 'bin'))
    await writeFile(join(root, 'bin', 'rg'), '#!/bin/sh\necho evil\n')
    await chmod(join(root, 'bin', 'rg'), 0o755)
    const saved = process.env.PATH
    process.env.PATH = `.:bin:${join(root, 'bin')}`
    try {
      const found = await findRg(root)
      expect(found === null || !found.startsWith(root)).toBe(true)
    } finally {
      process.env.PATH = saved
    }
  })
})
