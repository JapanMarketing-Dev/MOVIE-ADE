import { describe, expect, it } from 'vitest'
import {
  checkSshTarget,
  isValidSshHost,
  remoteShellCommand,
  remoteWorkspaceDirName,
  shellQuote,
  sshShellSpec
} from '@shared/sshCommand'
import {
  cloneFailure,
  cloneRepoName,
  normalizeCloneUrl,
  parseCloneProgress,
  parseSshConfigHosts,
  sanitizeProjectSource,
  stripUrlCredentials
} from '@shared/projectSource'

describe('SSH のコマンドの組み立て（注入を防ぐ）', () => {
  it('パスは単一引用符で囲み、中の引用符もそのままの文字として渡す', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(remoteShellCommand('/srv/app')).toBe(`cd '/srv/app' && exec "$SHELL" -l`)
    expect(remoteShellCommand('/srv/my app')).toBe(`cd '/srv/my app' && exec "$SHELL" -l`)
  })

  it('シェルの特殊文字（; && $() ` | 改行の代わりの文字）を含むパスでも、別のコマンドとして実行されない', () => {
    const evil = "/tmp/x'; rm -rf ~; echo '"
    const cmd = remoteShellCommand(evil)
    // 引用の外に出る ' は必ず '\'' の形（閉じて、エスケープした ' を足して、また開く）だけ
    expect(cmd).toBe(`cd '/tmp/x'\\''; rm -rf ~; echo '\\''' && exec "$SHELL" -l`)
    for (const path of ['/a/$(whoami)', '/a/`id`', '/a/b && reboot', '/a|nc x 1', '/a;b']) {
      expect(remoteShellCommand(path)).toBe(`cd ${shellQuote(path)} && exec "$SHELL" -l`)
    }
    // 改行・NUL は受け付けない
    expect(checkSshTarget({ host: 'box', path: '/a\nreboot' })).toEqual({ ok: false, reason: 'path' })
    expect(checkSshTarget({ host: 'box', path: '/a\0b' })).toEqual({ ok: false, reason: 'path' })
  })

  it('~ はリモートの $HOME に置き換える（引用符の中では展開されないため）', () => {
    expect(remoteShellCommand('~')).toBe(`cd "$HOME" && exec "$SHELL" -l`)
    expect(remoteShellCommand("~/my app's")).toBe(`cd "$HOME"/'my app'\\''s' && exec "$SHELL" -l`)
  })

  it('host は ssh のオプションに化けるもの（- で始まる）や空白・引用符を受け付けない', () => {
    for (const host of ['-oProxyCommand=sh', '--', 'a b', "a'b", 'a;b', '', 'a$(x)']) expect(isValidSshHost(host)).toBe(false)
    for (const host of ['dev-box', 'me@10.0.0.2', 'build.example.com', 'me@[fe80::1%en0]']) expect(isValidSshHost(host)).toBe(true)
    expect(checkSshTarget({ host: '  dev-box ', path: ' /srv/app ' })).toEqual({ ok: true, target: { host: 'dev-box', path: '/srv/app' } })
    expect(checkSshTarget({ host: 'dev-box', path: 'relative/path' })).toEqual({ ok: false, reason: 'path' })
  })

  it('spawn する引数は ssh -t -- <host> <リモートの1行>（シェルを通さない）', () => {
    expect(sshShellSpec({ host: 'dev-box', path: '/srv/app' })).toEqual({ file: 'ssh', args: ['-t', '--', 'dev-box', `cd '/srv/app' && exec "$SHELL" -l`] })
    expect(() => sshShellSpec({ host: '-oProxyCommand=evil', path: '/srv' })).toThrow()
  })

  it('ローカルの置き場のフォルダ名は host とパスごとに決まり、パスとして安全な文字だけ', () => {
    const a = remoteWorkspaceDirName({ host: 'me@dev-box', path: '/srv/app' })
    expect(a).toMatch(/^me-dev-box-app-[0-9a-f]{8}$/)
    expect(remoteWorkspaceDirName({ host: 'me@dev-box', path: '/srv/app' })).toBe(a)
    expect(remoteWorkspaceDirName({ host: 'me@dev-box', path: '/opt/app' })).not.toBe(a)
    expect(remoteWorkspaceDirName({ host: 'box', path: '/../..' })).not.toMatch(/\.\./)
  })
})

describe('プロジェクトの出どころ', () => {
  it('今の設定（source なし）はローカル。ssh が欠けた ssh もローカルに戻す。github の URL から資格情報を落とす', () => {
    expect(sanitizeProjectSource({})).toEqual({ source: 'local' })
    expect(sanitizeProjectSource({ source: 'ssh' })).toEqual({ source: 'local' })
    expect(sanitizeProjectSource({ source: 'ssh', ssh: { host: '-o x', path: '/a' } })).toEqual({ source: 'local' })
    expect(sanitizeProjectSource({ source: 'ssh', ssh: { host: 'box', path: '~/app' } })).toEqual({ source: 'ssh', ssh: { host: 'box', path: '~/app' } })
    expect(sanitizeProjectSource({ source: 'github', remoteUrl: 'https://user:ghp_secret@github.com/a/b.git' })).toEqual({ source: 'github', remoteUrl: 'https://github.com/a/b.git' })
    // 設定のスキーマ（remoteUrl は https / git@ / ssh:// だけ）に合わない file:// は残さない
    expect(sanitizeProjectSource({ source: 'github', remoteUrl: 'file:///tmp/x/repo.git' })).toEqual({ source: 'github' })
    expect(sanitizeProjectSource({ source: 'github', remoteUrl: 'git@github.com:a/b.git' })).toEqual({ source: 'github', remoteUrl: 'git@github.com:a/b.git' })
  })

  it('clone の URL: owner/repo・https・git@・file:// を受け付け、トークン入りや空白は受け付けない', () => {
    expect(normalizeCloneUrl('acme/shop')).toEqual({ ok: true, url: 'https://github.com/acme/shop.git' })
    expect(normalizeCloneUrl('https://github.com/acme/shop')).toEqual({ ok: true, url: 'https://github.com/acme/shop' })
    expect(normalizeCloneUrl('git@github.com:acme/shop.git')).toEqual({ ok: true, url: 'git@github.com:acme/shop.git' })
    expect(normalizeCloneUrl('file:///tmp/x/repo.git')).toEqual({ ok: true, url: 'file:///tmp/x/repo.git' })
    for (const bad of ['', 'https://x:tok@github.com/a/b', 'https://tok@github.com/a/b', '--upload-pack=evil', 'a b/c', 'just-text']) {
      expect(normalizeCloneUrl(bad)).toEqual({ ok: false })
    }
    expect(stripUrlCredentials('fatal: https://u:p@h/x and https://t@h/y and git@h:z')).toBe('fatal: https://h/x and https://h/y and git@h:z')
  })

  it('clone 先の名前は URL の最後の部分（.git は外す）。. や .. は受け付けない', () => {
    expect(cloneRepoName('https://github.com/acme/shop.git')).toBe('shop')
    expect(cloneRepoName('git@github.com:acme/shop.git')).toBe('shop')
    expect(cloneRepoName('file:///tmp/a/shop.git/')).toBe('shop')
    expect(cloneRepoName('https://example.com/..')).toBeNull()
  })

  it('進み具合は最後に出た「段階: n%」を読む', () => {
    expect(parseCloneProgress("Cloning into 'shop'...\nremote: Counting objects: 50% (1/2)\rReceiving objects:  42% (21/50)\rReceiving objects:  88% (44/50)")).toEqual({ phase: 'Receiving objects', percent: 88 })
    expect(parseCloneProgress('nothing here')).toBeNull()
  })

  it('失敗は「既にある・認証・見つからない・ネットワーク」に分け、資格情報を落とした fatal: の行を添える', () => {
    expect(cloneFailure("fatal: destination path 'shop' already exists and is not an empty directory.").kind).toBe('exists')
    expect(cloneFailure("remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found")).toEqual({ kind: 'not-found', detail: "fatal: repository 'https://github.com/a/b.git/' not found" })
    expect(cloneFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled").kind).toBe('auth')
    expect(cloneFailure('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.').kind).toBe('auth')
    expect(cloneFailure("fatal: unable to access 'https://x/': Could not resolve host: x").kind).toBe('network')
    expect(cloneFailure('fatal: https://u:secret@h/x broke').detail).toBe('fatal: https://h/x broke')
  })

  it('~/.ssh/config の Host を読み、ワイルドカード・否定・Match は除く', () => {
    const config = [
      'Host *', '  ServerAliveInterval 30',
      'Host dev-box build', '  HostName 10.0.0.2', '  User me # comment',
      'Host !bad *.internal', '  User x',
      'Match host foo', '  User y',
      'Host "quoted-host"'
    ].join('\n')
    expect(parseSshConfigHosts(config)).toEqual([
      { host: 'dev-box', hostname: '10.0.0.2', user: 'me' },
      { host: 'build', hostname: '10.0.0.2', user: 'me' },
      { host: 'quoted-host' }
    ])
  })
})

describe('SSH のプロジェクトで Agent に送る本文', async () => {
  const { buildRemoteFeedbackPrompt, MAX_REMOTE_FEEDBACK_CHARS } = await import('@shared/projectSource')
  it('前置きのあとに feedback.md の中身をそのまま貼り、長すぎれば切ったことを書く', () => {
    expect(buildRemoteFeedbackPrompt('Read this.', '# Feedback\n\n1. Fix the button\n', '(cut)')).toBe('Read this.\n\n# Feedback\n\n1. Fix the button\n')
    const long = buildRemoteFeedbackPrompt('Read.', 'x'.repeat(MAX_REMOTE_FEEDBACK_CHARS + 10), '(cut)')
    expect(long.endsWith('(cut)\n')).toBe(true)
    expect(long.length).toBeLessThan(MAX_REMOTE_FEEDBACK_CHARS + 30)
  })
})

describe('ホームの下のパスの見せ方', async () => {
  const { tildePath } = await import('@shared/projectSource')
  it('ホームの下は ~/… にし、ほかはそのまま', () => {
    expect(tildePath('/Users/someone/Projects/acme-web', '/Users/someone')).toBe('~/Projects/acme-web')
    expect(tildePath('/Users/someone', '/Users/someone/')).toBe('~')
    expect(tildePath('/Users/taro/x', '/Users/tar')).toBe('/Users/taro/x')
    expect(tildePath('/srv/x', '')).toBe('/srv/x')
  })
})
