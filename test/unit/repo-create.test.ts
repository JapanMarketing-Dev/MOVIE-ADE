import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildRepoCreateArgs, isSecretLikePath, isValidOwner, isValidRepoName, sanitizeDescription, sanitizeGithubPreferences, splitInitialCommitFiles, suggestRepoName
} from '@shared/repoCreate'

// ログインシェルを起こさない（git は main の PATH から探す）
vi.mock('../../src/main/agentDetection', () => ({
  searchDirs: async () => (process.env.PATH ?? '').split(delimiter).filter(Boolean)
}))

/** 本物の gh は呼ばない。呼ばれた引数を控え、決めた答えを返す */
const ghCalls: string[][] = []
let ghAnswer: (args: string[]) => { stdout?: string; stderr?: string; failed?: boolean; missing?: boolean } = () => ({})
vi.mock('../../src/main/github/gh', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/github/gh')>()
  return {
    ...real,
    gh: async (args: string[]) => {
      ghCalls.push(args)
      const answer = ghAnswer(args)
      return { stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', failed: answer.failed ?? false, missing: answer.missing ?? false, timedOut: false }
    }
  }
})

const { createPrivateRepo, repoCreateInfo } = await import('../../src/main/github/createRepo')

describe('名前・置き場・説明', () => {
  it('フォルダ名から GitHub で使えるリポジトリ名を作る', () => {
    expect(suggestRepoName('acme-shop')).toBe('acme-shop')
    expect(suggestRepoName('My Shop  v2')).toBe('My-Shop-v2')
    expect(suggestRepoName('入札システム')).toBe('project')
    expect(suggestRepoName('AIネイティブな入札')).toBe('AI')
    expect(suggestRepoName('.hidden.')).toBe('hidden')
    expect(suggestRepoName('tool.git')).toBe('tool')
    expect(suggestRepoName('a'.repeat(150))).toHaveLength(100)
  })

  it('リポジトリ名と置き場の形を確かめる', () => {
    for (const name of ['acme', 'a.b_c-d', 'A1']) expect(isValidRepoName(name), name).toBe(true)
    for (const name of ['', '.', '..', 'a b', 'a/b', 'x.git', 'a'.repeat(101)]) expect(isValidRepoName(name), name).toBe(false)
    for (const owner of ['alice', 'acme-inc', 'a1']) expect(isValidOwner(owner), owner).toBe(true)
    for (const owner of ['', '-a', 'a-', 'a--b', 'a_b', 'a'.repeat(40), 'a/b']) expect(isValidOwner(owner), owner).toBe(false)
    expect(sanitizeGithubPreferences({ defaultOwner: 'acme-inc' })).toEqual({ defaultOwner: 'acme-inc' })
    expect(sanitizeGithubPreferences({ defaultOwner: 'bad owner' })).toBeUndefined()
    expect(sanitizeDescription('line1\nline2\t x')).toBe('line1 line2 x')
  })

  it('gh の引数は必ず --private。push はコミットがあるときだけ。値は配列で渡す', () => {
    expect(buildRepoCreateArgs({ owner: 'acme', name: 'shop', description: 'Shop; rm -rf /' }, '/w/shop', true)).toEqual([
      'repo', 'create', 'acme/shop', '--private', '--source', '/w/shop', '--remote', 'origin', '--description', 'Shop; rm -rf /', '--push'
    ])
    expect(buildRepoCreateArgs({ owner: 'acme', name: 'shop' }, '/w/shop', false)).not.toContain('--push')
    expect(buildRepoCreateArgs({ owner: 'acme', name: 'shop' }, '/w/shop', false)).not.toContain('--public')
    expect(() => buildRepoCreateArgs({ owner: 'a b', name: 'shop' }, '/w', false)).toThrow()
    expect(() => buildRepoCreateArgs({ owner: 'acme', name: '../x' }, '/w', false)).toThrow()
  })
})

describe('最初のコミットから外す秘密らしいファイル', () => {
  it('.env・鍵・認証情報の形は外し、雛形とふつうのファイルは入れる', () => {
    for (const path of ['.env', '.env.local', 'apps/web/.env.production', 'certs/server.pem', 'deploy/id_ed25519', '.npmrc', 'credentials.json',
      'gcp/service-account-prod.json', 'secrets.yaml', 'infra/terraform.tfstate', 'keys/app.p12']) expect(isSecretLikePath(path), path).toBe(true)
    for (const path of ['.env.example', '.env.sample', 'src/env.ts', 'README.md', 'package.json', 'keyboard.ts', 'docs/secrets.md']) expect(isSecretLikePath(path), path).toBe(false)
    expect(splitInitialCommitFiles(['a.ts', '.env', 'b/.env.example'])).toEqual({ included: ['a.ts', 'b/.env.example'], excluded: ['.env'] })
  })
})

describe('本物の git で作る（gh は偽物。GitHub には何も作らない）', { timeout: 60_000 }, () => {
  let root = ''
  const saved: Record<string, string | undefined> = {}
  const ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']
  let seq = 0
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ferret-repo-create-'))
    for (const key of ENV_KEYS) saved[key] = process.env[key]
    writeFileSync(join(root, 'gitconfig'), '[init]\n\tdefaultBranch = main\n')
    process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Taro'
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'taro@example.test'
  })

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  beforeEach(() => {
    ghCalls.length = 0
    ghAnswer = (args) => {
      if (args[0] === 'api' && args[1] === 'user') return { stdout: 'alice\n' }
      if (args[0] === 'api' && args[1] === 'user/orgs') return { stdout: 'acme-inc\n' }
      return {}
    }
  })

  /** git でない acme-shop のフォルダ（.gitignore で dist を外し、.env と雛形を置く） */
  const project = (): string => {
    const dir = join(root, `acme-shop-${++seq}`)
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(join(dir, '.gitignore'), 'dist/\n')
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1\n')
    writeFileSync(join(dir, 'dist', 'out.js'), 'x\n')
    writeFileSync(join(dir, '.env'), 'APP_MODE=local\n')
    writeFileSync(join(dir, '.env.example'), 'APP_MODE=\n')
    return dir
  }

  it('下調べは何も変えない。置き場の候補と、最初のコミットに入る数・外す秘密を返す', async () => {
    const dir = project()
    const info = await repoCreateInfo(dir, 'acme-inc')
    expect(info).toMatchObject({ ready: true, login: 'alice', orgs: ['acme-inc'], defaultOwner: 'acme-inc', isGit: false, hasCommits: false, hasOrigin: false })
    // .gitignore・src/index.ts・.env.example の3つ。dist は .gitignore の対象、.env は秘密として外す
    expect(info.initialFiles).toBe(3)
    expect(info.excludedSecrets).toEqual(['.env'])
    expect(() => git(dir, 'rev-parse', '--git-dir')).toThrow()
    // 候補に無い既定の置き場は、自分のアカウントにする
    expect((await repoCreateInfo(dir, 'someone-else')).defaultOwner).toBe('alice')
  })

  it('git init して、秘密を外した最初のコミットを作り、--private で作って push する', async () => {
    const dir = project()
    const result = await createPrivateRepo(dir, { owner: 'acme-inc', name: 'acme-shop', description: 'Shop', initialCommit: true })
    expect(result).toEqual({ url: 'https://github.com/acme-inc/acme-shop', pushed: true, excluded: 1 })
    expect(git(dir, 'branch', '--show-current')).toBe('main')
    expect(git(dir, 'ls-files').split('\n').sort()).toEqual(['.env.example', '.gitignore', 'src/index.ts'])
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain('/.env\n')
    // .env はそのまま残る（消さない）
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('APP_MODE=local\n')
    const create = ghCalls.find((args) => args[0] === 'repo')
    expect(create).toEqual(['repo', 'create', 'acme-inc/acme-shop', '--private', '--source', dir, '--remote', 'origin', '--description', 'Shop', '--push'])
  })

  it('先に stage してあった .env も最初のコミットから外す', async () => {
    const dir = project()
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, 'add', '-A', '-f')
    await createPrivateRepo(dir, { owner: 'alice', name: 'shop', initialCommit: true })
    expect(git(dir, 'ls-files')).not.toMatch(/^\.env$/m)
  })

  it('最初のコミットを作らない選択なら push しない', async () => {
    const dir = project()
    const result = await createPrivateRepo(dir, { owner: 'alice', name: 'shop', initialCommit: false })
    expect(result.pushed).toBe(false)
    expect(ghCalls.find((args) => args[0] === 'repo')).not.toContain('--push')
  })

  it('origin がある・名前が使われている・ログインしていないときは断る', async () => {
    const withOrigin = project()
    git(withOrigin, 'init', '-q', '-b', 'main')
    git(withOrigin, 'remote', 'add', 'origin', 'https://example.test/x.git')
    await expect(createPrivateRepo(withOrigin, { owner: 'alice', name: 'shop', initialCommit: true })).rejects.toThrow()
    expect(ghCalls.some((args) => args[0] === 'repo')).toBe(false)

    ghAnswer = (args) => (args[0] === 'repo' ? { failed: true, stderr: 'GraphQL: Name already exists on this account (createRepository)' } : {})
    await expect(createPrivateRepo(project(), { owner: 'alice', name: 'shop', initialCommit: true })).rejects.toThrow(/同じ名前|already exists/)

    ghAnswer = (args) => (args[0] === 'auth' ? { failed: true, stderr: 'You are not logged into any GitHub hosts. Run gh auth login' } : {})
    const info = await repoCreateInfo(project(), undefined)
    expect(info.ready).toBe(false)
  })

  it('不正な名前・置き場は gh を呼ぶ前に断る', async () => {
    await expect(createPrivateRepo(project(), { owner: 'alice', name: 'a b', initialCommit: true })).rejects.toThrow()
    await expect(createPrivateRepo(project(), { owner: '-x', name: 'shop', initialCommit: true })).rejects.toThrow()
    expect(ghCalls).toEqual([])
  })
})
