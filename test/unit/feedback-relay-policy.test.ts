import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as shared from '../../src/shared/feedbackRelay'
import * as limits from '../../workers/feedback-relay/src/limits'
import { ALLOWED_FIELDS, ERROR_STATUS } from '../../workers/feedback-relay/src/limits'

/**
 * 匿名フィードバックの中継のポリシー（ファイルを読むだけ。何も送らない）。
 *   - GitHub のトークンなどの秘密がリポジトリに無い（Worker の secret にだけ入れる）
 *   - Worker が受け付けるフィールドは決まった分だけ（匿名なので、名前・メールなどを足させない）
 *   - CORS を出さない・ログに要求の中身を出さない
 */

const root = resolve(__dirname, '../..')
const relay = 'workers/feedback-relay'
const read = (p: string) => readFileSync(join(root, p), 'utf8')

/**
 * 調べるファイルの一覧。git の作業ツリーなら追跡中と未追加（.gitignore の対象外）のファイル。
 * リリースの build は .git を写さない複製の中で単体テストを流すので、そのときはフォルダをたどる（生成物と依存は除く）
 */
function repoFiles(): string[] {
  try {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\u0000')
      .filter(Boolean)
  } catch {
    const skip = new Set(['.git', 'node_modules', 'out', 'dist', 'e2e-artifacts', 'test-results', 'playwright-report'])
    const found: string[] = []
    const walk = (rel: string): void => {
      for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
        const path = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (!skip.has(entry.name)) walk(path)
        } else if (entry.isFile()) found.push(path)
      }
    }
    walk('')
    return found
  }
}

describe('feedback-relay のポリシー', () => {
  it('受け付けるフィールドは仕様の9つだけ（増やすときは github-integration と仕様を合わせ、このテストも直す）', () => {
    expect([...ALLOWED_FIELDS]).toEqual(['kind', 'title', 'body', 'appVersion', 'platform', 'arch', 'osRelease', 'installId', 'image'])
    // 送り主を特定しうるものは受けない
    for (const name of ['email', 'githubLogin', 'githubEmail', 'name', 'ip', 'user', 'diagnosticBundle']) {
      expect(ALLOWED_FIELDS as readonly string[]).not.toContain(name)
    }
  })

  it('中継の仕様の値は、アプリと共有する src/shared/feedbackRelay.ts と同じもの（re-export。値がずれない）', () => {
    for (const name of ['ALLOWED_FIELDS', 'KINDS', 'PLATFORMS', 'ARCHES', 'MAX_TITLE_CHARS', 'MAX_BODY_BYTES', 'MAX_IMAGES', 'MAX_IMAGE_BYTES', 'MAX_REQUEST_BYTES', 'ERROR_STATUS'] as const) {
      expect(limits[name], name).toBe(shared[name])
    }
    // 送り直してよい code は中継が実際に返すもの
    for (const code of shared.RETRYABLE_CODES) expect(Object.keys(limits.ERROR_STATUS)).toContain(code)
  })

  it('失敗の code は短い英小文字の識別子だけで、状態は 4xx / 5xx', () => {
    for (const [code, status] of Object.entries(ERROR_STATUS)) {
      expect(code).toMatch(/^[a-z_]{3,32}$/)
      expect(status).toBeGreaterThanOrEqual(400)
    }
  })

  it('リポジトリ（追跡中と、まだ追加していないファイル）に GitHub のトークンの形が無い', () => {
    const files = repoFiles()
    const TOKEN = /\b(gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{70,})\b/g
    // テストの見るからに偽物の値（ABCDEF… の並び・同じ文字の繰り返し）は除く。本物のトークンはこの形にならない
    const obviouslyFake = (t: string) => /ABCDEFGHIJ|abcdefghij|0123456789/.test(t) || /(.{1,10})\1{3,}/.test(t.replace(/^[a-z]+_/, ''))
    const offenders: string[] = []
    for (const f of files) {
      let st
      try {
        st = statSync(join(root, f))
      } catch {
        continue
      }
      if (!st.isFile() || st.size > 2 * 1024 * 1024) continue
      const text = readFileSync(join(root, f), 'utf8')
      if (text.includes('\u0000')) continue
      if ([...text.matchAll(TOKEN)].some((m) => !obviouslyFake(m[1]))) offenders.push(f)
    }
    expect(offenders).toEqual([])
    // リポジトリの全ファイルを読むので、git の無い写し（関門）と遅い Windows では 10 秒を超えることがある
  }, 60_000)

  it('wrangler の設定に秘密を書かない（GITHUB_TOKEN・RATE_LIMIT_SALT は secret で入れる）', () => {
    const config = read(`${relay}/wrangler.jsonc`)
    const vars = /"vars"\s*:\s*\{([^}]*)\}/.exec(config)?.[1] ?? ''
    expect(vars).not.toMatch(/GITHUB_TOKEN|RATE_LIMIT_SALT|TOKEN|SECRET|SALT/)
    expect(config).toMatch(/"workers_dev"\s*:\s*false/)
    // 画像の置き場は配布物のバケットと別
    const buckets = [...config.matchAll(/"bucket_name"\s*:\s*"([^"]+)"/g)].map((m) => m[1])
    expect(buckets).toEqual(['ferret-feedback-media'])
  })

  it('CORS を出さず、ログに要求・IP・トークンを出さない', () => {
    const files = ['index.ts', 'github.ts', 'limiter.ts', 'redact.ts', 'images.ts', 'limits.ts', 'env.ts'].map((f) => `${relay}/src/${f}`)
    for (const f of files) {
      const text = read(f)
      expect(text, f).not.toMatch(/access-control-allow/i)
      for (const m of text.matchAll(/console\.\w+\(([^)]*)\)/g)) {
        expect(m[1], f).not.toMatch(/request|ip|token|body|title|env\.|installId|form/i)
      }
      // トークンを読むのは index.ts の1か所（createIssue に渡す）だけで、使うのは GitHub への Authorization ヘッダーだけ
      const reads = text.match(/env\.GITHUB_TOKEN/g)?.length ?? 0
      expect(reads, f).toBe(f.endsWith('index.ts') ? 1 : 0)
      if (f.endsWith('github.ts')) expect(text.match(/\$\{token\}/g)).toEqual(['${token}'])
    }
  })
})
