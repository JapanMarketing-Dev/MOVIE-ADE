import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '@shared/i18n'
import { issueFromFeedback, mapPullRequests, parseAuthStatus, parseGitRemote, pickActiveAccount } from '../../src/main/github/parse'

describe('GitHub: remote URL から owner/repo', () => {
  it.each([
    ['https://github.com/JapanMarketing-Dev/ADE-movie.git', 'JapanMarketing-Dev', 'ADE-movie'],
    ['https://github.com/owner/repo', 'owner', 'repo'],
    ['https://github.com/owner/repo/', 'owner', 'repo'],
    ['git@github.com:owner/repo.git', 'owner', 'repo'],
    ['git@github.com:owner/repo', 'owner', 'repo'],
    ['ssh://git@github.com/owner/repo.git', 'owner', 'repo'],
    ['ssh://git@ssh.github.com:443/owner/repo.git', 'owner', 'repo'],
    ['  https://github.com/owner/my.repo.git\n', 'owner', 'my.repo']
  ])('%s', (url, owner, repo) => {
    expect(parseGitRemote(url)).toEqual({ host: 'github.com', owner, repo, webUrl: `https://github.com/${owner}/${repo}` })
  })

  it('GHES は http(s) のポートを残し、ssh のポートは捨てる', () => {
    expect(parseGitRemote('https://ghe.example.com:8443/team/app.git')?.host).toBe('ghe.example.com:8443')
    expect(parseGitRemote('ssh://git@ghe.example.com:2222/team/app.git')?.host).toBe('ghe.example.com')
  })

  it('owner/repo の形でないもの・ローカルのパスは null', () => {
    expect(parseGitRemote('')).toBeNull()
    expect(parseGitRemote('/Users/me/repo.git')).toBeNull()
    expect(parseGitRemote('C:\\work\\repo')).toBeNull()
    expect(parseGitRemote('https://github.com/owner')).toBeNull()
    expect(parseGitRemote('https://github.com/a/b/c')).toBeNull()
    expect(parseGitRemote('file:///tmp/owner/repo.git')).toBeNull()
  })
})

describe('GitHub: gh auth status の解析', () => {
  it('キーリングのログイン。伏せ字のトークンは結果に入らない', () => {
    const text = [
      'github.com',
      '  ✓ Logged in to github.com account octo-dev (keyring)',
      '  - Active account: true',
      '  - Git operations protocol: https',
      '  - Token: gho_************************************',
      "  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'"
    ].join('\n')
    const accounts = parseAuthStatus(text)
    expect(accounts).toEqual([{ host: 'github.com', user: 'octo-dev', active: true, source: 'keyring', scopes: ['gist', 'read:org', 'repo', 'workflow'] }])
    expect(JSON.stringify(accounts)).not.toContain('gho_')
  })

  it('複数アカウント・環境変数のトークン・GHES を読み分ける', () => {
    const text = [
      'github.com',
      '  ✓ Logged in to github.com account work (GITHUB_TOKEN)',
      '  - Active account: true',
      "  - Token scopes: 'repo'",
      '  ✓ Logged in to github.com account personal (keyring)',
      '  - Active account: false',
      '',
      'ghe.example.com',
      '  ✓ Logged in to ghe.example.com account corp (keyring)',
      '  - Active account: true'
    ].join('\r\n')
    const accounts = parseAuthStatus(text)
    expect(accounts.map((a) => [a.host, a.user, a.active, a.source])).toEqual([
      ['github.com', 'work', true, 'env'],
      ['github.com', 'personal', false, 'keyring'],
      ['ghe.example.com', 'corp', true, 'keyring']
    ])
    expect(pickActiveAccount(accounts, 'github.com')?.user).toBe('work')
    expect(pickActiveAccount(accounts, 'ghe.example.com')?.user).toBe('corp')
    expect(pickActiveAccount(accounts, 'other.example.com')).toBeNull()
  })

  it('未ログインは空。古い gh（Active account なし）の1件は使用中とみなす', () => {
    expect(parseAuthStatus('You are not logged into any GitHub hosts. To log in, run: gh auth login')).toEqual([])
    const old = parseAuthStatus('github.com\n  ✓ Logged in to github.com as someone (/Users/me/.config/gh/hosts.yml)\n  ✓ Logged in to github.com account someone (keyring)\n')
    expect(old).toHaveLength(1)
    expect(old[0]!.active).toBe(true)
  })
})

describe('GitHub: PR の JSON', () => {
  it('必要な項目だけに整える。壊れた要素は捨てる', () => {
    expect(mapPullRequests([
      { number: 7, title: 'Fix', state: 'OPEN', isDraft: true, url: 'https://github.com/o/r/pull/7', updatedAt: '2026-10-01T00:00:00Z', headRefName: 'fix' },
      { title: '番号なし' },
      'x'
    ])).toEqual([{ number: 7, title: 'Fix', state: 'OPEN', isDraft: true, url: 'https://github.com/o/r/pull/7', updatedAt: '2026-10-01T00:00:00Z', headRefName: 'fix' }])
    expect(mapPullRequests({ not: 'array' })).toEqual([])
  })
})

describe('GitHub: feedback.md から Issue', () => {
  afterEach(() => setLocale('en'))

  it('タイトルに見出しとホスト。画像の行は外して断り書きを付ける', () => {
    setLocale('ja')
    const md = [
      '# UIフィードバック（2件）',
      '- 対象: https://example.com/app',
      '',
      '## 1. [00:16] ボタン',
      '- 要望: 大きくする',
      '- 画像: ./01.png',
      '## 2. [00:21] 余白',
      '- 画像: ./02.png'
    ].join('\n')
    const { title, body } = issueFromFeedback(md)
    expect(title).toBe('UIフィードバック（2件）: example.com')
    expect(body).not.toContain('./01.png')
    expect(body).toContain('- 要望: 大きくする')
    expect(body).toContain('画像 2 枚は MOVIE-ADE のローカル')
  })

  it('英語の feedback.md も読める（書き出した時点の画面の言語に依らない）', () => {
    const md = ['# UI Feedback (1 item)', '- Target: https://example.com/app', '## 1. [00:16] Button', '- Request: Make it bigger', '- Images: ./01.png'].join('\n')
    const { title, body } = issueFromFeedback(md)
    expect(title).toBe('UI Feedback (1 item): example.com')
    expect(body).not.toContain('./01.png')
    expect(body).toContain('1 image is stored locally in MOVIE-ADE')
  })
})
