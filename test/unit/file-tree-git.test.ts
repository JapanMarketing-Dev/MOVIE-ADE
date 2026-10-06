import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  EMPTY_GIT_DECORATIONS, buildGitDecorations, gitStateFor, isGitIgnored, isHiddenByDefault, isSecretEnvName, parseGitStatusZ, stateFromXY, withoutHidden,
  type FsGitStatus
} from '@shared/gitDecorations'
import { fileIconFor, folderIconFor } from '../../src/renderer/lib/fileIcons'

const z = (...records: string[]) => records.map((r) => `${r}\0`).join('')

describe('stateFromXY（porcelain v1 の2文字）', () => {
  it('VS Code と同じ分け方', () => {
    expect(stateFromXY(' M')).toBe('modified')
    expect(stateFromXY('M ')).toBe('modified')
    expect(stateFromXY('MM')).toBe('modified')
    expect(stateFromXY(' T')).toBe('modified')
    expect(stateFromXY('A ')).toBe('added')
    expect(stateFromXY('AM')).toBe('added')
    expect(stateFromXY('AD')).toBe('deleted')
    expect(stateFromXY(' D')).toBe('deleted')
    expect(stateFromXY('D ')).toBe('deleted')
    expect(stateFromXY('R ')).toBe('renamed')
    expect(stateFromXY('C ')).toBe('renamed')
    expect(stateFromXY('??')).toBe('untracked')
    expect(stateFromXY('!!')).toBe('ignored')
    for (const xy of ['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']) expect(stateFromXY(xy)).toBe('conflicted')
    expect(stateFromXY('  ')).toBeNull()
  })
})

describe('parseGitStatusZ（-z の出力）', () => {
  it('状態とパスを組にし、フォルダの末尾の / を外す', () => {
    const out = z(' M src/a.ts', '?? new/', '!! node_modules/', '!! .env', 'A  b c.ts', ' D gone.md')
    expect(parseGitStatusZ(out)).toEqual([
      ['src/a.ts', 'modified'], ['new', 'untracked'], ['node_modules', 'ignored'], ['.env', 'ignored'], ['b c.ts', 'added'], ['gone.md', 'deleted']
    ])
  })

  it('名前の変更は元の名前の項目を飛ばす', () => {
    expect(parseGitStatusZ(z('R  to.ts', 'from.ts', ' M x.ts'))).toEqual([['to.ts', 'renamed'], ['x.ts', 'modified']])
  })

  it('リポジトリの下のフォルダがプロジェクトなら prefix を外し、外のものは捨てる', () => {
    const out = z(' M app/web/src/a.ts', ' M other/b.ts', '?? app/web/tmp/', '!! app/webby/c')
    expect(parseGitStatusZ(out, 'app/web/')).toEqual([['src/a.ts', 'modified'], ['tmp', 'untracked']])
    expect(parseGitStatusZ(out, 'app/web')).toEqual([['src/a.ts', 'modified'], ['tmp', 'untracked']])
  })

  it('途中で切れた最後の項目・壊れた項目・プロジェクトそのものは読まない', () => {
    expect(parseGitStatusZ(`${z(' M a.ts')} M b.t`)).toEqual([['a.ts', 'modified']])
    expect(parseGitStatusZ(z('xx', '?? ./', '!! '))).toEqual([])
    expect(parseGitStatusZ('')).toEqual([])
  })

  it('日本語・空白を含むパスはそのまま（core.quotePath=false と -z）', () => {
    expect(parseGitStatusZ(z('?? 資料/メモ 1.md'))).toEqual([['資料/メモ 1.md', 'untracked']])
  })
})

describe('buildGitDecorations・gitStateFor（親への伝播）', () => {
  const status: FsGitStatus = {
    isGit: true,
    truncated: false,
    entries: [
      ['src/ui/a.ts', 'modified'],
      ['src/ui/b.ts', 'untracked'],
      ['src/lib/c.ts', 'added'],
      ['docs/old.md', 'deleted'],
      ['scratch', 'untracked'],
      ['dist', 'ignored'],
      ['src/ui/gen.log', 'ignored'],
      ['x/y/z.ts', 'conflicted'],
      ['x/w.ts', 'modified']
    ]
  }
  const deco = buildGitDecorations(status)

  it('ファイルはそのものの状態', () => {
    expect(gitStateFor(deco, 'src/ui/a.ts', 'file')).toBe('modified')
    expect(gitStateFor(deco, 'src/lib/c.ts', 'file')).toBe('added')
    expect(gitStateFor(deco, 'README.md', 'file')).toBeNull()
  })

  it('フォルダには中で一番強い状態が伝わる（ignored は伝えない）', () => {
    expect(gitStateFor(deco, 'src/ui', 'directory')).toBe('modified')
    expect(gitStateFor(deco, 'src/lib', 'directory')).toBe('added')
    expect(gitStateFor(deco, 'src', 'directory')).toBe('modified')
    expect(gitStateFor(deco, 'docs', 'directory')).toBe('deleted')
    expect(gitStateFor(deco, 'x', 'directory')).toBe('conflicted')
    expect(gitStateFor(deco, 'x/y', 'directory')).toBe('conflicted')
    expect(gitStateFor(deco, 'assets', 'directory')).toBeNull()
  })

  it('追跡外のフォルダは、そのものも中のものも untracked', () => {
    expect(gitStateFor(deco, 'scratch', 'directory')).toBe('untracked')
    expect(gitStateFor(deco, 'scratch/notes/a.md', 'file')).toBe('untracked')
    expect(gitStateFor(deco, 'scratch/notes', 'directory')).toBe('untracked')
  })

  it('無視されたものは、上のフォルダが無視されていても ignored', () => {
    expect(gitStateFor(deco, 'dist', 'directory')).toBe('ignored')
    expect(gitStateFor(deco, 'dist/assets/app.js', 'file')).toBe('ignored')
    expect(gitStateFor(deco, 'src/ui/gen.log', 'file')).toBe('ignored')
    expect(isGitIgnored(deco, 'distribution/a.ts')).toBe(false)
    expect(gitStateFor(deco, 'src/ui', 'directory')).toBe('modified')
  })

  it('git のリポジトリでなければ何も付けない', () => {
    expect(buildGitDecorations(null)).toBe(EMPTY_GIT_DECORATIONS)
    expect(buildGitDecorations({ isGit: false, entries: [['a', 'modified']], truncated: false })).toBe(EMPTY_GIT_DECORATIONS)
    expect(gitStateFor(EMPTY_GIT_DECORATIONS, 'a', 'file')).toBeNull()
    expect(isGitIgnored(EMPTY_GIT_DECORATIONS, 'a')).toBe(false)
  })
})

describe('既定で隠すもの', () => {
  it('秘密を含みうる .env と雛形を分ける', () => {
    for (const name of ['.env', '.env.local', '.env.production', '.env.development.local', '.ENV']) expect(isSecretEnvName(name), name).toBe(true)
    for (const name of ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.defaults', 'env', '.envrc', 'a.env', '.environment']) expect(isSecretEnvName(name), name).toBe(false)
  })

  it('.git・.DS_Store は常に、.env は .gitignore の対象のときだけ隠す（git で管理しているものは出す）', () => {
    const deco = buildGitDecorations({ isGit: true, truncated: false, entries: [['.env', 'ignored'], ['.env.local', 'ignored'], ['secrets', 'ignored']] })
    const hidden = (path: string) => isHiddenByDefault({ name: path.slice(path.lastIndexOf('/') + 1), path }, deco)
    expect(hidden('.git')).toBe(true)
    expect(hidden('.DS_Store')).toBe(true)
    expect(hidden('src/.DS_Store')).toBe(true)
    expect(hidden('.env')).toBe(true)
    expect(hidden('.env.local')).toBe(true)
    expect(hidden('secrets/.env.production')).toBe(true)
    // 追跡している .env.production・雛形・ふつうのファイルは出す
    expect(hidden('.env.production')).toBe(false)
    expect(hidden('.env.example')).toBe(false)
    expect(hidden('.gitignore')).toBe(false)
    expect(hidden('src/a.ts')).toBe(false)
  })

  it('git の状態がまだ分からない・リポジトリでないときは .env を念のため隠す', () => {
    expect(isHiddenByDefault({ name: '.env', path: '.env' }, null)).toBe(true)
    expect(isHiddenByDefault({ name: '.env', path: '.env' }, EMPTY_GIT_DECORATIONS)).toBe(true)
    expect(isHiddenByDefault({ name: '.env.example', path: '.env.example' }, null)).toBe(false)
  })

  it('withoutHidden は隠したフォルダの中の行も外す', () => {
    const rows = ['.git', '.git/HEAD', '.git/refs', '.github', '.github/ci.yml', 'src', 'src/.DS_Store', 'src/a.ts'].map((path) => ({ entry: { name: path.slice(path.lastIndexOf('/') + 1), path } }))
    const shown = withoutHidden(rows, (e) => e.name === '.git' || e.name === '.DS_Store').map((r) => r.entry.path)
    expect(shown).toEqual(['.github', '.github/ci.yml', 'src', 'src/a.ts'])
  })
})

describe('fileIconFor・folderIconFor（名前 → アイコンと色）', () => {
  it('決まったフォルダ名', () => {
    expect(folderIconFor('docs', false)).toEqual({ icon: 'BookOpen', tone: 'sky' })
    expect(folderIconFor('src', true).icon).toBe('FolderCode')
    expect(folderIconFor('infra', false).icon).toBe('Server')
    for (const name of ['test', 'tests', 'e2e', '__tests__']) expect(folderIconFor(name, false).icon, name).toBe('FlaskConical')
    expect(folderIconFor('scripts', false).icon).toBe('Terminal')
    for (const name of ['assets', 'images']) expect(folderIconFor(name, false).icon, name).toBe('Images')
    expect(folderIconFor('public', false).icon).toBe('Globe')
    expect(folderIconFor('components', false).icon).toBe('Component')
    expect(folderIconFor('.github', false).icon).toBe('FolderGit2')
    expect(folderIconFor('.vscode', false).icon).toBe('FolderCog')
    expect(folderIconFor('.claude', false).icon).toBe('Bot')
    expect(folderIconFor('node_modules', false).icon).toBe('Package')
    for (const name of ['db', 'migrations']) expect(folderIconFor(name, false).icon, name).toBe('Database')
    expect(folderIconFor('web', false).icon).toBe('Globe')
    expect(folderIconFor('api', false).icon).toBe('Webhook')
    expect(folderIconFor('config', false).icon).toBe('FolderCog')
    for (const name of ['dist', 'build', 'out']) expect(folderIconFor(name, false).icon, name).toBe('FolderArchive')
    // 大文字小文字は問わない
    expect(folderIconFor('Docs', false).icon).toBe('BookOpen')
  })

  it('ほかのフォルダは開閉に合わせた色なしのフォルダ', () => {
    expect(folderIconFor('notes', false)).toEqual({ icon: 'Folder' })
    expect(folderIconFor('notes', true)).toEqual({ icon: 'FolderOpen' })
  })

  it('決まったファイル名', () => {
    expect(fileIconFor('package.json')).toEqual({ icon: 'Package', tone: 'green' })
    expect(fileIconFor('README.md').icon).toBe('BookOpen')
    expect(fileIconFor('readme').icon).toBe('BookOpen')
    expect(fileIconFor('CLAUDE.md').icon).toBe('Bot')
    expect(fileIconFor('AGENTS.md').icon).toBe('Bot')
    expect(fileIconFor('.gitignore').icon).toBe('GitBranch')
    for (const name of ['.env', '.env.local', '.env.example']) expect(fileIconFor(name).icon, name).toBe('KeyRound')
    for (const name of ['Dockerfile', 'Dockerfile.dev', 'docker-compose.yml', 'docker-compose.prod.yaml', 'compose.yaml', 'app.dockerfile']) expect(fileIconFor(name).icon, name).toBe('Container')
    for (const name of ['tsconfig.json', 'tsconfig.node.json']) expect(fileIconFor(name).icon, name).toBe('FileCog')
    for (const name of ['LICENSE', 'LICENSE.md', 'license.txt']) expect(fileIconFor(name).icon, name).toBe('Scale')
    for (const name of ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Cargo.lock', 'go.sum']) expect(fileIconFor(name).icon, name).toBe('Lock')
  })

  it('拡張子', () => {
    const cases: Array<[string, string]> = [
      ['a.ts', 'FileCode'], ['a.tsx', 'FileCode'], ['a.js', 'FileCode'], ['a.jsx', 'FileCode'], ['a.py', 'FileCode'], ['a.go', 'FileCode'], ['a.rs', 'FileCode'],
      ['a.json', 'FileJson'], ['a.yaml', 'FileCog'], ['a.yml', 'FileCog'], ['a.md', 'FileText'], ['a.html', 'FileCode'], ['a.css', 'Palette'],
      ['a.sql', 'Database'], ['a.sh', 'FileTerminal'], ['a.csv', 'FileSpreadsheet'], ['a.png', 'FileImage'], ['a.svg', 'FileImage'],
      ['a.mp4', 'FileVideo'], ['a.zip', 'FileArchive'], ['a.PNG', 'FileImage']
    ]
    for (const [name, icon] of cases) expect(fileIconFor(name).icon, name).toBe(icon)
    // ts と js は色で分ける
    expect(fileIconFor('a.ts').tone).not.toBe(fileIconFor('a.js').tone)
  })

  it('名前の形（テスト・型定義・設定）は拡張子より先', () => {
    expect(fileIconFor('a.test.ts').icon).toBe('FlaskConical')
    expect(fileIconFor('a.spec.tsx').icon).toBe('FlaskConical')
    expect(fileIconFor('test_a.py').icon).toBe('FlaskConical')
    expect(fileIconFor('a_test.go').icon).toBe('FlaskConical')
    expect(fileIconFor('env.d.ts').icon).toBe('Braces')
    expect(fileIconFor('vite.config.ts').icon).toBe('FileCog')
    expect(fileIconFor('.prettierrc').icon).toBe('FileCog')
  })

  it('分からないものは色なしのファイル', () => {
    for (const name of ['notes', 'a.unknownext', 'trailing.', '.hidden']) expect(fileIconFor(name), name).toEqual({ icon: 'FileText' })
  })
})

// 本物の git で、プロジェクトの外を返さない・リポジトリでなければ何も付けないことを確かめる
const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true } catch { return false } })()

describe.skipIf(!hasGit)('readGitDecorations（本物の git）', () => {
  let base = ''
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM }

  beforeAll(async () => {
    // 手元の git の設定（グローバルの gitignore など）を混ぜない
    base = await mkdtemp(join(tmpdir(), 'ferret-git-deco-'))
    // Windows の git は \\.\nul を設定ファイルとして読めないので、空のファイルを使う
    const emptyConfig = join(base, 'empty.gitconfig')
    await writeFile(emptyConfig, '')
    process.env.GIT_CONFIG_GLOBAL = emptyConfig
    process.env.GIT_CONFIG_NOSYSTEM = '1'
  })
  afterAll(async () => {
    if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = saved.global
    if (saved.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
    else process.env.GIT_CONFIG_NOSYSTEM = saved.nosystem
    await rm(base, { recursive: true, force: true })
  })

  const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=acme', '-c', 'user.email=dev@example.invalid', ...args], { cwd, stdio: 'ignore', env: { ...process.env } })

  it('変更・追跡外・無視・削除をプロジェクトからの相対パスで返す（下のフォルダがプロジェクトでも）', async () => {
    const { readGitDecorations } = await import('../../src/main/gitDecorations')
    const repo = join(base, 'repo')
    const project = join(repo, 'apps', 'web')
    await mkdir(join(project, 'src'), { recursive: true })
    await mkdir(join(repo, 'other'), { recursive: true })
    await writeFile(join(repo, '.gitignore'), '.env\ndist/\n')
    await writeFile(join(project, 'src', 'a.ts'), 'a\n')
    await writeFile(join(project, 'gone.md'), 'x\n')
    await writeFile(join(project, '.env.example'), 'KEY=\n')
    await writeFile(join(repo, 'other', 'b.ts'), 'b\n')
    run(repo, 'init', '-q')
    run(repo, 'add', '-A')
    run(repo, 'commit', '-q', '-m', 'init')
    await writeFile(join(project, 'src', 'a.ts'), 'changed\n')
    await writeFile(join(project, 'src', 'new.ts'), 'n\n')
    await rm(join(project, 'gone.md'))
    await writeFile(join(project, '.env'), 'KEY=1\n')
    await mkdir(join(project, 'dist'))
    await writeFile(join(project, 'dist', 'out.js'), 'o\n')
    await writeFile(join(repo, 'other', 'b.ts'), 'changed\n')

    const status = await readGitDecorations(project)
    expect(status.isGit).toBe(true)
    expect(status.truncated).toBe(false)
    expect(new Map(status.entries)).toEqual(new Map([
      ['src/a.ts', 'modified'], ['src/new.ts', 'untracked'], ['gone.md', 'deleted'], ['.env', 'ignored'], ['dist', 'ignored']
    ]))
    const deco = buildGitDecorations(status)
    expect(isHiddenByDefault({ name: '.env', path: '.env' }, deco)).toBe(true)
    expect(isHiddenByDefault({ name: '.env.example', path: '.env.example' }, deco)).toBe(false)
  })

  it('git のリポジトリでなければ isGit: false', async () => {
    const { readGitDecorations } = await import('../../src/main/gitDecorations')
    const plain = join(base, 'plain')
    await mkdir(plain)
    await writeFile(join(plain, '.env'), 'KEY=1\n')
    expect(await readGitDecorations(plain)).toEqual({ isGit: false, entries: [], truncated: false })
  })
})
