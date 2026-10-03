import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pinnedInvocation, sentryCliInvocation, sentryInvocation, wranglerInvocation } from '../../scripts/release-tools.mjs'

/**
 * security-2 [2] Credentialed release jobs execute mutable npm tooling。
 * 再現の筋: secrets（Cloudflare・Sentry）を持つリリースのジョブ／スクリプトが、npx --yes wrangler@latest や
 * npx --yes @sentry/cli@2 のように lockfile の外の版を実行時に取ってきて動かす → 新しく出た悪い版がトークンを持ったまま動く。
 * 直し方: 道具は devDependencies で完全な版に固定し（pnpm-lock.yaml の integrity）、node_modules の bin を node で直接起動する。
 * 入っていなければ取りに行かずに止める。ネットワークも R2・GitHub・Sentry も使わない（ファイルを読むのと、一時フォルダだけ）。
 */

const root = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const PINNED = ['wrangler', 'sentry', '@sentry/cli'] as const

describe('security-2 [2] 固定した道具は手元の node_modules からだけ起動する', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  /** package.json（devDependencies）と、必要なら node_modules の中の道具を置いた一時のリポジトリ */
  function fakeRepo(spec: string, installed?: { version: string; bin: string }) {
    dir = mkdtempSync(join(tmpdir(), 'ferret-pinned-tools-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { wrangler: spec } }))
    if (installed) {
      mkdirSync(join(dir, 'node_modules', 'wrangler', 'bin'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'wrangler', 'package.json'), JSON.stringify({ version: installed.version, bin: { wrangler: installed.bin } }))
    }
    return dir
  }

  it('security-2 [2] 固定した wrangler が入っていなければ、npx で取りに行かずに止める', () => {
    const repo = fakeRepo('4.147.0')
    expect(() => pinnedInvocation('wrangler', 'wrangler', ['r2', 'object', 'put'], repo)).toThrow(/入っていません.*取りに行くことはしません/)
  })

  it('security-2 [2] 入っている版が固定と違えば止める（lockfile の外の版を動かさない）', () => {
    const repo = fakeRepo('4.147.0', { version: '4.999.0', bin: 'bin/wrangler.js' })
    expect(() => pinnedInvocation('wrangler', 'wrangler', [], repo)).toThrow(/4\.999\.0.*4\.147\.0/)
  })

  it.each(['latest', '^4.147.0', '~4.147.0', '4', '>=4', '*', undefined])(
    'security-2 [2] package.json の指定が完全な版でない（%s）なら止める',
    (spec) => {
      const repo = fakeRepo(spec as string, { version: '4.147.0', bin: 'bin/wrangler.js' })
      expect(() => pinnedInvocation('wrangler', 'wrangler', [], repo)).toThrow(/完全な版/)
    }
  )

  it('security-2 [2] 固定どおりに入っていれば、node で bin の JS を直接起動する（npx も shell も使わない）', () => {
    const repo = fakeRepo('4.147.0', { version: '4.147.0', bin: 'bin/wrangler.js' })
    expect(pinnedInvocation('wrangler', 'wrangler', ['r2', 'a & b'], repo)).toEqual({
      command: process.execPath,
      args: [join(repo, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'r2', 'a & b']
    })
  })

  it('security-2 [2] このリポジトリの wrangler・sentry・@sentry/cli は node_modules の固定した版を指す', () => {
    for (const inv of [wranglerInvocation(['--version']), sentryInvocation(['--version']), sentryCliInvocation(['--version'])]) {
      expect(inv.command).toBe(process.execPath)
      expect(inv.args[0].startsWith(join(root, 'node_modules'))).toBe(true)
      expect(inv.args.join(' ')).not.toMatch(/\bnpx\b|--yes/)
    }
  })
})

describe('security-2 [2] リリースの道具の版は lockfile で固定する', () => {
  it.each(PINNED)('security-2 [2] %s は devDependencies に完全な版で入り、pnpm-lock.yaml に integrity がある', (name) => {
    const pkg = JSON.parse(read('package.json')) as { devDependencies: Record<string, string> }
    const version = pkg.devDependencies[name]
    expect(version, name).toMatch(/^\d+\.\d+\.\d+$/)
    const lock = read('pnpm-lock.yaml')
    const key = `${name}@${version}`.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    expect(lock).toMatch(new RegExp(`\\n {2}'?${key}'?:\\n {4}resolution: \\{integrity: sha512-`))
  })

  it('security-2 [2] レポートの呼び出し（wrangler@latest・@sentry/cli@2・PATH の sentry）がスクリプトに残っていない', () => {
    expect(read('scripts/release-r2.mjs')).not.toMatch(/wrangler@latest|process\.env\.WRANGLER/)
    for (const f of ['scripts/sentry-sourcemaps.mjs', 'scripts/sentry-release.mjs', 'scripts/sentry-alerts.mjs']) {
      const text = read(f)
      expect(text, f).not.toMatch(/@sentry\/cli@\d|sentry@\$\{|SENTRY_CLI_VERSION/)
      expect(text, f).not.toMatch(/spawnSync\(\s*['"]sentry['"]/)
      expect(text, f).toMatch(/sentryInvocation/)
    }
  })
})

describe('security-2 [2] secrets を持つ場所で、実行時にパッケージを取ってこない', () => {
  // npx・pnpm dlx・yarn dlx・bunx・npm exec は、lockfile の外の版を取って動かしうる
  const FETCHING = /\b(npx|bunx)\b|\b(pnpm|yarn)\s+dlx\b|\bnpm\s+exec\b|corepack\s+prepare\s+pnpm@\d+(?:\.\d+)?\s/

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(join(root, dir))) {
      if (name === 'node_modules') continue
      const p = `${dir}/${name}`
      if (statSync(join(root, p)).isDirectory()) walk(p, out)
      else if (/\.(mjs|cjs|js|sh)$/.test(name)) out.push(p)
    }
    return out
  }

  it.each(readdirSync(join(root, '.github/workflows')).map((f) => `.github/workflows/${f}`))(
    'security-2 [2] %s は npx・dlx を使わず、secrets を渡すジョブは lockfile どおりに入れてから動かす',
    (file) => {
      const text = read(file)
      expect(text).not.toMatch(FETCHING)
      // secrets を使うジョブ（インデント 2 のジョブ名ごと）で、道具を入れるのは --frozen-lockfile だけ
      for (const job of text.split(/\n(?= {2}[\w-]+:\n)/).filter((j) => /secrets\./.test(j))) {
        for (const m of job.matchAll(/\b(pnpm|npm)\s+(install|i|ci|add)\b[^\n]*/g)) {
          expect(m[0], file).toMatch(/pnpm install --frozen-lockfile/)
        }
      }
    }
  )

  it.each(walk('scripts'))('security-2 [2] %s は npx・dlx でパッケージを取ってこない', (file) => {
    // 説明のコメントは除いて、実行する行だけを見る
    const code = read(file)
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|#)/.test(l))
      .join('\n')
    expect(code).not.toMatch(FETCHING)
  })

  it('security-2 [2] package.json のスクリプトも npx・dlx を使わない', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    for (const [name, cmd] of Object.entries(pkg.scripts)) expect(cmd, name).not.toMatch(FETCHING)
  })
})
