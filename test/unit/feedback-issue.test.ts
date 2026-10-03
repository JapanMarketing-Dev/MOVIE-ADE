import { describe, expect, it, vi } from 'vitest'
import {
  BODY_MAX,
  NEW_ISSUE_URL_MAX,
  buildIssueBody,
  buildIssueTitle,
  buildNewIssueUrl,
  ghIssueCreateArgs,
  deriveTitle,
  isFeedbackIssueUrl,
  issueFormFields,
  type FeedbackSubmitInput,
  redactEnvironmentValue,
  sanitizeEnvironment,
  type FeedbackDraft,
  type FeedbackEnvironment
} from '@shared/feedback'
import { collectEnvironment, submitFeedback, type FeedbackSubmitDeps } from '../../src/main/feedback'
import type { ExecResult } from '../../src/main/github/gh'
import type { RelayResult } from '../../src/main/feedbackRelay'

// 鍵の形の偽の値は、秘密情報の検査に引っかからないよう実行時につないで作る
const fakeOpenAiKey = ['sk', 'proj', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4'].join('-')
const fakeGhToken = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('')

const env: FeedbackEnvironment = { appVersion: '0.1.1', build: 'dev', os: 'macOS', osVersion: '26.0', arch: 'arm64', cpu: 'Apple M3 Pro', locale: 'ja' }
const bug: FeedbackDraft = { kind: 'bug', title: '録画が止まらない', summary: '停止を押しても録画が続く', what: '録画を押した', expected: '止まる', actual: '止まらない' }

describe('フィードバック: 本文の組み立て', () => {
  it('Bug は「何が起きたか」と、書いた詳しい欄と環境情報。見出しは ISSUE_TEMPLATE と同じ英語', () => {
    const body = buildIssueBody(bug, env, 'Ferret')
    expect(body.startsWith('### What happened?\n\n停止を押しても録画が続く')).toBe(true)
    expect(body).toContain('### What did you do?\n\n録画を押した')
    expect(body).toContain('### What did you expect?\n\n止まる')
    expect(body).toContain('### What actually happened?\n\n止まらない')
    expect(body).toContain('### Environment\n\n- Ferret: 0.1.1 (dev)\n- OS: macOS 26.0 (arm64)\n- CPU: Apple M3 Pro\n- Language: ja')
    expect(buildIssueTitle(bug)).toBe('[Bug]: 録画が止まらない')
  })

  it('Idea は改善の見出し。書かなかった詳しい欄は入れない。環境情報を外せる', () => {
    const body = buildIssueBody({ kind: 'idea', title: 't', summary: '', what: '困りごと', expected: '', actual: '' }, null, 'Ferret')
    expect(body).toContain('### What would you like?\n\n_No response_')
    expect(body).toContain('### Problem or use case\n\n困りごと')
    expect(body).not.toContain('### Proposed solution')
    expect(body).not.toContain('### Environment')
    expect(buildIssueTitle({ kind: 'idea', title: ' 改善\nして ' })).toBe('[Feature]: 改善 して')
  })
})

describe('フィードバック: 環境情報に秘密やパスを入れない', () => {
  it('パス・URL・メール・鍵・利用者名を伏せる', () => {
    const dirty: FeedbackEnvironment = {
      appVersion: '0.1.1 /Users/someone/ferret',
      build: 'release',
      os: 'macOS',
      osVersion: '26.0 C:\\Users\\alice\\AppData',
      arch: 'arm64',
      cpu: `Apple M3 alice@example.com https://internal.example.com/x ${fakeOpenAiKey} ${fakeGhToken}`,
      locale: 'ja'
    }
    const clean = sanitizeEnvironment(dirty, ['alice', 'my-project'])
    const text = JSON.stringify(clean)
    for (const bad of ['/Users', 'alice', 'example.com', 'AppData', fakeOpenAiKey, fakeGhToken]) expect(text).not.toContain(bad)
    expect(clean.appVersion.startsWith('0.1.1')).toBe(true)
    expect(clean.cpu.startsWith('Apple M3')).toBe(true)
  })

  it('ふつうの値はそのまま（Intel の CPU 名の @ もメールとみなさない）', () => {
    expect(redactEnvironmentValue('Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz')).toBe('Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz')
    expect(sanitizeEnvironment(env)).toEqual(env)
  })

  it('collectEnvironment は OS の名前を読みやすくし、パスなどの項目を持たない', () => {
    const collected = collectEnvironment({ appVersion: '0.1.1', packaged: true, platform: 'win32', systemVersion: '10.0.26100', arch: 'x64', cpuModel: ' AMD Ryzen 7 ', locale: 'en' })
    expect(collected).toEqual({ appVersion: '0.1.1', build: 'release', os: 'Windows', osVersion: '10.0.26100', arch: 'x64', cpu: 'AMD Ryzen 7', locale: 'en' })
  })
})

describe('フィードバック: ブラウザで開く URL', () => {
  it('ひな形・題名・欄ごとの値（フォームの id）を入れる。短ければ切らない', () => {
    const { url, truncated } = buildNewIssueUrl('bug', '[Bug]: x', issueFormFields(bug, env, 'Ferret'))
    expect(truncated).toBe(false)
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://github.com/JapanMarketing-Dev/ferret/issues/new')
    expect(u.searchParams.get('template')).toBe('bug_report.yml')
    expect(u.searchParams.get('title')).toBe('[Bug]: x')
    expect(u.searchParams.get('what')).toBe('録画を押した')
    expect(u.searchParams.get('actual')).toBe('止まらない')
    expect(u.searchParams.get('environment')).toContain('- OS: macOS 26.0 (arm64)')
    // GitHub のフォームは body を受け付けないので入れない
    expect(u.searchParams.has('body')).toBe(false)
    expect(isFeedbackIssueUrl(url)).toBe(true)
  })

  it('環境情報を外したら environment を入れない', () => {
    const u = new URL(buildNewIssueUrl('bug', 't', issueFormFields(bug, null, 'Ferret')).url)
    expect(u.searchParams.has('environment')).toBe(false)
  })

  it('長すぎれば長い欄を短くして上限に収め、切ったことを書く', () => {
    const long = '日本語の長い本文。'.repeat(2000)
    const fields = issueFormFields({ kind: 'idea', title: 'y', summary: '', what: long, expected: '短い', actual: '' }, env, 'Ferret')
    const { url, truncated } = buildNewIssueUrl('idea', '[Feature]: y', fields)
    expect(truncated).toBe(true)
    expect(url.length).toBeLessThanOrEqual(NEW_ISSUE_URL_MAX)
    const u = new URL(url)
    expect(u.searchParams.get('what')!.startsWith('日本語の長い本文。')).toBe(true)
    expect(u.searchParams.get('what')).toContain('Truncated')
    expect(u.searchParams.get('expected')).toBe('短い')
    expect(u.searchParams.get('environment')).toContain('Ferret: 0.1.1')
    expect(u.searchParams.get('template')).toBe('feature_request.yml')
  })

  it('このリポジトリの「新しい Issue」以外は開かない', () => {
    expect(isFeedbackIssueUrl('https://github.com/other/repo/issues/new')).toBe(false)
    expect(isFeedbackIssueUrl('http://github.com/JapanMarketing-Dev/ferret/issues/new')).toBe(false)
    expect(isFeedbackIssueUrl('https://u:p@github.com/JapanMarketing-Dev/ferret/issues/new')).toBe(false)
  })
})

describe('フィードバック: 送り方（中継・gh はモック）', () => {
  const result = (patch: Partial<ExecResult>): ExecResult => ({ stdout: '', stderr: '', failed: false, missing: false, timedOut: false, ...patch })
  const base = { kind: 'bug' as const, title: '[Bug]: 録画が止まらない', body: '### What did you do?\n\nx', fields: { summary: 'x', what: '', expected: '', actual: '', environment: '' } }
  const viaGh: FeedbackSubmitInput = { ...base, via: 'gh', includeEnvironment: true, includeInstallId: true, images: [] }
  const viaRelay: FeedbackSubmitInput = { ...viaGh, via: 'relay' }
  const INSTALL = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'

  function deps(patch: Partial<FeedbackSubmitDeps> = {}) {
    return {
      relay: vi.fn(async (): Promise<RelayResult> => ({ ok: true, issue: 7, url: 'https://github.com/JapanMarketing-Dev/ferret/issues/7' })),
      appMeta: () => ({ appVersion: '0.2.0', platform: 'darwin', arch: 'arm64', osRelease: '25.6.0', installId: INSTALL }),
      gh: vi.fn(async () => result({ stdout: 'https://github.com/JapanMarketing-Dev/ferret/issues/42\n' })),
      signedIn: vi.fn(async () => true),
      openExternal: vi.fn(async () => {}),
      copyText: vi.fn(),
      ...patch
    }
  }

  it('gh の引数：-R・題名・ラベル・本文は標準入力', () => {
    expect(ghIssueCreateArgs('bug', '[Bug]: x')).toEqual(['issue', 'create', '-R', 'JapanMarketing-Dev/ferret', '--title', '[Bug]: x', '--label', 'bug', '--body-file', '-'])
    expect(ghIssueCreateArgs('idea', 't', false)).toEqual(['issue', 'create', '-R', 'JapanMarketing-Dev/ferret', '--title', 't', '--body-file', '-'])
    expect(ghIssueCreateArgs('idea', 't')).toContain('enhancement')
  })

  it('既定の匿名の中継：版・OS・インストール ID を main が添え、改善は enhancement で送る', async () => {
    const d = deps()
    expect(await submitFeedback({ ...viaRelay, kind: 'idea', title: '[Feature]: y' }, d)).toEqual({ kind: 'created', url: 'https://github.com/JapanMarketing-Dev/ferret/issues/7', via: 'relay' })
    expect(d.relay).toHaveBeenCalledWith(expect.objectContaining({ kind: 'enhancement', appVersion: '0.2.0', platform: 'darwin', arch: 'arm64', osRelease: '25.6.0', installId: INSTALL }))
    expect(d.gh).not.toHaveBeenCalled()
    expect(d.openExternal).not.toHaveBeenCalled()
  })

  it('環境情報・インストール ID を外したら、中継にも送らない', async () => {
    const d = deps()
    await submitFeedback({ ...viaRelay, includeEnvironment: false, includeInstallId: false }, d)
    const sent = vi.mocked(d.relay).mock.calls[0]![0] as unknown as Record<string, unknown>
    expect(sent).not.toHaveProperty('platform')
    expect(sent).not.toHaveProperty('arch')
    expect(sent).not.toHaveProperty('osRelease')
    expect(sent).not.toHaveProperty('installId')
    expect(sent.appVersion).toBe('0.2.0')
  })

  it('静止画は PNG / JPEG だけを中継に渡す（宣言ではなく中身で確かめる）', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]).toString('base64')
    const fake = Buffer.from('not an image').toString('base64')
    const d = deps()
    await submitFeedback({ ...viaRelay, images: [{ type: 'image/png', base64: png }, { type: 'image/png', base64: fake }] }, d)
    const sent = vi.mocked(d.relay).mock.calls[0]![0] as unknown as { images: Array<{ type: string }> }
    expect(sent.images.map((i) => i.type)).toEqual(['image/png'])
  })

  it('中継が落ちている（つながらない・5xx・送れない設定）ならブラウザの issues/new へ切り替える', async () => {
    for (const code of ['network', 'timeout', 'internal', 'upstream_failed', 'disabled'] as const) {
      const d = deps({ relay: vi.fn(async (): Promise<RelayResult> => ({ ok: false, code, retryable: true })) })
      expect(await submitFeedback(viaRelay, d)).toMatchObject({ kind: 'opened', reason: 'relay-down' })
      expect(isFeedbackIssueUrl(vi.mocked(d.openExternal).mock.calls[0]![0] as string)).toBe(true)
    }
  })

  it('中継が内容で断った（頻度・重複）なら、ブラウザへは回さず理由を返す', async () => {
    const d = deps({ relay: vi.fn(async (): Promise<RelayResult> => ({ ok: false, code: 'rate_limited', retryable: true, retryAfterSec: 120 })) })
    expect(await submitFeedback(viaRelay, d)).toEqual({ kind: 'rejected', code: 'rate_limited', retryable: true, retryAfterSec: 120 })
    expect(d.openExternal).not.toHaveBeenCalled()
    const dup = deps({ relay: vi.fn(async (): Promise<RelayResult> => ({ ok: false, code: 'duplicate', retryable: false })) })
    expect(await submitFeedback(viaRelay, dup)).toMatchObject({ kind: 'rejected', code: 'duplicate', retryable: false })
  })

  it('自分の GitHub アカウントで：gh issue create で作り、URL を返す（中継は使わない）', async () => {
    const d = deps()
    expect(await submitFeedback(viaGh, d)).toEqual({ kind: 'created', url: 'https://github.com/JapanMarketing-Dev/ferret/issues/42', via: 'gh' })
    expect(d.gh).toHaveBeenCalledWith(ghIssueCreateArgs('bug', base.title), expect.objectContaining({ input: base.body }))
    expect(d.relay).not.toHaveBeenCalled()
  })

  it('ラベルの権限で断られたら、ラベル無しで作り直す', async () => {
    const gh = vi.fn()
      .mockResolvedValueOnce(result({ failed: true, stderr: 'could not add label: \'bug\' not found' }))
      .mockResolvedValueOnce(result({ stdout: 'https://github.com/JapanMarketing-Dev/ferret/issues/43' }))
    const d = deps({ gh })
    expect(await submitFeedback(viaGh, d)).toMatchObject({ kind: 'created', via: 'gh' })
    expect(gh.mock.calls[1]![0]).not.toContain('--label')
  })

  it('gh を選んでもログインしていなければブラウザで開き、gh は呼ばない', async () => {
    const d = deps({ signedIn: vi.fn(async () => false) })
    expect(await submitFeedback(viaGh, d)).toEqual({ kind: 'opened', truncated: false, reason: 'not-signed-in' })
    expect(d.gh).not.toHaveBeenCalled()
  })

  it('gh が失敗したらブラウザへ切り替える。理由は伏せ字済みの短い文だけ', async () => {
    const d = deps({ gh: vi.fn(async () => result({ failed: true, stderr: `HTTP 500 token ${fakeGhToken}` })) })
    const out = await submitFeedback(viaGh, d)
    expect(out).toMatchObject({ kind: 'opened', reason: 'gh-failed' })
    expect(JSON.stringify(out)).not.toContain(fakeGhToken)
  })

  it('本文が URL に収まらなければ、全文をクリップボードへ写して開く', async () => {
    const big: FeedbackSubmitInput = { ...viaGh, body: 'x'.repeat(20_000), fields: { ...base.fields, what: 'x'.repeat(20_000) } }
    const d = deps({ signedIn: vi.fn(async () => false) })
    expect(await submitFeedback(big, d)).toMatchObject({ kind: 'opened', truncated: true })
    expect(d.copyText).toHaveBeenCalledWith(big.body)
    expect((vi.mocked(d.openExternal).mock.calls[0]![0] as string).length).toBeLessThanOrEqual(NEW_ISSUE_URL_MAX)
  })

  it('題名が空・種類が違う・本文が長すぎるものは送らない', async () => {
    const d = deps()
    await expect(submitFeedback({ ...viaRelay, title: '  ' }, d)).rejects.toThrow()
    await expect(submitFeedback({ ...viaRelay, title: '[Bug]:' }, d)).rejects.toThrow()
    await expect(submitFeedback({ ...viaRelay, kind: 'other' as never }, d)).rejects.toThrow()
    await expect(submitFeedback({ ...viaRelay, body: 'x'.repeat(BODY_MAX + 1) }, d)).rejects.toThrow()
    expect(d.relay).not.toHaveBeenCalled()
  })
})

describe('フィードバック: 一行だけでも送れる', () => {
  const empty = { title: '', summary: '', what: '', expected: '', actual: '' }
  it('題名が空なら、既定の欄（無ければ詳しい欄）の1行目から作る', () => {
    expect(deriveTitle({ ...empty, summary: '\n  ボタンが小さい\n2行目' })).toBe('ボタンが小さい')
    expect(deriveTitle({ ...empty, expected: '詳しい欄だけ' })).toBe('詳しい欄だけ')
    expect(deriveTitle({ ...empty, title: ' 自分の題名 ', summary: 'x' })).toBe('自分の題名')
    expect(deriveTitle({ ...empty, summary: 'あ'.repeat(100) })).toHaveLength(80)
    expect(deriveTitle(empty)).toBe('')
  })

  it('一行だけの声は、見出し1つと環境情報だけの短い本文になる', () => {
    const body = buildIssueBody({ kind: 'bug', ...empty, summary: '保存できない' }, null, 'Ferret')
    expect(body).toBe('### What happened?\n\n保存できない\n\n<sub>Sent from Ferret</sub>')
  })

  it('「ブラウザで開く」を選んだら、中継も gh も使わずに開く', async () => {
    const relay = vi.fn()
    const gh = vi.fn()
    const openExternal = vi.fn(async (_url: string) => {})
    const out = await submitFeedback(
      { kind: 'bug', title: '[Bug]: x', body: 'b', fields: { summary: 'x', what: '', expected: '', actual: '', environment: '' }, via: 'browser', includeEnvironment: false, includeInstallId: false, images: [] },
      { relay, gh, openExternal, copyText: vi.fn(), signedIn: async () => true, appMeta: () => ({ appVersion: '0.2.0', platform: 'darwin', arch: 'arm64', osRelease: '25.6.0', installId: undefined }) }
    )
    expect(out).toEqual({ kind: 'opened', truncated: false, reason: 'chosen' })
    expect(relay).not.toHaveBeenCalled()
    expect(gh).not.toHaveBeenCalled()
    expect(new URL(openExternal.mock.calls[0]![0]).searchParams.get('summary')).toBe('x')
  })
})
