/**
 * gh の失敗の出力をクラッシュレポートへ送らない（レポート [14]）。
 * 分類できない出力（パス・リポジトリ・URL・メール・トークン）でも、IPC の包みが Sentry へ報告しないことを確かめる
 */
import { describe, expect, it, vi } from 'vitest'
import { setLocale } from '@shared/i18n'
import { isUserFacingError } from '@shared/errors'
import { wrapIpcHandler } from '@shared/telemetry'
import { GhCommandError, classifyGhError, ghError, redactGhOutput, type ExecResult } from '../../src/main/github/gh'

setLocale('en')

const result = (stderr: string, stdout = ''): ExecResult => ({ stderr, stdout, failed: true, missing: false, timedOut: false })

const SENSITIVE = [
  'error: open /Users/someone/work/secret-repo/.git/config: permission denied',
  'POST https://api.github.com/repos/acme/private-roadmap/issues: 422 Validation Failed',
  'author alice@example.com is not a collaborator',
  'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 rejected',
  'GraphQL: something github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz went wrong',
  'Authorization: Bearer abcdefghijklmnop.qrstuvwxyz rejected',
  'remote https://alice:hunter2@github.example.com/acme/x.git failed'
]

describe('gh の失敗', () => {
  it('分類できない出力でも UserFacingError（GhCommandError）になる', () => {
    for (const line of SENSITIVE) {
      const err = ghError(result(line))
      expect(err).toBeInstanceOf(GhCommandError)
      expect(isUserFacingError(err)).toBe(true)
      expect(err.kind).toBe('failed')
    }
  })

  it('既知の失敗は決まった種類と文になり、出力は含まない', () => {
    expect(classifyGhError(result('To get started with GitHub CLI, please run:  gh auth login'))).toMatchObject({ kind: 'not-logged-in' })
    expect(classifyGhError(result('API rate limit exceeded for user /Users/alice'))).toMatchObject({ kind: 'rate-limited' })
    expect(classifyGhError(result('', '')).message).not.toMatch(/undefined/)
    expect(classifyGhError({ ...result(''), missing: true }).kind).toBe('missing')
    expect(classifyGhError({ ...result(''), timedOut: true }).kind).toBe('timeout')
    expect(classifyGhError(result('dial tcp 140.82.112.3:443: i/o timeout /Users/alice')).message).not.toContain('/Users/alice')
  })

  it('画面に出す文からトークン・Bearer の値・URL の認証情報を伏せる', () => {
    const text = redactGhOutput(SENSITIVE.join('\n'))
    expect(text).not.toContain('ghp_ABCDEFGHIJ')
    expect(text).not.toContain('github_pat_11ABC')
    expect(text).not.toContain('abcdefghijklmnop.qrstuvwxyz')
    expect(text).not.toContain('hunter2')
  })

  it('IPC の包みは gh の失敗を Sentry へ報告しない（画面にだけ返す）', async () => {
    const report = vi.fn()
    for (const line of SENSITIVE) {
      const handler = wrapIpcHandler('github:postReview', async () => { throw ghError(result(line)) }, report)
      await expect(handler()).rejects.toBeInstanceOf(GhCommandError)
    }
    expect(report).not.toHaveBeenCalled()
  })
})
