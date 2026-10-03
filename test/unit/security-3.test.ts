import { generateKeyPairSync, createPublicKey } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_CATALOG,
  BUILTIN_AGENTS,
  DEFAULT_AGENT_PREFERENCES,
  bypassArgUnits,
  resolveAgentLaunchPolicy,
  sanitizeAgentPreferences,
  stripBypassArgs
} from '../../src/shared/agentCatalog'
import { setProjectBypass } from '../../src/renderer/lib/agentPrefs'
import { applyAgentWorkspaceTrust, registeredProjectIdFor } from '../../src/main/agentWorkspaceTrust'
import { isRemoteImageSource, previewCsp, renderPreviewBody, renderPreviewPage } from '../../src/main/preview/render'
import { scrubBreadcrumb, scrubEvent, scrubString } from '../../src/shared/telemetry'
import {
  RELEASE_PUBLIC_KEY,
  RELEASE_SIGNER_IDENTITY,
  RELEASE_SIGNING_NAMESPACE,
  releaseFilesAreSigned,
  verifySshSignature
} from '../../src/main/releaseSignature'
import {
  SIGNER_IDENTITY,
  SIGNING_NAMESPACE,
  signSshsig,
  sshPublicKeyLine,
  trustedPublicKey,
  verifySshsig
} from '../../scripts/release-signing.mjs'
import { setReporter } from '../../src/shared/report'

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.1' }, net: { fetch: vi.fn() } }))

/**
 * Codex のセキュリティスキャン3回目（security-3 [1]〜[7]）の回帰テストと、同じ種類の問題を機械的に止める不変条件。
 * [3][4][7]（feedback-relay）は test/unit/feedback-relay.test.ts の「security-3」の describe にある（偽の env を共有するため）。
 */

const root = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

function walk(dir: string, exts: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    if (name === 'node_modules') continue
    const p = `${dir}/${name}`
    if (statSync(join(root, p)).isDirectory()) walk(p, exts, out)
    else if (exts.test(name)) out.push(p)
  }
  return out
}

// ───────────────────────── [1] ─────────────────────────

describe('security-3 [1] 登録しただけのプロジェクトで、Agent を権限確認なしに動かさない', () => {
  it('security-3 [1] 既定の起動引数に、どの組み込みの Agent の権限確認を省く引数も入らない', () => {
    for (const agent of BUILTIN_AGENTS) {
      const args = DEFAULT_AGENT_PREFERENCES.launch[agent].args
      expect(stripBypassArgs(agent, args), agent).toBe(args)
      if (AGENT_CATALOG[agent].yoloArgs) expect(args, agent).not.toContain(AGENT_CATALOG[agent].yoloArgs)
    }
    expect(DEFAULT_AGENT_PREFERENCES.bypassProjects).toEqual([])
  })

  it('security-3 [1] 以前の既定（Orca の YOLO 引数）で保存された設定も、読み込むと権限確認を省く引数を外す', () => {
    const prefs = sanitizeAgentPreferences({
      launch: {
        claude: { command: 'claude', args: '--dangerously-skip-permissions --model opus' },
        codex: { command: 'codex', args: '--dangerously-bypass-approvals-and-sandbox' },
        devin: { command: 'devin', args: '--permission-mode bypass --respect-workspace-trust false' },
        gemini: { command: 'gemini', args: '--approval-mode=yolo' }
      }
    })
    expect(prefs.launch.claude.args).toBe('--model opus')
    expect(prefs.launch.codex.args).toBe('')
    expect(prefs.launch.devin.args).toBe('')
    expect(prefs.launch.gemini.args).toBe('')
  })

  it('security-3 [1] 同じ意味の別の書き方（=・短いフラグ・サンドボックスを外す指定）も外す。ほかの引数と引用符は残す', () => {
    expect(stripBypassArgs('claude', '--permission-mode=bypassPermissions --add-dir "a  b"')).toBe('--add-dir "a b"')
    expect(stripBypassArgs('claude', '--permission-mode plan')).toBe('--permission-mode plan')
    expect(stripBypassArgs('codex', '-s danger-full-access -a never --model o4')).toBe('--model o4')
    expect(stripBypassArgs('codex', '--sandbox=danger-full-access --yolo')).toBe('')
    expect(stripBypassArgs('codex', '--sandbox workspace-write')).toBe('--sandbox workspace-write')
    expect(stripBypassArgs('claude', '--add-dir "a  b"')).toBe('--add-dir "a  b"')
    for (const agent of BUILTIN_AGENTS) for (const unit of bypassArgUnits(agent)) expect(stripBypassArgs(agent, unit.join(' ')), `${agent} ${unit.join(' ')}`).toBe('')
  })

  it('security-3 [1] main の起動の決まり: 許していないプロジェクトでは省かず、信頼も書かない。許しても自動起動では省かない', () => {
    const base = { agent: 'claude' as const, args: '--dangerously-skip-permissions --model opus', bypassProjects: ['p-trusted'] }
    expect(resolveAgentLaunchPolicy({ ...base, projectId: 'p-cloned', autoStart: true })).toEqual({ args: '--model opus', bypass: false, trustFolder: false })
    expect(resolveAgentLaunchPolicy({ ...base, projectId: 'p-cloned', autoStart: false })).toEqual({ args: '--model opus', bypass: false, trustFolder: false })
    expect(resolveAgentLaunchPolicy({ ...base, projectId: null, autoStart: false })).toEqual({ args: '--model opus', bypass: false, trustFolder: false })
    expect(resolveAgentLaunchPolicy({ ...base, projectId: 'p-trusted', autoStart: true })).toEqual({ args: '--model opus', bypass: false, trustFolder: true })
    expect(resolveAgentLaunchPolicy({ ...base, projectId: 'p-trusted', autoStart: false })).toEqual({ args: '--dangerously-skip-permissions --model opus', bypass: true, trustFolder: true })
    expect(resolveAgentLaunchPolicy({ agent: 'codex', args: '', bypassProjects: ['p-trusted'], projectId: 'p-trusted', autoStart: false }).args)
      .toBe('--dangerously-bypass-approvals-and-sandbox')
  })

  it('security-3 [1] 権限確認を省く許可は、パスを見せた確認が通ったときだけ、そのプロジェクトにだけ付く', () => {
    const confirmNo = vi.fn(() => false)
    const confirmYes = vi.fn(() => true)
    const prefs = { ...DEFAULT_AGENT_PREFERENCES, bypassProjects: ['a'] }
    expect(setProjectBypass(prefs, 'b', true, confirmNo).bypassProjects).toEqual(['a'])
    expect(confirmNo).toHaveBeenCalledOnce()
    expect(setProjectBypass(prefs, 'b', true, confirmYes).bypassProjects).toEqual(['a', 'b'])
    // 外すときは確認しない・ほかのプロジェクトはそのまま
    const off = vi.fn(() => true)
    expect(setProjectBypass(prefs, 'a', false, off).bypassProjects).toEqual([])
    expect(off).not.toHaveBeenCalled()
    expect(sanitizeAgentPreferences({ bypassProjects: ['a', 'a', '', 3, ' '] }).bypassProjects).toEqual(['a'])
  })

  it('security-3 [1] プロジェクトの id はフォルダそのものでだけ決まる（サブフォルダ・ほかのプロジェクトに許可を引き継がない）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ferret-sec3-'))
    try {
      mkdirSync(join(dir, 'acme-shop', 'sub'), { recursive: true })
      mkdirSync(join(dir, 'other'))
      const projects = [{ id: 'p1', folderPath: join(dir, 'acme-shop') }, { id: 'p2', folderPath: join(dir, 'other') }]
      expect(registeredProjectIdFor(join(dir, 'acme-shop'), projects)).toBe('p1')
      expect(registeredProjectIdFor(join(dir, 'acme-shop', 'sub'), projects)).toBeNull()
      expect(registeredProjectIdFor(dir, projects)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('security-3 [1] 許していないプロジェクトでは、Claude Code / Codex の信頼の設定ファイルを変えない', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ferret-sec3-'))
    try {
      const home = join(dir, 'home')
      const project = join(dir, 'acme-shop')
      mkdirSync(home)
      mkdirSync(project)
      writeFileSync(join(home, '.claude.json'), '{"projects":{}}\n')
      // main は許したプロジェクトのフォルダだけを渡す（terminal.ts）。許していなければ空
      expect(await applyAgentWorkspaceTrust({ agent: 'claude', cwd: project, projectFolders: [], env: {}, homeDir: home })).toBe('skipped')
      expect(await applyAgentWorkspaceTrust({ agent: 'codex', cwd: project, projectFolders: [], env: {}, homeDir: home })).toBe('skipped')
      expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe('{"projects":{}}\n')
      expect(readdirSync(home)).toEqual(['.claude.json'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('security-3 [1] 不変条件: 権限確認を省くフラグを書いてよいのはカタログだけ。起動は main の決まりを通し、信頼は許可のときだけ書く', () => {
    const flags = ['--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox', 'danger-full-access']
    // コメントは除いて見る（説明に名前を書くのはよい）
    const code = (f: string) => read(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    const offenders = walk('src', /\.(ts|tsx)$/).filter((f) => f !== 'src/shared/agentCatalog.ts' && !f.startsWith('src/shared/i18n/'))
      .filter((f) => flags.some((flag) => code(f).includes(flag)))
    expect(offenders).toEqual([])
    const terminal = read('src/main/terminal.ts')
    expect(terminal).toMatch(/resolveAgentLaunchPolicy\(/)
    expect(terminal).toMatch(/if \(policy\?\.trustFolder\) \{\s*await applyAgentWorkspaceTrust\(/)
    expect(terminal.match(/applyAgentWorkspaceTrust\(/g)).toHaveLength(1)
    // プロジェクトを開いたときの自動起動は autoStart を付けて頼む
    expect(read('src/renderer/components/TerminalPane.tsx')).toMatch(/newPane\(\{ launch, cwd, autoStart: launch !== null \}\)/)
  })
})

// ───────────────────────── [2] ─────────────────────────

describe('security-3 [2] 配布物の真正性を、R2 とは別の鍵の署名で確かめる', () => {
  const tempKey = () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    return { pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), line: sshPublicKeyLine(publicKey) }
  }
  const sums = Buffer.from(`${'a'.repeat(64)}  Ferret-9.9.9-mac-arm64.dmg\n${'b'.repeat(64)}  Ferret-9.9.9-win-x64.exe\n`)

  it('security-3 [2] リリースの道具で署名したものを、アプリが同梱の形で確かめられる。書き換え・別の鍵・別の用途は通さない', () => {
    const key = tempKey()
    const sig = signSshsig(sums, key.pem)
    expect(verifySshSignature(sums, sig, key.line)).toBe(true)
    expect(verifySshsig(sums, sig, key.line)).toBe(true)
    expect(verifySshSignature(Buffer.from(sums.toString().replace('a', 'c')), sig, key.line)).toBe(false)
    expect(verifySshSignature(sums, sig, tempKey().line)).toBe(false)
    expect(verifySshSignature(sums, signSshsig(sums, key.pem, 'file'), key.line)).toBe(false)
    expect(verifySshSignature(sums, 'garbage', key.line)).toBe(false)
    // 同梱の公開鍵では、ほかの鍵の署名は通らない
    expect(verifySshSignature(sums, sig)).toBe(false)
  })

  it('security-3 [2] latest.json のファイルが、署名の合う SHA256SUMS に同じ値で載っているときだけ案内する', () => {
    const key = tempKey()
    const sig = signSshsig(sums, key.pem)
    const files = [{ name: 'Ferret-9.9.9-mac-arm64.dmg', sha256: 'a'.repeat(64) }]
    expect(releaseFilesAreSigned(files, sums, sig, key.line)).toBe(true)
    expect(releaseFilesAreSigned([{ ...files[0]!, sha256: 'd'.repeat(64) }], sums, sig, key.line)).toBe(false)
    expect(releaseFilesAreSigned([{ name: 'Ferret-9.9.9-linux-x86_64.AppImage', sha256: 'a'.repeat(64) }], sums, sig, key.line)).toBe(false)
    expect(releaseFilesAreSigned([], sums, sig, key.line)).toBe(false)
  })

  it('security-3 [2] 署名の無い新しい版は、更新の確認で案内しない（R2 だけを書き換えても偽の版へ誘わない）', async () => {
    setReporter({ handled: vi.fn(), message: vi.fn(), breadcrumb: vi.fn() })
    try {
      const { checkForUpdate } = await import('../../src/main/updateCheck')
      const fetcher = (async (url: string) => {
        if (url.endsWith('latest.json')) {
          return Response.json({ schema: 1, version: '99.0.0', date: '', prerelease: false, notes: '',
            files: [{ name: 'Ferret-99.0.0-mac-arm64.dmg', path: 'releases/99.0.0/Ferret-99.0.0-mac-arm64.dmg', size: 1, sha256: 'a'.repeat(64), os: 'mac', arch: 'arm64', kind: 'dmg' }] })
        }
        if (url.endsWith('/SHA256SUMS')) return new Response(`${'a'.repeat(64)}  Ferret-99.0.0-mac-arm64.dmg\n`)
        if (url.endsWith('/SHA256SUMS.sig')) return new Response(signSshsig(Buffer.from(`${'a'.repeat(64)}  Ferret-99.0.0-mac-arm64.dmg\n`), tempKey().pem))
        return new Response('nope', { status: 404 })
      }) as unknown as typeof fetch
      expect((await checkForUpdate(fetcher)).state).toBe('error')
      const missing = (async (url: string) => url.endsWith('latest.json') ? fetcher(url) : new Response('', { status: 404 })) as unknown as typeof fetch
      expect((await checkForUpdate(missing)).state).toBe('error')
    } finally {
      setReporter(null)
    }
  })

  it('security-3 [2] 不変条件: 公開鍵は R2 の外（リポジトリ・アプリ・SECURITY.md・ドキュメント）で同じ。署名者・用途も同じ', () => {
    const allowed = read('build/release-signing/allowed_signers')
    expect(trustedPublicKey(allowed)).toBe(RELEASE_PUBLIC_KEY)
    expect(read('SECURITY.md')).toContain(RELEASE_PUBLIC_KEY)
    expect(read('site/docs/install.html')).toContain(RELEASE_PUBLIC_KEY)
    expect(SIGNER_IDENTITY).toBe(RELEASE_SIGNER_IDENTITY)
    expect(SIGNING_NAMESPACE).toBe(RELEASE_SIGNING_NAMESPACE)
    // 公開鍵として読めること
    expect(() => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(RELEASE_PUBLIC_KEY.split(' ')[1]!, 'base64').subarray(-32).toString('base64url') }, format: 'jwk' })).not.toThrow()
    // 秘密鍵をリポジトリに置かない
    for (const f of [...walk('build', /./), ...walk('scripts', /./), ...walk('src', /./)]) expect(read(f), f).not.toMatch(/BEGIN PRIVATE KEY|BEGIN OPENSSH PRIVATE KEY/)
  })

  it('security-3 [2] 不変条件: 署名の鍵を持つのは R2 のトークンを持たないジョブだけ。stage / promote は署名を確かめ、promote は署名が無ければ止める', () => {
    const wf = read('.github/workflows/release.yml')
    const jobs = wf.split(/\n {2}(?=[\w-]+:\n)/)
    const withKey = jobs.filter((j) => /secrets\.RELEASE_SIGNING_KEY/.test(j))
    expect(withKey).toHaveLength(1)
    expect(withKey[0]).toMatch(/^checksums:/)
    expect(withKey[0]).not.toMatch(/secrets\.CLOUDFLARE_/)
    expect(withKey[0]).toMatch(/node scripts\/release-signing\.mjs sign --sums SHA256SUMS --out SHA256SUMS\.sig/)
    expect(jobs.find((j) => j.startsWith('stage:'))).toMatch(/--sums-sig release-meta\/SHA256SUMS\.sig/)
    expect(jobs.find((j) => j.startsWith('promote:'))).toMatch(/--sums-sig release-meta\/SHA256SUMS\.sig/)
    const r2 = read('scripts/release-r2.mjs')
    expect(r2).toMatch(/checkExpectedSums\(manifest, args, true\)/)
    expect(r2).toMatch(/assertSignedSums\(/)
    expect(read('scripts/release-github.mjs')).toMatch(/assertSignedSums\(/)
    // サイトの手順は、署名した SHA256SUMS を R2 の外の公開鍵で確かめる形
    const install = read('site/docs/install.html')
    expect(install).toContain('ssh-keygen -Y verify -f allowed_signers -I release@ferretade.dev -n ferret-release -s SHA256SUMS.sig')
    expect(install).not.toContain('There is no <code>SHA256SUMS</code> file')
  })
})

// ───────────────────────── [5] ─────────────────────────

describe('security-3 [5] プロジェクトの Markdown のプレビューで、外の画像を黙って読みに行かない', () => {
  it('security-3 [5] 外の画像は <img> にせず、行き先のホストを見せる印にする。プロジェクトの中の画像と data: はそのまま', () => {
    const html = renderPreviewBody('markdown', '![badge](https://tracker.example/p.png?u=1)\n\n![logo](docs/logo.png)\n\n![x](//cdn.example/a.png)\n\n![d](data:image/png;base64,AAAA)\n')
    expect(html).not.toMatch(/<img[^>]+src="(https?:)?\/\//)
    expect(html).toContain('class="remote-image"')
    expect(html).toContain('data-remote-host="tracker.example"')
    expect(html).toContain('data-remote-host="cdn.example"')
    expect(html).toMatch(/<img[^>]+src="docs\/logo\.png"/)
    expect(html).toMatch(/<img[^>]+src="data:image\/png/)
    // 参照形式・リンクの中の画像（README のバッジ）も同じ
    const ref = renderPreviewBody('markdown', '[![ci][b]](https://ci.example/)\n\n[b]: https://badge.example/ci.svg\n')
    expect(ref).not.toContain('<img')
    expect(ref).toContain('data-remote-host="badge.example"')
    expect(isRemoteImageSource('HTTP://x/y.png')).toBe(true)
    expect(isRemoteImageSource('ade-preview://project/a.png')).toBe(false)
    expect(isRemoteImageSource('a.png')).toBe(false)
  })

  it('security-3 [5] CSP は既定で外の画像を許さない。利用者が押したページだけ https を許す', () => {
    expect(previewCsp()).toMatch(/img-src ade-preview: data:(;|$)/)
    expect(previewCsp()).not.toMatch(/https:/)
    expect(previewCsp(true)).toMatch(/img-src ade-preview: data: https:/)
    expect(renderPreviewPage({ path: 'README.md', kind: 'markdown', body: '' })).toContain('data-remote-images="block"')
    expect(renderPreviewPage({ path: 'README.md', kind: 'markdown', body: '', remoteImages: true })).toContain('data-remote-images="allow"')
  })

  it('security-3 [5] 不変条件: プレビューの CSP を作るのは previewCsp だけで、既定で https を許す書き方が無い', () => {
    const index = read('src/main/preview/index.ts')
    expect(index).not.toMatch(/img-src[^\n]*https:/)
    expect(index).toMatch(/previewCsp\(remoteImages\)/)
    expect(read('src/main/preview/render.ts')).toMatch(/img-src \$\{PREVIEW_SCHEME\}: data:\$\{remoteImages \? ' https:' : ''\}/)
  })
})

// ───────────────────────── [6] ─────────────────────────

describe('security-3 [6] Sentry へ送る前に、素の IP アドレスを落とす', () => {
  const ips = ['203.0.113.9', '10.0.0.1', '127.0.0.1', '::1', 'fe80::1%en0', '2001:db8::8a2e:370:7334', '2001:0db8:0000:0000:0000:ff00:0042:8329', '::ffff:192.0.2.1']

  it.each(ips)('security-3 [6] %s は、ポート付き・括弧付きでも残らない', (ip) => {
    for (const text of [`connect ECONNREFUSED ${ip}:443`, `from ${ip}.`, `[${ip}]:8080`, `host=${ip}`]) {
      const out = scrubString(text)
      expect(out, text).not.toContain(ip)
      expect(out, text).toContain('<ip>')
    }
  })

  it('security-3 [6] IP でないもの（版・時刻・C++ の名前・スタックの行と列）は変えない', () => {
    for (const text of ['Electron 33.2.1', 'Chrome 130.0.6723.191', '12:34:56', 'Foo::add', 'std::vector', 'at app.js:12:34', 'a :: b', '1.2.3.4.5']) {
      expect(scrubString(text)).toBe(text)
    }
  })

  it('security-3 [6] 例外・breadcrumb・コンポーネントの階層・contexts のどこに入っていても落とす', () => {
    const ip = '198.51.100.23'
    const v6 = '2001:db8::1'
    const event = scrubEvent({
      exception: { values: [{ type: 'Error', value: `getaddrinfo ${ip} ${v6}`, stacktrace: { frames: [{ filename: 'app:///main.js', function: 'f' }] } }] },
      message: `failed ${ip}`,
      breadcrumbs: [{ category: 'startup', message: `listen ${v6}` }],
      contexts: { react: { componentStack: `in Foo (${ip})` }, os: { name: 'macOS', version: '15.6' } }
    })
    const text = JSON.stringify(event)
    expect(text).not.toContain(ip)
    expect(text).not.toContain(v6)
    expect(scrubBreadcrumb({ category: 'startup', message: `bind ${ip}` })?.message).toBe('bind <ip>')
  })

  it('security-3 [6] 不変条件: SECURITY.md が「送らない」と約束した種類ごとに、落とす見本がある', () => {
    // SECURITY.md の Crash reports の「… are removed or not collected」の並びを読み、種類ごとの見本で確かめる
    const policy = /Reports contain[^.]*\.\s*([^.]*?) are removed or not collected/.exec(read('SECURITY.md'))?.[1]
    expect(policy).toBeTruthy()
    // 「A, B, … Y and Z」。最後の項目だけ and で分ける（「Home and project paths」は1つの種類）
    const items = policy!.split(/,\s*/)
    const classes = [...items.slice(0, -1), ...items[items.length - 1]!.split(/\s+and\s+/)].map((s) => s.trim().toLowerCase()).filter(Boolean)
    const fake = ['s', 'k-', 'abcdefghijklmnop0123456789'].join('')
    const samples: Record<string, string[]> = {
      'home and project paths': ['/Users/taro/acme-shop/src/a.ts', 'C:\\Users\\taro\\acme-shop'],
      urls: ['https://acme-shop.example/admin?token=1'],
      'terminal output': [],
      transcripts: [],
      findings: [],
      'email addresses': ['alice@example.com'],
      'api keys': [fake],
      'ip addresses': ['203.0.113.9', '2001:db8::1']
    }
    for (const c of classes) {
      expect(Object.keys(samples), `SECURITY.md の「${c}」に見本が無い（ここに足す）`).toContain(c)
      for (const sample of samples[c]!) expect(scrubString(`boom ${sample} end`), `${c}: ${sample}`).not.toContain(sample)
    }
  })
})

// ───────────────────────── 再発防止（ドキュメント） ─────────────────────────

describe('security-3 再発防止: 方針を SECURITY.md に書き、テストで固定する', () => {
  it('security-3 SECURITY.md に、今回の種類の問題を作らないための決まりがある', () => {
    const md = read('SECURITY.md')
    for (const phrase of ['Agent trust', 'Release authenticity', 'Project-driven network requests', 'Public endpoints']) expect(md).toContain(phrase)
    expect(relative(root, join(root, 'test/unit/security-3.test.ts')).split(sep).join('/')).toBe('test/unit/security-3.test.ts')
  })
})

afterEach(() => vi.restoreAllMocks())
