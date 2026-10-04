import { describe, expect, it, vi } from 'vitest'
import { applyOsLabel, osLabelFor } from '../../.github/scripts/issue-os-label.mjs'
import { collectEnvironment } from '../../src/main/feedback'
import { buildIssueBody, sanitizeEnvironment } from '../../src/shared/feedback'

/**
 * .github/workflows/issue-labels.yml が使う、Issue の本文から OS のラベルを決める関数。
 * アプリ内の「フィードバックを送る」が作る本文と、ブラウザのフォーム（bug_report.yml）の書き方の両方を読む。
 */

describe('osLabelFor', () => {
  it.each([
    ['darwin', 'os:macos'],
    ['win32', 'os:windows'],
    ['linux', 'os:linux']
  ] as const)('アプリ内のフィードバックの本文（%s）から読む', (platform, label) => {
    const env = sanitizeEnvironment(collectEnvironment({ appVersion: '0.4.0', packaged: true, platform, systemVersion: '1.0', arch: 'arm64', cpuModel: 'cpu', locale: 'en' }))
    const body = buildIssueBody({ kind: 'bug', title: 't', summary: 'It froze.', what: '', expected: '', actual: '' }, env, 'Ferret')
    expect(osLabelFor(body)).toBe(label)
  })

  it.each([
    ['- OS: macOS 26.0 (arm64)', 'os:macos'],
    ['* OS: Ubuntu 24.04', 'os:linux'],
    ['OS: win11', 'os:windows'],
    ['- os:  Fedora 42', 'os:linux']
  ] as const)('ブラウザのフォームで手で書いた「%s」も読む', (line, label) => {
    expect(osLabelFor(`### What happened?\n\nIt froze.\n\n### Environment\r\n\r\n- Ferret: 0.4.0\r\n${line}\r\n`)).toBe(label)
  })

  it.each([
    ['見出しが無い', '- OS: macOS 26.0'],
    ['Environment 以外の欄に書いた OS は見ない', '### What happened?\n\n- OS: macOS\n\n### Environment\n\n_No response_'],
    ['知らない OS', '### Environment\n\n- OS: FreeBSD 14'],
    ['空', ''],
    ['本文が無い', null]
  ])('読み取れなければ付けない（%s）', (_, body) => {
    expect(osLabelFor(body)).toBeNull()
  })

  it('次の見出しより後ろの OS は読まない', () => {
    expect(osLabelFor('### Environment\n\n- Ferret: 0.4.0\n\n### Screenshots\n\n- OS: Linux')).toBeNull()
  })
})

describe('applyOsLabel', () => {
  function fake(body: string, labels: Array<string | { name: string }>) {
    const github = { rest: { issues: { addLabels: vi.fn(async () => ({})), removeLabel: vi.fn(async () => ({})) } } }
    const context = { repo: { owner: 'o', repo: 'r' }, payload: { issue: { number: 7, body, labels } } }
    const core = { info: vi.fn() }
    return { github, context, core }
  }

  it('ほかの OS のラベルを外して、読み取った OS のラベルを付ける。ほかのラベルは触らない', async () => {
    const f = fake('### Environment\n\n- OS: Linux 6.8 (x64)', ['bug', { name: 'from-app' }, { name: 'os:macos' }])
    await applyOsLabel(f)
    expect(f.github.rest.issues.removeLabel).toHaveBeenCalledWith({ owner: 'o', repo: 'r', issue_number: 7, name: 'os:macos' })
    expect(f.github.rest.issues.addLabels).toHaveBeenCalledWith({ owner: 'o', repo: 'r', issue_number: 7, labels: ['os:linux'] })
  })

  it('もう付いていれば何もしない', async () => {
    const f = fake('### Environment\n\n- OS: Windows 11', ['os:windows'])
    await applyOsLabel(f)
    expect(f.github.rest.issues.addLabels).not.toHaveBeenCalled()
    expect(f.github.rest.issues.removeLabel).not.toHaveBeenCalled()
  })

  it('読み取れなければ、手で付けたラベルも外さない', async () => {
    const f = fake('### What happened?\n\nIt froze.', ['os:macos'])
    await applyOsLabel(f)
    expect(f.github.rest.issues.addLabels).not.toHaveBeenCalled()
    expect(f.github.rest.issues.removeLabel).not.toHaveBeenCalled()
  })

  it('外すラベルがもう無い（404）ときは続ける。ほかの失敗は止める', async () => {
    const f = fake('### Environment\n\n- OS: macOS 26.0', ['os:linux'])
    f.github.rest.issues.removeLabel.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }))
    await applyOsLabel(f)
    expect(f.github.rest.issues.addLabels).toHaveBeenCalled()

    const g = fake('### Environment\n\n- OS: macOS 26.0', ['os:linux'])
    g.github.rest.issues.removeLabel.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }))
    await expect(applyOsLabel(g)).rejects.toThrow('Forbidden')
  })
})
