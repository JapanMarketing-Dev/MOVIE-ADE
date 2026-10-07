import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chromiumMsToUnixMs,
  loginOrigin,
  mergeHistory,
  originMatches,
  parseCsv,
  parsePasswordCsv,
  safariSecondsToUnixMs,
  sanitizeHistory,
  suggestHistory,
  toHistoryEntry
} from '@shared/browserImport'
import { SavedLoginStore, buildFillScript, mergeLogins, sanitizeStoredLogins } from '../../src/main/browserImport/passwords'
import { ImportedHistoryStore, detectHistorySources, readHistorySource } from '../../src/main/browserImport/history'
import type { KeyCipher } from '../../src/main/pipeline/stt/keys'

// テストの値はすべて偽物（本物のブラウザのデータは読まない）
const FAKE_PASSWORD = 'correct-horse-battery'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ferret-browser-import-test-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('CSV の読み取り', () => {
  it('"" で囲んだ , ・改行・"" と CRLF・BOM を扱い、空の行は除く', () => {
    expect(parseCsv('\ufeffa,b\r\n"x,1","line\nnext"\r\n\r\n"say ""hi""",\n')).toEqual([
      ['a', 'b'],
      ['x,1', 'line\nnext'],
      ['say "hi"', '']
    ])
  })
})

describe('パスワードの CSV', () => {
  it('Chrome / Edge の見出し（name,url,username,password,note）', () => {
    const csv = `name,url,username,password,note\nexample.com,https://example.com/login,alice,${FAKE_PASSWORD},\n`
    expect(parsePasswordCsv(csv)).toEqual({ logins: [{ origin: 'https://example.com', username: 'alice', password: FAKE_PASSWORD }], skipped: 0 })
  })

  it('Safari の見出し（Title,URL,Username,Password,Notes,OTPAuth）', () => {
    const csv = `Title,URL,Username,Password,Notes,OTPAuth\nExample,https://www.example.com:8443/a,bob,${FAKE_PASSWORD},memo,\n`
    expect(parsePasswordCsv(csv)?.logins).toEqual([{ origin: 'https://www.example.com:8443', username: 'bob', password: FAKE_PASSWORD }])
  })

  it('Firefox の見出し（"url","username","password","httpRealm",…）', () => {
    const csv = `"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\n"http://localhost:3000","dev","${FAKE_PASSWORD}",,"http://localhost:3000","{1}","1","1","1"\n`
    expect(parsePasswordCsv(csv)?.logins).toEqual([{ origin: 'http://localhost:3000', username: 'dev', password: FAKE_PASSWORD }])
  })

  it('http / https でない行・パスワードが空の行は飛ばし、同じオリジン＋ユーザー名は後の行で上書きする', () => {
    const csv = [
      'name,url,username,password',
      `app,android://abc@com.example.app/,carol,${FAKE_PASSWORD}`,
      'empty,https://example.com,dave,',
      'old,https://example.com,erin,first-value',
      'new,https://example.com/other,erin,second-value'
    ].join('\n')
    expect(parsePasswordCsv(csv)).toEqual({ logins: [{ origin: 'https://example.com', username: 'erin', password: 'second-value' }], skipped: 2 })
  })

  it('URL とパスワードの列が無ければパスワードの CSV ではない（null）', () => {
    expect(parsePasswordCsv('name,email\nfoo,bar@example.com')).toBeNull()
    expect(parsePasswordCsv('')).toBeNull()
  })
})

describe('オリジンの照合', () => {
  it('ページの URL からオリジンを作る（http / https だけ、スキームが無ければ https）', () => {
    expect(loginOrigin('https://example.com/a?b#c')).toBe('https://example.com')
    expect(loginOrigin('example.com')).toBe('https://example.com')
    expect(loginOrigin('http://localhost:3000/x')).toBe('http://localhost:3000')
    expect(loginOrigin('https://example.com:443/')).toBe('https://example.com')
    expect(loginOrigin('file:///etc/passwd')).toBeNull()
    expect(loginOrigin('javascript:alert(1)')).toBeNull()
    expect(loginOrigin('')).toBeNull()
  })

  it('スキーム・ホスト・ポートの完全一致と、www の有無だけの違いを通す', () => {
    expect(originMatches('https://example.com', 'https://example.com/login')).toBe(true)
    expect(originMatches('https://example.com', 'https://www.example.com/login')).toBe(true)
    expect(originMatches('https://www.example.com', 'https://example.com/')).toBe(true)
    expect(originMatches('http://localhost:3000', 'http://localhost:3000/signin')).toBe(true)
  })

  it('サブドメイン・スキーム・ポートが違えば通さない', () => {
    expect(originMatches('https://example.com', 'https://login.example.com/')).toBe(false)
    expect(originMatches('https://login.example.com', 'https://example.com/')).toBe(false)
    expect(originMatches('https://example.com', 'https://example.com.evil.test/')).toBe(false)
    expect(originMatches('https://example.com', 'http://example.com/')).toBe(false)
    expect(originMatches('http://localhost:3000', 'http://localhost:3001/')).toBe(false)
    expect(originMatches('https://example.com', 'about:blank')).toBe(false)
    expect(originMatches('https://example.com', 'example.com')).toBe(false)
  })
})

describe('保存した資格情報', () => {
  /** 偽の暗号化（平文がファイルに出ないことだけ確かめる） */
  const fakeCipher: KeyCipher = {
    available: () => true,
    encrypt: (text) => Buffer.from(Buffer.from(text, 'utf8').map((b) => b ^ 0x5a)),
    decrypt: (data) => Buffer.from(data.map((b) => b ^ 0x5a)).toString('utf8')
  }

  it('同じオリジン＋ユーザー名は置き換え（id はそのまま）、新しいものは足す', () => {
    let n = 0
    const first = mergeLogins([], [{ origin: 'https://a.test', username: 'u', password: 'p1' }], () => `id${++n}`)
    const next = mergeLogins(first.logins, [{ origin: 'https://a.test', username: 'u', password: 'p2' }, { origin: 'https://b.test', username: 'u', password: 'p3' }], () => `id${++n}`)
    expect(next).toEqual({
      logins: [{ id: 'id1', origin: 'https://a.test', username: 'u', password: 'p2' }, { id: 'id2', origin: 'https://b.test', username: 'u', password: 'p3' }],
      added: 1,
      updated: 1
    })
  })

  it('壊れた行は読まない', () => {
    expect(sanitizeStoredLogins({ logins: [{ id: 'a', origin: 'https://a.test', username: 'u', password: 'p' }, { id: 'b', origin: 'file:///x', username: 'u', password: 'p' }, { id: 1 }, null] }))
      .toEqual([{ id: 'a', origin: 'https://a.test', username: 'u', password: 'p' }])
    expect(sanitizeStoredLogins('nope')).toEqual([])
  })

  it('暗号化して保存し（ファイルに平文が無い）、読み直せる。ページのオリジンに合うものだけを返す', async () => {
    const path = join(await tempDir(), 'browser-import', 'passwords.bin')
    const store = new SavedLoginStore(path, fakeCipher)
    expect(await store.importLogins([
      { origin: 'https://example.com', username: 'alice', password: FAKE_PASSWORD },
      { origin: 'https://other.test', username: 'bob', password: 'another-value' }
    ])).toEqual({ added: 2, updated: 0 })
    const raw = await readFile(path)
    expect(raw.includes(Buffer.from(FAKE_PASSWORD))).toBe(false)
    expect(raw.includes(Buffer.from('alice'))).toBe(false)

    const reopened = new SavedLoginStore(path, fakeCipher)
    expect(await reopened.count()).toBe(2)
    const accounts = await reopened.accountsFor('https://www.example.com/login')
    expect(accounts).toEqual([{ id: expect.any(String), username: 'alice' }])
    // 一覧にパスワードは含めない
    expect(JSON.stringify(accounts)).not.toContain(FAKE_PASSWORD)
    expect(await reopened.loginFor(accounts[0]!.id, 'https://example.com/')).toMatchObject({ password: FAKE_PASSWORD })
    // 別のオリジンのページには渡さない
    expect(await reopened.loginFor(accounts[0]!.id, 'https://other.test/')).toBeNull()
    expect(await reopened.loginFor(accounts[0]!.id, 'https://login.example.com/')).toBeNull()

    await reopened.clear()
    expect(existsSync(path)).toBe(false)
    expect(await reopened.count()).toBe(0)
  })

  it('暗号化できない環境では保存しない（その起動の間だけ持つ）', async () => {
    const path = join(await tempDir(), 'passwords.bin')
    const store = new SavedLoginStore(path, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' })
    await store.importLogins([{ origin: 'https://example.com', username: 'alice', password: FAKE_PASSWORD }])
    expect(existsSync(path)).toBe(false)
    expect(await store.count()).toBe(1)
    expect(store.persisted()).toBe(false)
  })
})

describe('ログインの欄への入力のスクリプト', () => {
  /** 最小限の DOM の代わり。入れた値と発火したイベントを記録する */
  function fakePage(origin: string, inputs: Array<{ type: string; autocomplete?: string }>) {
    const log: string[] = []
    class FakeInput {
      value = ''
      disabled = false
      readOnly = false
      form = null
      constructor(public type: string, public autocomplete: string, public index: number) {}
      getClientRects() { return [1] }
      focus() {}
      dispatchEvent(event: { type: string }) { log.push(`${this.type}:${event.type}`); return true }
      compareDocumentPosition(other: FakeInput) { return other.index > this.index ? 4 : 2 }
    }
    const elements = inputs.map((i, n) => new FakeInput(i.type, i.autocomplete ?? '', n))
    const proto = {}
    Object.defineProperty(proto, 'value', { set(this: FakeInput, v: string) { this.value = v; log.push(`${this.type}=${v}`) } })
    const document = {
      querySelectorAll: (selector: string) => selector.includes('"password"') && !selector.includes('text')
        ? elements.filter((e) => e.type === 'password')
        : elements.filter((e) => e.type !== 'password')
    }
    const env = { location: { origin }, document, HTMLInputElement: { prototype: proto }, Event: class { constructor(public type: string) {} }, Node: { DOCUMENT_POSITION_FOLLOWING: 4 } }
    const run = (script: string) => new Function(...Object.keys(env), `return ${script}`)(...Object.values(env)) as number
    return { run, log, elements }
  }

  it('ユーザー名とパスワードを元の setter で入れ、input・change を発火する', () => {
    const page = fakePage('https://example.com', [{ type: 'email' }, { type: 'password' }])
    expect(page.run(buildFillScript({ username: 'alice', password: FAKE_PASSWORD }, 'https://example.com'))).toBe(2)
    expect(page.log).toEqual(['email=alice', 'email:input', 'email:change', `password=${FAKE_PASSWORD}`, 'password:input', 'password:change'])
  })

  it('実行した時点のオリジンが違えば何もしない', () => {
    const page = fakePage('https://evil.test', [{ type: 'text' }, { type: 'password' }])
    expect(page.run(buildFillScript({ username: 'alice', password: FAKE_PASSWORD }, 'https://example.com'))).toBe(0)
    expect(page.log).toEqual([])
  })

  it('値は JSON で埋め込み、文字列の外へ出ない', () => {
    const tricky = `"); location.href = 'https://evil.test'; ("\\'\u2028`
    const page = fakePage('https://example.com', [{ type: 'text', autocomplete: 'username' }, { type: 'password' }])
    expect(page.run(buildFillScript({ username: tricky, password: tricky }, 'https://example.com'))).toBe(2)
    expect(page.elements.map((e) => e.value)).toEqual([tricky, tricky])
  })
})

describe('履歴の行', () => {
  it('Chromium・Safari の時刻を UNIX 時刻のミリ秒へ', () => {
    // 2024-01-01T00:00:00Z
    const unix = Date.UTC(2024, 0, 1)
    expect(chromiumMsToUnixMs(unix + 11_644_473_600_000)).toBe(unix)
    expect(safariSecondsToUnixMs(unix / 1000 - 978_307_200)).toBe(unix)
  })

  it('http / https で時刻のある行だけ。タイトルの空白はならす', () => {
    expect(toHistoryEntry({ url: 'https://example.com/a', title: ' A \n page ', lastVisit: 5 })).toEqual({ url: 'https://example.com/a', title: 'A page', lastVisit: 5 })
    expect(toHistoryEntry({ url: 'chrome://settings', title: '', lastVisit: 5 })).toBeNull()
    expect(toHistoryEntry({ url: 'https://example.com', title: null, lastVisit: 0 })).toBeNull()
    expect(toHistoryEntry({ url: 'https://example.com', title: null, lastVisit: 9 })).toEqual({ url: 'https://example.com', title: '', lastVisit: 9 })
    expect(toHistoryEntry({ url: 42, title: '', lastVisit: 9 })).toBeNull()
  })

  it('合わせると同じ URL は新しいほう（タイトルが空なら古いほうのタイトル）、新しい順に上限まで', () => {
    const merged = mergeHistory(
      [{ url: 'https://a.test/', title: 'A', lastVisit: 1 }, { url: 'https://b.test/', title: 'B', lastVisit: 3 }],
      [{ url: 'https://a.test/', title: '', lastVisit: 5 }, { url: 'https://c.test/', title: 'C', lastVisit: 2 }],
      2
    )
    expect(merged).toEqual([{ url: 'https://a.test/', title: 'A', lastVisit: 5 }, { url: 'https://b.test/', title: 'B', lastVisit: 3 }])
  })

  it('保存したファイルの壊れた行は捨てる', () => {
    expect(sanitizeHistory({ entries: [{ url: 'https://a.test/', title: 'A', lastVisit: 1 }, { url: 'javascript:x', lastVisit: 1 }, 'x'] }))
      .toEqual([{ url: 'https://a.test/', title: 'A', lastVisit: 1 }])
    expect(sanitizeHistory(null)).toEqual([])
  })

  it('候補はすべての語を URL かタイトルに含むもの。ホスト名が入力で始まるものを先に、あとは新しい順', () => {
    const entries = [
      { url: 'https://docs.example.com/guide', title: 'Guide', lastVisit: 30 },
      { url: 'https://github.com/example/repo', title: 'Repo', lastVisit: 20 },
      { url: 'https://www.github.com/settings', title: 'Settings', lastVisit: 10 }
    ]
    expect(suggestHistory(entries, 'git').map((e) => e.url)).toEqual(['https://github.com/example/repo', 'https://www.github.com/settings'])
    expect(suggestHistory(entries, 'example').map((e) => e.url)).toEqual(['https://docs.example.com/guide', 'https://github.com/example/repo'])
    expect(suggestHistory(entries, 'GITHUB settings').map((e) => e.url)).toEqual(['https://www.github.com/settings'])
    expect(suggestHistory(entries, '   ')).toEqual([])
    expect(suggestHistory(entries, 'e', 1)).toHaveLength(1)
  })
})

describe('履歴の DB の読み取り（偽の DB）', () => {
  it('Chromium 系の History を写してから読む（隠れた行・http でない行は除く）', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const home = await tempDir()
    const profile = join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default')
    await mkdir(profile, { recursive: true })
    const path = join(profile, 'History')
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER)')
    const at = (unixMs: number) => BigInt(unixMs + 11_644_473_600_000) * 1000n
    const insert = db.prepare('INSERT INTO urls (url, title, last_visit_time, hidden) VALUES (?, ?, ?, ?)')
    insert.run('https://example.com/new', 'New', at(Date.UTC(2024, 5, 1)), 0)
    insert.run('https://example.com/old', 'Old', at(Date.UTC(2023, 0, 1)), 0)
    insert.run('https://example.com/hidden', 'Hidden', at(Date.UTC(2024, 0, 1)), 1)
    insert.run('chrome://newtab/', 'New Tab', at(Date.UTC(2024, 0, 1)), 0)
    db.close()

    const sources = await detectHistorySources('darwin', home, {})
    expect(sources.map(({ key, kind }) => ({ key, kind }))).toEqual([
      { key: 'Google Chrome|Default', kind: 'chromium' },
      { key: 'Safari|', kind: 'safari' }
    ])
    expect(await readHistorySource(sources[0]!)).toEqual([
      { url: 'https://example.com/new', title: 'New', lastVisit: Date.UTC(2024, 5, 1) },
      { url: 'https://example.com/old', title: 'Old', lastVisit: Date.UTC(2023, 0, 1) }
    ])
  })

  it('Safari の History.db は URL ごとに最後の訪問とそのタイトル', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const path = join(await tempDir(), 'History.db')
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT); CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT)')
    db.exec("INSERT INTO history_items (id, url) VALUES (1, 'https://example.com/'), (2, 'https://other.test/')")
    const s = (unixMs: number) => unixMs / 1000 - 978_307_200
    const visit = db.prepare('INSERT INTO history_visits (history_item, visit_time, title) VALUES (?, ?, ?)')
    visit.run(1, s(Date.UTC(2024, 0, 1)), 'Old title')
    visit.run(1, s(Date.UTC(2024, 2, 1)), 'New title')
    visit.run(2, s(Date.UTC(2024, 1, 1)), 'Other')
    db.close()
    expect(await readHistorySource({ kind: 'safari', path })).toEqual([
      { url: 'https://example.com/', title: 'New title', lastVisit: Date.UTC(2024, 2, 1) },
      { url: 'https://other.test/', title: 'Other', lastVisit: Date.UTC(2024, 1, 1) }
    ])
  })

  it('取り込んだ履歴は別のファイルに持ち、候補を返し、削除できる', async () => {
    const path = join(await tempDir(), 'browser-import', 'history.json')
    const store = new ImportedHistoryStore(path)
    expect(await store.add([{ url: 'https://example.com/', title: 'Example', lastVisit: 2 }, { url: 'https://other.test/', title: 'Other', lastVisit: 1 }])).toBe(2)
    expect(await new ImportedHistoryStore(path).suggest('exam')).toEqual([{ url: 'https://example.com/', title: 'Example', lastVisit: 2 }])
    await store.clear()
    expect(existsSync(path)).toBe(false)
    expect(await store.count()).toBe(0)
  })

  it('読めない元は投げる（本物のブラウザのフォルダは見ない）', async () => {
    await expect(readHistorySource({ kind: 'chromium', path: join(await tempDir(), 'missing', 'History') })).rejects.toThrow()
  })
})
