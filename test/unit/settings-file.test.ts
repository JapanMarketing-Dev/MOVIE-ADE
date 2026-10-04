import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-settings-file-unit' } }))

import { sanitize } from '../../src/main/settings'
import { SettingsFileStore, configDirOverride, mergeSettings, parseSettingsText, plaintextKeyPaths, relocateMisplacedDevConfig, resolveConfigDir, splitSettings, writeFileAtomicSync } from '../../src/main/settingsFile'
import { isPackagedBuild } from '../../src/main/runtimeKind'

/**
 * settings.json / state.json の読み書き（src/main/settingsFile.ts）。
 * 本物の ~/.ferret・~/.movie-ade・userData には触れず、すべて一時フォルダで確かめる。
 */

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ade-settings-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const legacySettings = {
  folderPath: '/work/app',
  url: 'http://localhost:3000/',
  splitRatio: 0.5,
  theme: 'dark',
  viewport: 'mobile',
  layout: { panels: { terminal: { dock: 'bottom', visible: true } } },
  projects: [{ id: 'p1', name: 'app', folderPath: '/work/app', urls: [{ id: 'u1', label: 'local', url: 'http://localhost:3000' }],
    session: { url: 'http://localhost:3000/login', openFiles: ['src/a.ts'] } }],
  activeProjectId: 'p1',
  agents: { customAgents: [{ id: 'custom:mine', name: 'Mine', command: 'mine', args: '--yolo' }], startupAgents: ['custom:mine'] },
  capture: { captureMic: true, captureSystemAudio: false, transcription: 'compatible', language: 'ja', keepDays: 30, stayFeedbackOnStop: false,
    sttEndpoints: { compatible: { baseUrl: 'http://gpu.local:8000/v1', model: 'whisper-large-v3' } } }
}

function newStore(dir: string, extra: Partial<ConstructorParameters<typeof SettingsFileStore>[0]> = {}): SettingsFileStore {
  return new SettingsFileStore({ dir, legacyFile: join(root, 'userData', 'settings.json'), sanitize, ...extra })
}

describe('resolveConfigDir', () => {
  it('配布版は ~/.ferret、dev 起動は ~/.ferret/dev', () => {
    expect(resolveConfigDir({ env: {}, home: '/home/u', isPackaged: true })).toBe(join('/home/u', '.ferret'))
    expect(resolveConfigDir({ env: {}, home: '/home/u', isPackaged: false })).toBe(join('/home/u', '.ferret', 'dev'))
  })

  it('FERRET_CONFIG_DIR が最優先（~ を展開する）', () => {
    expect(resolveConfigDir({ env: { FERRET_CONFIG_DIR: '/etc/ade' }, home: '/home/u', isPackaged: false, isolatedUserData: '/tmp/ud' })).toBe('/etc/ade')
    expect(resolveConfigDir({ env: { FERRET_CONFIG_DIR: '~/cfg' }, home: '/home/u', isPackaged: true })).toBe(join('/home/u', 'cfg'))
  })

  it('旧名の MOVIE_ADE_CONFIG_DIR も受け付け、両方あれば FERRET_CONFIG_DIR を使う', () => {
    expect(resolveConfigDir({ env: { MOVIE_ADE_CONFIG_DIR: '/etc/old' }, home: '/home/u', isPackaged: true })).toBe('/etc/old')
    expect(resolveConfigDir({ env: { MOVIE_ADE_CONFIG_DIR: '/etc/old', FERRET_CONFIG_DIR: '/etc/new' }, home: '/home/u', isPackaged: true })).toBe('/etc/new')
    // 空の新しい名前は指定なしとみなす
    expect(resolveConfigDir({ env: { MOVIE_ADE_CONFIG_DIR: '/etc/old', FERRET_CONFIG_DIR: ' ' }, home: '/home/u', isPackaged: true })).toBe('/etc/old')
    expect(configDirOverride({})).toBeUndefined()
  })

  it('E2E・--user-data-dir の起動は userData の下（本物の設定に触れない）', () => {
    expect(resolveConfigDir({ env: {}, home: '/home/u', isPackaged: true, isolatedUserData: '/tmp/ud' })).toBe(join('/tmp/ud', 'config'))
  })
})

describe('設定と状態の分割', () => {
  it('開いていたフォルダ・URL・タブは state.json、それ以外は settings.json', () => {
    const settings = sanitize(legacySettings)
    const { config, state } = splitSettings(settings)
    expect(config).not.toHaveProperty('folderPath')
    expect(config).not.toHaveProperty('url')
    expect(config).not.toHaveProperty('viewport')
    expect(config).not.toHaveProperty('activeProjectId')
    expect((config.projects as Array<Record<string, unknown>>)[0]).not.toHaveProperty('session')
    expect(config.theme).toBe('dark')
    expect(config.splitRatio).toBe(0.5)
    expect(state).toMatchObject({ folderPath: '/work/app', url: 'http://localhost:3000/', viewport: 'mobile', activeProjectId: 'p1',
      sessions: { p1: { url: 'http://localhost:3000/login', openFiles: ['src/a.ts'] } } })
    // 戻すと元と同じ
    expect(sanitize(mergeSettings(config, state))).toEqual(settings)
  })
})

describe('starPrompt（GitHub の star のお願い）', () => {
  it('state.json に置き、settings.json には出さない。読み直しても残る', () => {
    const dir = join(root, 'cfg')
    const store = newStore(dir)
    const { settings } = store.load()
    const starPrompt = { done: false, count: 1, lastShownAt: 1_700_000_000_000, sends: 3, reviews: 2 }
    store.saveSync({ ...settings, starPrompt })
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).not.toHaveProperty('starPrompt')
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).starPrompt).toEqual(starPrompt)
    expect(newStore(dir).load().settings.starPrompt).toEqual(starPrompt)
  })
})

describe('以前の置き場所からの移行', () => {
  it('userData/settings.json を移し、以前のファイルは消さずに残す', () => {
    mkdirSync(join(root, 'userData'))
    const legacyText = JSON.stringify(legacySettings)
    writeFileSync(join(root, 'userData', 'settings.json'), legacyText)
    const dir = join(root, 'cfg')
    const result = newStore(dir).load()
    expect(result.migrated).toBe(true)
    expect(result.settings.projects[0]).toMatchObject({ id: 'p1', folderPath: '/work/app', session: { url: 'http://localhost:3000/login' } })
    expect(result.settings.agents.customAgents[0]?.id).toBe('custom:mine')
    expect(result.settings.layout?.panels.terminal.dock).toBe('bottom')
    // 以前のファイルはそのまま
    expect(readFileSync(join(root, 'userData', 'settings.json'), 'utf8')).toBe(legacyText)
    // 新しいファイルとスキーマができる
    const written = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    expect(written.$schema).toBe('./settings.schema.json')
    expect(written.projects[0].urls[0].url).toBe('http://localhost:3000')
    expect(written).not.toHaveProperty('folderPath')
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).sessions.p1.openFiles).toEqual(['src/a.ts'])
    expect(existsSync(join(dir, 'settings.schema.json'))).toBe(true)
    // 2回目は移行しない（新しいファイルを読む）
    expect(newStore(dir).load().migrated).toBe(false)
  })

  it('settings.json を消して既定に戻したとき、古い設定を蘇らせない（state.json があれば移行済み）', () => {
    mkdirSync(join(root, 'userData'))
    writeFileSync(join(root, 'userData', 'settings.json'), JSON.stringify(legacySettings))
    const dir = join(root, 'cfg')
    newStore(dir).load()
    rmSync(join(dir, 'settings.json'))
    const again = newStore(dir).load()
    expect(again.migrated).toBe(false)
    expect(again.settings.theme).toBe('system')
  })
})

describe('保存', () => {
  it('一時ファイル＋rename で書き、一時ファイルを残さない', () => {
    const target = join(root, 'x.json')
    writeFileAtomicSync(target, '{"a":1}\n')
    writeFileAtomicSync(target, '{"a":2}\n')
    expect(readFileSync(target, 'utf8')).toBe('{"a":2}\n')
    expect(readdirSync(root)).toEqual(['x.json'])
  })

  it('知らない上の階層の項目と $schema を残す', () => {
    const dir = join(root, 'cfg')
    mkdirSync(dir)
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ $schema: 'https://example.com/s.json', theme: 'light', myTeamNote: { owner: 'me' }, futureFlag: true }))
    const store = newStore(dir)
    const { settings } = store.load()
    store.saveSync({ ...settings, theme: 'dark' })
    const written = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    expect(written.theme).toBe('dark')
    expect(written.myTeamNote).toEqual({ owner: 'me' })
    expect(written.futureFlag).toBe(true)
    expect(written.$schema).toBe('https://example.com/s.json')
  })
})

describe('書き込みに失敗したとき（Orca #18271）', () => {
  it('同じ内容でも次の保存で書き直す（「書いた」扱いのまま残さない）', () => {
    const dir = join(root, 'cfg-fail')
    mkdirSync(dir)
    const store = newStore(dir)
    const { settings } = store.load()
    // settings.json の場所を中身のあるフォルダでふさぎ、rename を失敗させる
    rmSync(join(dir, 'settings.json'), { force: true })
    mkdirSync(join(dir, 'settings.json', 'blocker'), { recursive: true })
    expect(() => store.saveSync({ ...settings, theme: 'dark' })).toThrow()
    rmSync(join(dir, 'settings.json'), { recursive: true, force: true })
    store.saveSync({ ...settings, theme: 'dark' })
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).theme).toBe('dark')
  })
})

describe('外部の変更の取り込み', () => {
  it('自分の書き込みは取り込み直さない', () => {
    const dir = join(root, 'cfg')
    const onExternalChange = vi.fn()
    const store = newStore(dir, { onExternalChange })
    const { settings } = store.load()
    store.saveSync({ ...settings, theme: 'dark' })
    expect(store.checkNow()).toBe('unchanged')
    expect(onExternalChange).not.toHaveBeenCalled()
  })

  it('外部で書き換えられたら取り込む', () => {
    const dir = join(root, 'cfg')
    const onExternalChange = vi.fn()
    const store = newStore(dir, { onExternalChange })
    store.load()
    const current = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ ...current, theme: 'light' }, null, 2))
    expect(store.checkNow()).toBe('applied')
    expect(onExternalChange).toHaveBeenCalledWith(expect.objectContaining({ theme: 'light' }))
  })

  it('壊れた JSON は取り込まず、行を知らせ、直るまで利用者のファイルを上書きしない', () => {
    const dir = join(root, 'cfg')
    const onExternalChange = vi.fn()
    const onErrorChange = vi.fn()
    const store = newStore(dir, { onExternalChange, onErrorChange })
    const { settings } = store.load()
    const broken = '{\n  "theme": "dark",\n  "locale": \n}\n'
    writeFileSync(join(dir, 'settings.json'), broken)
    expect(store.checkNow()).toBe('invalid')
    expect(onExternalChange).not.toHaveBeenCalled()
    expect(onErrorChange).toHaveBeenCalledWith(expect.objectContaining({ kind: 'parse', line: 4 }))
    expect(store.error?.kind).toBe('parse')
    // アプリの保存が来ても settings.json はそのまま（state.json だけ書く）
    store.saveSync({ ...settings, url: 'http://example.com/' })
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(broken)
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).url).toBe('http://example.com/')
    // 直したら取り込み、エラーを消す
    writeFileSync(join(dir, 'settings.json'), '{ "theme": "dark" }')
    expect(store.checkNow()).toBe('applied')
    expect(onErrorChange).toHaveBeenLastCalledWith(null)
    expect(onExternalChange).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }))
  })

  it('スキーマの違反（型の違い）も取り込まず、場所と行を知らせる', () => {
    const dir = join(root, 'cfg')
    const store = newStore(dir, { onExternalChange: vi.fn() })
    store.load()
    writeFileSync(join(dir, 'settings.json'), '{\n  "theme": "dark",\n  "capture": {\n    "keepDays": "seven"\n  }\n}\n')
    expect(store.checkNow()).toBe('invalid')
    expect(store.error).toMatchObject({ kind: 'schema', path: '/capture/keepDays', line: 4 })
  })

  it('起動時に壊れていても続け、ファイルは上書きしない', () => {
    const dir = join(root, 'cfg')
    mkdirSync(dir)
    writeFileSync(join(dir, 'settings.json'), '{ "theme": ')
    const store = newStore(dir)
    const result = store.load()
    expect(result.error?.kind).toBe('parse')
    store.saveSync(result.settings)
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe('{ "theme": ')
  })

  it('fs.watch で外部の変更に気づく（debounce 付き）', async () => {
    const dir = join(root, 'cfg')
    const onExternalChange = vi.fn()
    const store = newStore(dir, { onExternalChange, debounceMs: 20 })
    const { settings } = store.load()
    store.watch()
    try {
      // 自分の保存では呼ばれない
      store.saveSync({ ...settings, theme: 'dark' })
      await new Promise((r) => setTimeout(r, 150))
      expect(onExternalChange).not.toHaveBeenCalled()
      const current = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ ...current, theme: 'light' }))
      await vi.waitFor(() => expect(onExternalChange).toHaveBeenCalledWith(expect.objectContaining({ theme: 'light' })), { timeout: 2000 })
    } finally {
      store.close()
    }
  })
})

describe('parseSettingsText / plaintextKeyPaths', () => {
  it('上の階層が配列なら誤り', () => {
    expect(parseSettingsText('[]')).toMatchObject({ ok: false, error: { kind: 'schema' } })
  })

  it('平文の apiKey の場所を返す（値は返さない）', () => {
    expect(plaintextKeyPaths({ capture: { sttEndpoints: { openai: { apiKey: 'sk-secret', model: 'x' } } }, decision: { apiKeyEnv: 'X' } }))
      .toEqual(['/capture/sttEndpoints/openai/apiKey'])
  })
})

describe('sanitize（settings.json に足した項目）', () => {
  it('apiKey / apiKeyEnv・CLI のモデル・フィードバックの右パネルを保つ', () => {
    const s = sanitize({
      capture: { captureMic: true, captureSystemAudio: false, transcription: 'openai', language: 'auto', keepDays: 7, stayFeedbackOnStop: false,
        sttEndpoints: { openai: { apiKeyEnv: 'OPENAI_API_KEY' }, compatible: { baseUrl: 'http://localhost:8000/v1', apiKey: 'tok-123' } } },
      organizer: { runner: 'api:compatible', cliModels: { codex: 'gpt-5-codex', 'claude-code': 'opus' }, endpoints: { compatible: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3', apiKeyEnv: 'bad name' } } },
      feedbackTargets: { visible: false, ratio: 0.6 }
    })
    expect(s.capture?.sttEndpoints?.openai).toEqual({ apiKeyEnv: 'OPENAI_API_KEY' })
    expect(s.capture?.sttEndpoints?.compatible).toEqual({ baseUrl: 'http://localhost:8000/v1', apiKey: 'tok-123' })
    expect(s.organizer?.cliModels).toEqual({ codex: 'gpt-5-codex', 'claude-code': 'opus' })
    // 環境変数として使えない名前は捨てる
    expect(s.organizer?.endpoints?.compatible).toEqual({ baseUrl: 'http://localhost:11434/v1', model: 'qwen3' })
    expect(s.feedbackTargets).toEqual({ visible: false, ratio: 0.6 })
  })
})

describe('開発版の判定（pnpm dev の実際の起動条件）', () => {
  it('名前を変えた開発版の Ferret.app は app.isPackaged が true でも、electron . の起動なら開発版', () => {
    // electron-vite dev: 実行ファイル名が「Ferret」なので isPackaged は true、defaultApp と ELECTRON_RENDERER_URL が立つ
    expect(isPackagedBuild({ isPackaged: true, defaultApp: true, rendererUrl: 'http://localhost:5173' })).toBe(false)
    expect(isPackagedBuild({ isPackaged: true, defaultApp: true })).toBe(false)
    expect(isPackagedBuild({ isPackaged: true, rendererUrl: 'http://localhost:5173' })).toBe(false)
    // 配布版
    expect(isPackagedBuild({ isPackaged: true })).toBe(true)
    // node_modules の Electron のまま
    expect(isPackagedBuild({ isPackaged: false, defaultApp: true })).toBe(false)
    const dev = isPackagedBuild({ isPackaged: true, defaultApp: true, rendererUrl: 'http://localhost:5173' })
    expect(resolveConfigDir({ env: {}, home: '/home/u', isPackaged: dev })).toBe(join('/home/u', '.ferret', 'dev'))
  })

  it('state.json に書いた版の印を残す', () => {
    const dir = join(root, 'cfg')
    const store = newStore(dir, { writtenBy: 'dev' })
    store.load()
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).writtenBy).toBe('dev')
  })
})

describe('直下に書かれた開発版の設定を dev/ へ移す（1度だけ）', () => {
  const seed = (dir: string, state: Record<string, unknown>) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), '{"theme":"dark"}')
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, ...state }))
    writeFileSync(join(dir, 'settings.schema.json'), '{}')
  }

  it('印の無い直下の設定を dev/ へ移し、写しを残す', () => {
    const top = join(root, '.movie-ade')
    seed(top, {})
    const moved = relocateMisplacedDevConfig({ root: top, devDir: join(top, 'dev'), now: new Date('2026-10-03T12:00:00Z') })
    expect(moved).toBe(join(top, 'dev'))
    expect(readFileSync(join(top, 'dev', 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
    expect(existsSync(join(top, 'dev', 'state.json'))).toBe(true)
    expect(existsSync(join(top, 'settings.json'))).toBe(false)
    expect(existsSync(join(top, 'state.json'))).toBe(false)
    const backup = join(top, 'backup-dev-relocate-2026-10-03T12-00-00-000Z')
    expect(readFileSync(join(backup, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
    // 移した後の dev 起動はそのまま読める
    expect(newStore(join(top, 'dev')).load().settings.theme).toBe('dark')
  })

  it('配布版が書いたもの・dev/ が既にあるときは触れない', () => {
    const packaged = join(root, 'p')
    seed(packaged, { writtenBy: 'packaged' })
    expect(relocateMisplacedDevConfig({ root: packaged, devDir: join(packaged, 'dev') })).toBeNull()
    expect(existsSync(join(packaged, 'settings.json'))).toBe(true)
    const already = join(root, 'a')
    seed(already, {})
    mkdirSync(join(already, 'dev'))
    expect(relocateMisplacedDevConfig({ root: already, devDir: join(already, 'dev') })).toBeNull()
    expect(existsSync(join(already, 'settings.json'))).toBe(true)
  })
})
