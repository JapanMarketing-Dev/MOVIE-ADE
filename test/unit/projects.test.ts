import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_PREFERENCES, type ProjectUrl, type Settings } from '@shared/types'
import { defaultUrlLabel, isLocalDevUrl, matchPresetUrl, presetTarget } from '@shared/projectUrl'

// settings.ts は保存先を決めるためだけに electron の app を読む。単体テストでは呼ばれない
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-unit' } }))

const { sanitize } = await import('../../src/main/settings')
const { findProjectByFolder, migrateLegacySettings, upsertProjectFolder } = await import('../../src/main/projects')

const base = (patch: Partial<Settings> = {}): Settings => ({ ...sanitize({}), ...patch })

describe('設定の読み込み: プロジェクト', () => {
  it('壊れた要素・重複IDは捨て、URLはラベルが無ければURLで補う', () => {
    const s = sanitize({
      projects: [
        { id: 'a', name: 'App', folderPath: '/work/app', urls: [{ id: 'u1', label: 'local', url: 'http://localhost:3000' }, { id: 'u2', url: 'https://dev.example.com' }, { id: 'u3' }] },
        { id: 'a', name: '重複', folderPath: '/work/dup', urls: [] },
        { id: 'b', folderPath: '/work/site' },
        { name: 'IDなし', folderPath: '/work/x' },
        'こわれた値'
      ],
      activeProjectId: 'b'
    })
    expect(s.projects).toEqual([
      { id: 'a', name: 'App', folderPath: '/work/app', urls: [{ id: 'u1', label: 'local', url: 'http://localhost:3000' }, { id: 'u2', label: 'https://dev.example.com', url: 'https://dev.example.com' }] },
      { id: 'b', name: 'site', folderPath: '/work/site', urls: [] }
    ])
    expect(s.activeProjectId).toBe('b')
  })

  it('存在しないプロジェクトを指す activeProjectId は null に戻す', () => {
    expect(sanitize({ projects: [], activeProjectId: 'gone' }).activeProjectId).toBeNull()
    expect(sanitize({}).projects).toEqual([])
  })
})

describe('設定の読み込み: Agent', () => {
  it('未設定なら Orca と同じ既定値（YOLO 引数・Claude と Codex を起動）', () => {
    expect(sanitize({}).agents).toEqual(DEFAULT_AGENT_PREFERENCES)
    expect(DEFAULT_AGENT_PREFERENCES.launch.claude.args).toBe('--dangerously-skip-permissions')
    expect(DEFAULT_AGENT_PREFERENCES.launch.codex.args).toBe('--dangerously-bypass-approvals-and-sandbox')
  })

  it('空のコマンドは既定へ戻し、未知のAgentと重複は捨てる', () => {
    const s = sanitize({
      agents: {
        launch: { claude: { command: '  ', args: 'x' }, codex: { command: ' /opt/codex ', args: ' --foo ' } },
        startupAgents: ['codex', 'no-such-agent', 'codex']
      }
    })
    expect(s.agents.launch.claude).toEqual(DEFAULT_AGENT_PREFERENCES.launch.claude)
    expect(s.agents.launch.codex).toEqual({ command: '/opt/codex', args: '--foo' })
    expect(s.agents.startupAgents).toEqual(['codex'])
  })

  it('起動するAgentを全部外した状態（空配列）はそのまま残す', () => {
    expect(sanitize({ agents: { startupAgents: [] } }).agents.startupAgents).toEqual([])
  })
})

describe('旧設定からの移行', () => {
  it('folderPath だけを覚えていた設定は、そのフォルダを最初のプロジェクトにして開く', () => {
    const migrated = migrateLegacySettings(base({ folderPath: '/work/legacy-app' }), 'p1')
    expect(migrated.projects).toEqual([{ id: 'p1', name: 'legacy-app', folderPath: '/work/legacy-app', urls: [] }])
    expect(migrated.activeProjectId).toBe('p1')
  })

  it('既にプロジェクトがある・フォルダが無いときは何もしない', () => {
    const withProjects = base({ folderPath: '/work/other', projects: [{ id: 'a', name: 'a', folderPath: '/work/a', urls: [] }], activeProjectId: 'a' })
    expect(migrateLegacySettings(withProjects)).toBe(withProjects)
    const empty = base()
    expect(migrateLegacySettings(empty)).toBe(empty)
  })
})

describe('プロジェクトの登録', () => {
  const projects = [{ id: 'a', name: 'app', folderPath: '/work/app', urls: [] }]

  it('同じフォルダ（末尾の / 違い）は既存を返し、一覧を変えない', () => {
    const result = upsertProjectFolder(projects, '/work/app/')
    expect(result.alreadyPresent).toBe(true)
    expect(result.project.id).toBe('a')
    expect(result.projects).toBe(projects)
    expect(findProjectByFolder(projects, '/work/app/../app')?.id).toBe('a')
  })

  it('新しいフォルダは末尾に足す。名前はフォルダ名', () => {
    const result = upsertProjectFolder(projects, '/work/site', 'b')
    expect(result.alreadyPresent).toBe(false)
    expect(result.projects.map((p) => p.id)).toEqual(['a', 'b'])
    expect(result.project).toEqual({ id: 'b', name: 'site', folderPath: '/work/site', urls: [] })
  })
})

describe('URLプリセット', () => {
  const urls: ProjectUrl[] = [
    { id: 'l', label: 'local', url: 'http://localhost:3000' },
    { id: 'd', label: 'dev', url: 'https://dev.example.com' },
    { id: 'p', label: 'prd', url: 'https://example.com/app' }
  ]

  it('既定のラベル: localhost 系は local、ホスト名から dev / stg、それ以外は prd', () => {
    expect(defaultUrlLabel('http://localhost:5173/')).toBe('local')
    expect(defaultUrlLabel('http://127.0.0.1:8080')).toBe('local')
    expect(defaultUrlLabel('http://app.localhost:3000')).toBe('local')
    expect(defaultUrlLabel('https://dev.example.com')).toBe('dev')
    expect(defaultUrlLabel('https://api-dev.example.com')).toBe('dev')
    expect(defaultUrlLabel('https://staging.example.com')).toBe('stg')
    expect(defaultUrlLabel('https://example.com')).toBe('prd')
    expect(defaultUrlLabel('about:blank')).toBe('')
    expect(isLocalDevUrl('http://[::1]:3000')).toBe(true)
    expect(isLocalDevUrl('https://example.com')).toBe(false)
  })

  it('表示中のURLに当たるチップ: 同じオリジンでパスの下にあるもの', () => {
    expect(matchPresetUrl(urls, 'http://localhost:3000/dashboard?x=1')?.id).toBe('l')
    expect(matchPresetUrl(urls, 'https://example.com/app/settings')?.id).toBe('p')
    expect(matchPresetUrl(urls, 'https://example.com/other')).toBeNull()
    expect(matchPresetUrl(urls, 'http://localhost:4000')).toBeNull()
    expect(matchPresetUrl(urls, 'about:blank')).toBeNull()
  })

  it('別の環境のチップを押すと、同じパスのまま切り替える', () => {
    const [local, dev, prd] = urls as [ProjectUrl, ProjectUrl, ProjectUrl]
    expect(presetTarget(urls, 'http://localhost:3000/users/1?tab=a#top', dev)).toBe('https://dev.example.com/users/1?tab=a#top')
    expect(presetTarget(urls, 'https://dev.example.com/users', prd)).toBe('https://example.com/app/users')
    expect(presetTarget(urls, 'https://example.com/app/users', local)).toBe('http://localhost:3000/users')
    // 自分自身・どれにも当たらないときは登録したURLそのもの
    expect(presetTarget(urls, 'http://localhost:3000/users', local)).toBe('http://localhost:3000')
    expect(presetTarget(urls, 'https://google.com', dev)).toBe('https://dev.example.com')
  })
})
