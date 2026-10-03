import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecResult } from '../../src/main/github/gh'
import type { SessionPaths } from '../../src/main/sessions/paths'

// git と gh は呼ばない。origin は GitHub のリポジトリとして返し、gh に渡った引数と入力を控える
const calls: Array<{ args: string[]; input?: string }> = []
const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', failed: false, missing: false, timedOut: false })
vi.mock('../../src/main/github/gh', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/github/gh')>()
  return {
    ...actual,
    run: vi.fn(async (_file: string, args: string[]) => {
      calls.push({ args })
      return ok('https://github.com/o/r.git\n')
    }),
    gh: vi.fn(async (args: string[], options?: { input?: string }) => {
      calls.push({ args, input: options?.input })
      return ok('[]')
    })
  }
})

const { githubReviewDraft } = await import('../../src/main/github/index')
const { UserFacingError } = await import('@shared/errors')
const { t } = await import('@shared/i18n')

const CANARY = 'CANARY-ssh-private-key-0f3a9c'

describe.skipIf(process.platform === 'win32')('security-2 [1] リンクの feedback.md は読まず、Issue の本文に外のファイルの中身を入れない', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gh-draft-'))
    calls.length = 0
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const draftFor = (feedbackMd: string) => githubReviewDraft({ feedbackMd } as SessionPaths, dir)

  it('外のファイルを指すリンクは「見つかりません」になり、canary は本文にも gh の引数にも出ない', async () => {
    const outside = join(dir, 'outside-secret.txt')
    writeFileSync(outside, `# UIフィードバック（1件）\n${CANARY}\n`)
    const link = join(dir, 'feedback.md')
    symlinkSync(outside, link)

    const result = await draftFor(link).then((draft) => ({ draft, error: null }), (error: unknown) => ({ draft: null, error }))
    expect(result.draft).toBeNull()
    expect(String(result.error)).not.toContain(CANARY)
    expect(result.error).toBeInstanceOf(UserFacingError)
    expect((result.error as Error).message).toBe(t('github.errors.feedbackMissing'))
    expect(JSON.stringify(calls)).not.toContain(CANARY)
  })

  it('1MB を超える feedback.md も読まない', async () => {
    const big = join(dir, 'feedback.md')
    writeFileSync(big, `# UIフィードバック（1件）\n${CANARY}\n${'x'.repeat(1024 * 1024)}`)

    const error = await draftFor(big).then(() => null, (err: unknown) => err)
    expect(error).toBeInstanceOf(UserFacingError)
    expect((error as Error).message).toBe(t('github.errors.feedbackMissing'))
    expect(JSON.stringify(calls)).not.toContain(CANARY)
  })

  it('ふつうの feedback.md は本文になる（上の2件が別の理由で落ちていないことの確認）', async () => {
    const plain = join(dir, 'feedback.md')
    writeFileSync(plain, '# UIフィードバック（1件）\n- 対象: https://example.com/\n\n## 1. ボタン\n- 要望: 大きく\n')
    const draft = await draftFor(plain)
    expect(draft.repo).toMatchObject({ owner: 'o', repo: 'r' })
    expect(draft.body).toContain('- 要望: 大きく')
  })
})
