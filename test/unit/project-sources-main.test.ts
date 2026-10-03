import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cloneRepository, defaultCloneParent, listGitHubRepos, listSshHosts } from '../../src/main/projectSources'

/** mkdtemp の中に、1コミットだけの bare リポジトリを作る（本物の GitHub には触れない） */
function makeBareRepo(root: string): string {
  const work = join(root, 'work')
  mkdirSync(work)
  const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
  git(['init', '-q', '-b', 'main'], work)
  writeFileSync(join(work, 'README.md'), '# acme-shop\n')
  git(['-c', 'user.email=qa@example.com', '-c', 'user.name=qa', 'add', '.'], work)
  git(['-c', 'user.email=qa@example.com', '-c', 'user.name=qa', 'commit', '-q', '-m', 'init'], work)
  const bare = join(root, 'acme-shop.git')
  git(['clone', '-q', '--bare', work, bare], root)
  return bare
}

describe('GitHub から取得（clone）', () => {
  it('file:// の bare リポジトリを親フォルダの下へ clone し、そのパスを返す', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ferret-clone-'))
    try {
      const url = pathToFileURL(makeBareRepo(root)).href
      const parent = join(root, 'projects')
      const progress: number[] = []
      const outcome = await cloneRepository({ url, parent }, (p) => progress.push(p.percent))
      expect(outcome).toEqual({ ok: true, path: join(parent, 'acme-shop'), url })
      expect(existsSync(join(parent, 'acme-shop', 'README.md'))).toBe(true)
      // 同じ場所へもう一度は「既にある」。中身は消さない
      const again = await cloneRepository({ url, parent }, () => undefined)
      expect(again).toMatchObject({ ok: false, kind: 'exists' })
      expect(existsSync(join(parent, 'acme-shop', 'README.md'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('見つからないリポジトリは失敗の種類を返し、作りかけのフォルダを残さない', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ferret-clone-'))
    try {
      const parent = join(root, 'projects')
      const outcome = await cloneRepository({ url: pathToFileURL(join(root, 'missing.git')).href, parent }, () => undefined)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(['not-found', 'failed']).toContain(outcome.kind)
      expect(existsSync(join(parent, 'missing'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('URL・保存先が不正なら git を動かさない', async () => {
    expect(await cloneRepository({ url: '--upload-pack=evil', parent: '/tmp' }, () => undefined)).toMatchObject({ ok: false, kind: 'failed' })
    expect(await cloneRepository({ url: 'acme/shop', parent: 'relative/dir' }, () => undefined)).toMatchObject({ ok: false, kind: 'failed' })
  })
})

describe('gh の一覧（モック）', () => {
  const result = (patch: Partial<{ stdout: string; stderr: string; failed: boolean; missing: boolean; timedOut: boolean }>) =>
    async () => ({ stdout: '', stderr: '', failed: false, missing: false, timedOut: false, ...patch })

  it('ログイン済みなら一覧を返す', async () => {
    const stdout = JSON.stringify([{ nameWithOwner: 'acme/shop', url: 'https://github.com/acme/shop', isPrivate: true }, { bad: 1 }])
    expect(await listGitHubRepos(result({ stdout }))).toEqual({ ghInstalled: true, loggedIn: true, repos: [{ nameWithOwner: 'acme/shop', url: 'https://github.com/acme/shop', isPrivate: true }] })
  })

  it('gh が無い・未ログインは一覧なしで、そのことを返す', async () => {
    expect(await listGitHubRepos(result({ missing: true }))).toEqual({ ghInstalled: false, loggedIn: false, repos: [] })
    const notLoggedIn = await listGitHubRepos(result({ failed: true, stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login' }))
    expect(notLoggedIn).toMatchObject({ ghInstalled: true, loggedIn: false, repos: [] })
  })
})

describe('~/.ssh/config と既定の保存先（一時フォルダの HOME で）', () => {
  it('Host を読み、無ければ空', () => {
    const home = mkdtempSync(join(tmpdir(), 'ferret-home-'))
    try {
      expect(listSshHosts(home)).toEqual([])
      mkdirSync(join(home, '.ssh'))
      writeFileSync(join(home, '.ssh', 'config'), 'Host dev-box\n  HostName 10.0.0.2\n')
      expect(listSshHosts(home)).toEqual([{ host: 'dev-box', hostname: '10.0.0.2' }])
      expect(defaultCloneParent(home)).toBe(join(home, 'Projects'))
      mkdirSync(join(home, 'src'))
      expect(defaultCloneParent(home)).toBe(join(home, 'src'))
      expect(readdirSync(home)).not.toContain('Projects')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
