import { beforeEach, describe, expect, it } from 'vitest'
import { cliLoginCommand, cliLogoutCommand, forgeForHost, isSafeGitLabPath, isSafeHost } from '@shared/forge'
import { branchWebUrl } from '@shared/github'
import { normalizeCloneUrl } from '@shared/projectSource'
import { issueFromFeedback, needsHostLookup, parseForgeRemote, parseGitRemote } from '../../src/main/github/parse'
import { translate } from '@shared/i18n'
import { glabApiArgs, mapGitLabProjects, mapMergeRequests, parseGlabAuthStatus, projectEndpoint, webUrlFrom } from '../../src/main/github/gitlabParse'
import { classifyGlabError, commentOnMergeRequest, createGitLabIssue, gitlabAccounts, listGitLabRepos, myOpenMergeRequests, resetGitLabCache } from '../../src/main/github/gitlab'
import { resolveRemote } from '../../src/main/github'
import type { ExecResult } from '../../src/main/github/gh'

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', failed: false, missing: false, timedOut: false })
const fail = (stderr: string): ExecResult => ({ stdout: '', stderr, failed: true, missing: false, timedOut: false })
const missing: ExecResult = { stdout: '', stderr: '', failed: true, missing: true, timedOut: false }

/** 呼ばれた引数と標準入力を控える偽の glab */
function fakeGlab(reply: (args: string[]) => ExecResult) {
  const calls: Array<{ args: string[]; input?: string }> = []
  const run = async (args: string[], options?: { input?: string }) => {
    calls.push({ args, input: options?.input })
    return reply(args)
  }
  return { run, calls }
}

const AUTH_STATUS = [
  'gitlab.com',
  '  ✓ Logged in to gitlab.com as acme-dev (/home/someone/.config/glab-cli/config.yml)',
  '  ✓ Git operations for gitlab.com configured to use ssh protocol.',
  '  ✓ Token found: **************************',
  'git.acme.test',
  '  x git.acme.test: API call failed: GET https://git.acme.test/api/v4/user: 401 {message: 401 Unauthorized}',
  ''
].join('\n')

describe('ホストから GitHub / GitLab を見分ける', () => {
  it('gitlab.com・gitlab で始まるラベル・glab に登録したホストは GitLab、それ以外は GitHub（今までどおり）', () => {
    expect(forgeForHost('gitlab.com')).toBe('gitlab')
    expect(forgeForHost('gitlab.acme.test')).toBe('gitlab')
    expect(forgeForHost('code.acme.test')).toBe('github')
    expect(forgeForHost('code.acme.test:8443', ['code.acme.test'])).toBe('gitlab')
    expect(forgeForHost('github.com')).toBe('github')
    expect(forgeForHost('acme.ghe.com')).toBe('github')
    expect(forgeForHost('ghe.acme.test')).toBe('github')
  })

  it('ホスト名は英数字・-・. とポートだけ。シェルやオプションに読まれる値は通さない', () => {
    for (const good of ['gitlab.com', 'git.acme.test:8443', 'localhost']) expect(isSafeHost(good)).toBe(true)
    for (const bad of ['', '-oProxyCommand=x', 'a;b', 'a b', 'host$(id)', 'a..b', 'x:70000', 'h`id`', 'a/b', '-gitlab.com']) expect(isSafeHost(bad)).toBe(false)
  })

  it('GitLab のパスはサブグループを許し、- で始まる区切り・.. ・.git で終わる区切りは通さない', () => {
    expect(isSafeGitLabPath('acme/shop')).toBe(true)
    expect(isSafeGitLabPath('acme/web/team/shop')).toBe(true)
    for (const bad of ['shop', 'acme/-shop', 'acme/../shop', 'acme//shop', 'acme/shop.git', 'acme/sh op', 'acme/shop;id']) expect(isSafeGitLabPath(bad)).toBe(false)
  })

  it('ログインのコマンドは CLI の一覧の既定か、確かめたホストを付けた形だけ。危ないホストは既定に戻す', () => {
    expect(cliLoginCommand('glab')).toBe('glab auth login')
    expect(cliLoginCommand('glab', 'gitlab.com')).toBe('glab auth login')
    expect(cliLoginCommand('glab', 'git.acme.test')).toBe('glab auth login --hostname git.acme.test')
    expect(cliLoginCommand('glab', 'x; rm -rf ~')).toBe('glab auth login')
    expect(cliLoginCommand('glab', 'h$(id)')).toBe('glab auth login')
    expect(cliLoginCommand('gh')).toBe('gh auth login --web -h github.com')
    expect(cliLogoutCommand('glab', 'git.acme.test')).toBe('glab auth logout --hostname git.acme.test')
    expect(cliLogoutCommand('glab', 'a$(id)')).toBeNull()
  })
})

describe('origin の URL を読む', () => {
  it('GitLab はサブグループを owner に入れ、ページは /-/tree/ でブランチを開く', () => {
    const repo = parseForgeRemote('git@gitlab.com:acme/web/shop.git')
    expect(repo).toEqual({ host: 'gitlab.com', owner: 'acme/web', repo: 'shop', webUrl: 'https://gitlab.com/acme/web/shop', forge: 'gitlab' })
    expect(branchWebUrl(repo!, 'feat/a b')).toBe('https://gitlab.com/acme/web/shop/-/tree/feat/a%20b')
    expect(parseForgeRemote('https://gitlab.com/acme/shop')?.forge).toBe('gitlab')
  })

  it('セルフホストは glab に登録したホストのときだけ GitLab。それ以外の今までの GitHub の読み方は変わらない', () => {
    expect(parseForgeRemote('https://code.acme.test/team/app.git')).toEqual({ host: 'code.acme.test', owner: 'team', repo: 'app', webUrl: 'https://code.acme.test/team/app' })
    expect(parseForgeRemote('https://code.acme.test/team/sub/app.git', ['code.acme.test'])?.owner).toBe('team/sub')
    expect(parseForgeRemote('https://github.com/acme/shop.git')).toEqual(parseGitRemote('https://github.com/acme/shop.git'))
    expect(parseForgeRemote('https://github.com/acme/web/shop')).toBeNull()
    expect(parseForgeRemote('https://gitlab.com/acme/-evil')).toBeNull()
    expect(needsHostLookup('https://code.acme.test/a/b')).toBe('code.acme.test')
    expect(needsHostLookup('https://github.com/a/b')).toBeNull()
    expect(needsHostLookup('https://gitlab.com/a/b')).toBeNull()
  })

  it('決まらないホストだけ glab に聞く', async () => {
    let asked = 0
    const lookup = async () => { asked++; return ['code.acme.test'] }
    expect((await resolveRemote('https://github.com/acme/shop', lookup))?.forge).toBeUndefined()
    expect(asked).toBe(0)
    expect((await resolveRemote('https://code.acme.test/team/app', lookup))?.forge).toBe('gitlab')
    expect(asked).toBe(1)
    expect((await resolveRemote('https://code.acme.test/team/app', async () => { throw new Error('x') }))?.forge).toBeUndefined()
  })
})

describe('clone の URL を厳密に確かめる', () => {
  it('GitLab の URL（サブグループ・セルフホスト・scp 形式）は受け付ける', () => {
    for (const url of ['https://gitlab.com/acme/web/shop.git', 'ssh://git@git.acme.test:2222/acme/shop.git', 'git@gitlab.com:acme/web/shop.git']) {
      expect(normalizeCloneUrl(url)).toEqual({ ok: true, url })
    }
  })

  it('オプションに読まれる値・制御文字・?や#・..・ホストでないホストは断る', () => {
    for (const bad of [
      'git@-oProxyCommand=x:a/b', 'git@host:-a/b', 'https://gitlab.com/a/b?x=1', 'https://gitlab.com/a/b#x', 'https://gitlab.com/a/../b',
      'https://gitlab.com/a/b\u0007', 'https://bad_host!/a/b', 'git@host:a/../b', 'ext::sh -c id', 'https://gitlab.com/', 'a/../b'
    ]) {
      expect(normalizeCloneUrl(bad), bad).toEqual({ ok: false })
    }
  })
})

describe('glab の出力を読む', () => {
  it('auth status からホストとユーザーだけを読み、設定ファイルのパスは持たない', () => {
    const accounts = parseGlabAuthStatus(AUTH_STATUS)
    expect(accounts).toEqual([{ host: 'gitlab.com', user: 'acme-dev' }, { host: 'git.acme.test', user: null }])
    expect(JSON.stringify(accounts)).not.toContain('/home/')
  })

  it('プロジェクトの一覧は、パスと clone の URL が正しいものだけ。URL の認証情報は持たない', () => {
    const repos = mapGitLabProjects([
      { path_with_namespace: 'acme/web/shop', http_url_to_repo: 'https://gitlab.com/acme/web/shop.git', ssh_url_to_repo: 'git@gitlab.com:acme/web/shop.git', visibility: 'private', last_activity_at: '2026-10-01T00:00:00Z' },
      { path_with_namespace: 'acme/open', http_url_to_repo: 'https://gitlab.com/acme/open.git', visibility: 'public' },
      { path_with_namespace: 'acme/-bad', http_url_to_repo: 'https://gitlab.com/acme/-bad.git' },
      { path_with_namespace: 'acme/evil', http_url_to_repo: '--upload-pack=x' },
      null
    ], 'gitlab.com')
    expect(repos.map((r) => r.nameWithOwner)).toEqual(['acme/web/shop', 'acme/open'])
    expect(repos[0]).toMatchObject({ isPrivate: true, sshUrl: 'git@gitlab.com:acme/web/shop.git', host: 'gitlab.com' })
    expect(repos[1]!.isPrivate).toBe(false)
  })

  it('MR は iid を番号にし、壊れた項目は捨てる', () => {
    expect(mapMergeRequests([{ iid: 12, title: 'Fix', state: 'opened', draft: true, web_url: 'https://gitlab.com/a/b/-/merge_requests/12', source_branch: 'fix' }, { iid: -1 }, { title: 'x' }]))
      .toEqual([{ number: 12, title: 'Fix', state: 'OPEN', isDraft: true, url: 'https://gitlab.com/a/b/-/merge_requests/12', updatedAt: '', headRefName: 'fix' }])
  })

  it('API の引数は配列で、ホストとパスを確かめる。プロジェクトのパスは / ごと符号化する', () => {
    expect(projectEndpoint('acme/web/shop')).toBe('projects/acme%2Fweb%2Fshop')
    expect(() => projectEndpoint('acme/../x')).toThrow()
    expect(glabApiArgs('gitlab.com', 'POST', 'projects/a%2Fb/issues', true)).toEqual(['api', '--hostname', 'gitlab.com', '--method', 'POST', '--header', 'Content-Type: application/json', '--input', '-', 'projects/a%2Fb/issues'])
    expect(() => glabApiArgs('-x', 'GET', 'projects')).toThrow()
    expect(() => glabApiArgs('gitlab.com', 'GET', '--paginate')).toThrow()
    expect(() => glabApiArgs('gitlab.com', 'GET', 'projects;id')).toThrow()
  })

  it('作った Issue の URL は同じホストの https だけ', () => {
    expect(webUrlFrom({ web_url: 'https://gitlab.com/a/b/-/issues/3' }, 'gitlab.com')).toBe('https://gitlab.com/a/b/-/issues/3')
    expect(webUrlFrom({ web_url: 'https://evil.test/x' }, 'gitlab.com')).toBeNull()
    expect(webUrlFrom({ web_url: 'javascript:alert(1)' }, 'gitlab.com')).toBeNull()
  })

  it('失敗の文はトークンを伏せる', () => {
    const token = ['glpat', 'abcdefghijklmnopqrst'].join('-')
    const { kind, message } = classifyGlabError(fail(`boom ${token}`))
    expect(kind).toBe('failed')
    expect(message).not.toContain('abcdefghijklmnop')
    expect(classifyGlabError(fail('401 Unauthorized')).kind).toBe('not-logged-in')
    expect(classifyGlabError(fail('404 Project Not Found')).kind).toBe('repo-not-found')
    expect(classifyGlabError(missing).kind).toBe('missing')
  })
})

describe('glab で GitLab に送る（偽の glab。本物の GitLab には触れない）', () => {
  beforeEach(() => resetGitLabCache())
  const repo = { host: 'gitlab.com', owner: 'acme/web', repo: 'shop', webUrl: 'https://gitlab.com/acme/web/shop', forge: 'gitlab' as const }

  it('Issue の題名と本文は JSON で標準入力に渡し、引数には入れない', async () => {
    const glab = fakeGlab(() => ok(JSON.stringify({ web_url: 'https://gitlab.com/acme/web/shop/-/issues/7' })))
    const title = "Fix $(rm -rf ~) `id` 'q'"
    const body = '# Feedback\n; reboot'
    expect(await createGitLabIssue(repo, title, body, glab.run)).toEqual({ url: 'https://gitlab.com/acme/web/shop/-/issues/7' })
    expect(glab.calls).toHaveLength(1)
    expect(glab.calls[0]!.args).toEqual(['api', '--hostname', 'gitlab.com', '--method', 'POST', '--header', 'Content-Type: application/json', '--input', '-', 'projects/acme%2Fweb%2Fshop/issues'])
    expect(glab.calls[0]!.args.join(' ')).not.toContain('Fix')
    expect(JSON.parse(glab.calls[0]!.input!)).toEqual({ title, description: body })
  })

  it('MR へのコメントは notes へ。番号が正しくなければ glab を呼ばない', async () => {
    const glab = fakeGlab(() => ok('{}'))
    expect(await commentOnMergeRequest(repo, 12, 'hi', glab.run)).toEqual({ url: 'https://gitlab.com/acme/web/shop/-/merge_requests/12' })
    expect(glab.calls[0]!.args.at(-1)).toBe('projects/acme%2Fweb%2Fshop/merge_requests/12/notes')
    expect(JSON.parse(glab.calls[0]!.input!)).toEqual({ body: 'hi' })
    await expect(commentOnMergeRequest(repo, 0, 'hi', glab.run)).rejects.toThrow()
    expect(glab.calls).toHaveLength(1)
  })

  it('失敗したら利用者向けの文で投げる', async () => {
    const glab = fakeGlab(() => fail('401 Unauthorized'))
    await expect(createGitLabIssue(repo, 't', 'b', glab.run)).rejects.toThrow(/GitLab/)
  })

  it('自分の開いている MR を読む。失敗なら空', async () => {
    const glab = fakeGlab(() => ok(JSON.stringify([{ iid: 3, title: 'A', state: 'opened' }])))
    expect((await myOpenMergeRequests(repo, glab.run)).map((m) => m.number)).toEqual([3])
    expect(glab.calls[0]!.args.at(-1)).toContain('scope=created_by_me')
    expect(await myOpenMergeRequests(repo, fakeGlab(() => fail('x')).run)).toEqual([])
  })

  it('一覧はログイン済みのホストだけに聞く。glab が無い・未ログインはその旨を返す', async () => {
    const glab = fakeGlab((args) => args[0] === 'auth' ? ok(AUTH_STATUS) : ok(JSON.stringify([{ path_with_namespace: 'acme/shop', http_url_to_repo: 'https://gitlab.com/acme/shop.git', visibility: 'public' }])))
    const list = await listGitLabRepos(glab.run)
    expect(list).toMatchObject({ ghInstalled: true, loggedIn: true })
    expect(list.repos.map((r) => r.nameWithOwner)).toEqual(['acme/shop'])
    expect(glab.calls.filter((c) => c.args[0] === 'api').map((c) => c.args[2])).toEqual(['gitlab.com'])

    expect(await listGitLabRepos(fakeGlab(() => missing).run)).toEqual({ ghInstalled: false, loggedIn: false, repos: [] })
    expect(await listGitLabRepos(fakeGlab(() => ok('gitlab.com\n  x No token found\n')).run)).toEqual({ ghInstalled: true, loggedIn: false, repos: [] })
  })

  it('古い glab（--all が無い）には付けずに聞き直す。結果は少しの間覚える', async () => {
    const glab = fakeGlab((args) => args.includes('--all') ? fail('unknown flag: --all') : ok(AUTH_STATUS))
    expect((await gitlabAccounts(glab.run)).accounts[0]).toEqual({ host: 'gitlab.com', user: 'acme-dev' })
    await gitlabAccounts(glab.run)
    expect(glab.calls.map((c) => c.args.join(' '))).toEqual(['auth status --all', 'auth status'])
  })
})

describe('Issue の本文に、Agent 向けの節とローカルのパスを出さない', () => {
  it('進み具合・AFTER の節と、指摘ごとの BEFORE / AFTER の行（絶対パス）を外す（どの言語の feedback.md でも）', () => {
    const home = ['', 'Users', 'someone', 'acme-shop'].join('/')
    for (const locale of ['en', 'ja'] as const) {
      const tr = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate(locale, key, params)
      const md = [
        '# UI Feedback (1)',
        '## 1. Button',
        '- ID: `i-1`',
        tr('feedbackMd.afterLine', { url: 'http://localhost:3000/', width: 1280, height: 800, path: `${home}/.ferret/reviews/r/after/i-1.png` }),
        tr('feedbackMd.beforeImage', { path: `${home}/.ferret/reviews/r/01.png` }),
        '---',
        `## ${tr('feedbackMd.progress.heading')}`,
        `progress: ${home}/.ferret/reviews/r/progress.json`,
        `## ${tr('feedbackMd.after.heading')}`,
        `save to ${home}/after`
      ].join('\n')
      const { body } = issueFromFeedback(md)
      expect(body).toContain('## 1. Button')
      expect(body).not.toContain(home)
      expect(body).not.toContain(tr('feedbackMd.progress.heading'))
    }
  })
})
