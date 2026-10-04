import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_CATALOG, BUILTIN_AGENTS } from '../../src/shared/agentCatalog'
import { LOCALE_LABELS, SUPPORTED_LOCALES } from '../../src/shared/i18n'
import {
  I18N_DIR,
  LANGS,
  LANG_LABELS,
  TOKEN,
  TRANSLATABLE,
  agentCatalog,
  checkTranslations,
  englishUnits,
  localized,
  parseTranslation,
  rehashUnits,
  renderDocs,
  sourceHash,
  translationStatus,
} from '../../tools/docs/build-docs.mjs'

/**
 * docs の言語・訳のファイル・OS ごとのショートカット・エージェントの一覧の約束ごと。
 * 書き方は tools/docs/i18n/README.md。訳が古い（英語が変わった）と落ちるので、その単位を訳し直して --rehash する。
 */
const docs = renderDocs()
const MAC_GLYPHS = /[⌘⌥⇧⌃]/

describe('docs の言語', () => {
  it('アプリと同じ14言語で、名前はその言語自身の表記', () => {
    expect([...LANGS].sort()).toEqual([...SUPPORTED_LOCALES].sort())
    expect(LANG_LABELS).toEqual(LOCALE_LABELS)
  })

  it('英語は /docs/<page>、ほかは /docs/<lang>/<page> に全ページを書き出す', () => {
    const pages = Object.keys(docs).filter((f) => !f.includes('/'))
    for (const lang of LANGS.filter((l) => l !== 'en')) for (const p of pages) expect(docs, `${lang}/${p}`).toHaveProperty([`${lang}/${p}`])
  })

  it('訳の無いページは英語の本文に「まだ訳していない」帯を出し、検索に載せない', () => {
    // 全言語の訳がそろうと「訳の無いページ」は無くなる。そのときはこの確かめは要らない（どれかが欠けたら、その組で確かめる）
    const missing = LANGS.filter((l) => l !== 'en').flatMap((lang) => TRANSLATABLE.filter((n) => n !== '_site' && localized(lang, n).status === 'none').map((name) => ({ lang, name })))
    if (missing.length === 0) return
    const { lang, name } = missing[0]!
    const html = docs[`${lang}/${name}.html`]
    expect(html).toContain(`<html lang="${lang}">`)
    expect(html).toContain('docs-callout-i18n')
    expect(html).toContain('<meta name="robots" content="noindex, follow">')
    expect(html).toContain(`<link rel="canonical" href="https://ferretade.dev/docs/${name}">`)
  })

  it('訳のあるページ（見本の ja/quick-start）は帯を出さず、英語と互いに hreflang で指し合う', () => {
    expect(localized('ja', 'quick-start').status).toBe('full')
    const ja = docs['ja/quick-start.html']
    expect(ja).toContain('<html lang="ja">')
    expect(ja).not.toContain('docs-callout-i18n')
    expect(ja).not.toContain('noindex')
    for (const html of [ja, docs['quick-start.html']]) {
      expect(html).toContain('<link rel="alternate" hreflang="ja" href="https://ferretade.dev/docs/ja/quick-start">')
      expect(html).toContain('<link rel="alternate" hreflang="x-default" href="https://ferretade.dev/docs/quick-start">')
    }
  })

  it('ブラウザの言語で勝手に移らない（docs.js は navigator.language を見ない）', () => {
    const js = readFileSync(join(I18N_DIR, '../../../site/docs/docs.js'), 'utf8')
    expect(js).not.toMatch(/navigator\.languages?\b/)
  })
})

describe('訳のファイル（tools/docs/i18n/<lang>/<page>.html）', () => {
  const files = existsSync(I18N_DIR)
    ? readdirSync(I18N_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .flatMap((d) => readdirSync(join(I18N_DIR, d.name)).map((f) => [d.name, f.replace(/\.html$/, '')] as const))
    : []

  it('--check（翻訳担当が自分の言語だけを確かめる検査）がどの言語でも問題を出さない', () => {
    expect(LANGS.filter((l) => l !== 'en').flatMap((l) => checkTranslations(l))).toEqual([])
  })

  it('知っている言語とページだけがある', () => {
    for (const [lang, name] of files) {
      expect(LANGS.filter((l) => l !== 'en'), lang).toContain(lang)
      expect(TRANSLATABLE, `${lang}/${name}`).toContain(name)
    }
  })

  it('英語が変わって古くなった訳・英語に無い単位が無い（直したら node tools/docs/build-docs.mjs --rehash <lang> <page>）', () => {
    const bad = translationStatus()
      .filter((r) => r.stale.length || r.extra.length)
      .map((r) => `${r.lang}/${r.name}: stale=${r.stale.join(',')} extra=${r.extra.join(',')}`)
    expect(bad).toEqual([])
  })

  it('札（{{keys:…}}・{{clip:名前|…}}・{{shot:名前|…}}・{{agent-catalog}}・{{path}} など）とリンク先は訳しても同じ', () => {
    const tokens = (s: string) =>
      [...s.matchAll(/\{\{[^}]*\}\}/g)].map(([t]) => (/^\{\{(clip|shot):/.test(t) ? t.slice(0, t.indexOf('|')) : t)).sort()
    const hrefs = (s: string) => [...s.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1]).sort()
    for (const [lang, name] of files) {
      const en = englishUnits(name)
      for (const [id, { text, hash }] of parseTranslation(readFileSync(join(I18N_DIR, lang, `${name}.html`), 'utf8'))) {
        if (!en.has(id) || hash === '0000000000') continue
        expect(tokens(text), `${lang}/${name} @${id}`).toEqual(tokens(en.get(id)!))
        expect(hrefs(text), `${lang}/${name} @${id}`).toEqual(hrefs(en.get(id)!))
        if (name !== '_site') expect(text.split('\n')[0] ?? '', `${lang}/${name} @${id}`).toMatch(id === 'title' || id === 'lead' ? /^(?!##)/ : /^## /)
      }
    }
  })
})

describe('ショートカットは macOS と Windows / Linux の両方', () => {
  it('本文（英語と訳）は ⌘ ⌥ ⇧ ⌃ を直接書かず、{{keys:…}} の札で書く', () => {
    for (const lang of LANGS)
      for (const name of TRANSLATABLE)
        for (const [id, text] of localized(lang, name).units) expect({ unit: `${lang}/${name} @${id}`, glyph: MAC_GLYPHS.test(text) }).toEqual({ unit: `${lang}/${name} @${id}`, glyph: false })
  })

  it('書き出した HTML の ⌘ ⌥ ⇧ ⌃ は、macOS 側（.os-mac）の中にしか無い', () => {
    for (const [file, html] of Object.entries(docs)) {
      const outside = html
        .replace(/<span class="os-mac">[\s\S]*?<\/span>(?=<span class="os-sep">|<\/span>)/g, '')
        .replace(/<td class="os-mac">[\s\S]*?<\/td>/g, '')
      expect({ file, glyph: MAC_GLYPHS.test(outside) }).toEqual({ file, glyph: false })
    }
  })

  it('札は両方の表記に開き、OS の切り替えと Windows / Linux 列を持つ', () => {
    const qs = docs['quick-start.html']
    expect(qs).toContain('<span class="os-mac"><kbd>⌘</kbd><kbd>⇧</kbd><kbd>R</kbd></span><span class="os-sep"> / </span><span class="os-win"><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>R</kbd></span>')
    expect(qs).toContain('data-docs-os hidden')
    expect(qs).not.toMatch(/\{\{keys/)
    const kb = docs['keyboard.html']
    expect(kb).toContain('<th class="os-mac">macOS</th><th class="os-win">Windows / Linux</th>')
  })

  it('keyboard ページの割り当ては src/main/menu.ts と同じ（OS で違うもの）', () => {
    const kb = docs['keyboard.html']
    const row = (action: string) => new RegExp(`<tr><td>${action}</td><td class="os-mac">(.*?)</td><td class="os-win">(.*?)</td></tr>`).exec(kb)?.slice(1)
    expect(row('Back')).toEqual(['<kbd>⌘</kbd><kbd>[</kbd>', '<kbd>Alt</kbd><kbd>←</kbd>'])
    expect(row('Split Right')).toEqual(['<kbd>⌘</kbd><kbd>D</kbd>', '<kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>D</kbd>'])
    expect(row('Split Down')).toEqual(['<kbd>⌘</kbd><kbd>⇧</kbd><kbd>D</kbd>', '<kbd>Alt</kbd><kbd>Shift</kbd><kbd>D</kbd>'])
    expect(row('Close Window')).toEqual(['<kbd>⌘</kbd><kbd>⇧</kbd><kbd>W</kbd>', '—'])
    const menu = readFileSync(join(I18N_DIR, '../../../src/main/menu.ts'), 'utf8')
    expect(menu).toContain("accelerator: 'Cmd+Shift+W'")
    expect(menu).toContain("accelerator: 'Ctrl+Shift+D'")
    expect(menu).toContain("accelerator: 'Alt+Shift+D'")
  })
})

describe('対応しているエージェントの一覧', () => {
  it('src/shared/agentCatalog.ts と同じ順・名前・コマンド', () => {
    expect(agentCatalog().map((a) => a.id)).toEqual([...BUILTIN_AGENTS])
    for (const a of agentCatalog()) {
      const entry = AGENT_CATALOG[a.id as keyof typeof AGENT_CATALOG]
      expect(a).toEqual({ id: a.id, label: entry.label, command: entry.launchCmd ?? entry.detectCmd, homepageUrl: entry.homepageUrl })
    }
  })

  it('agents ページに全部載る', () => {
    const html = docs['agents.html']
    expect(html).not.toContain('{{agent-catalog}}')
    for (const a of agentCatalog()) expect(html).toContain(`<code>${a.command.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code>`)
  })

  it('札の正規表現は札だけを拾う', () => {
    expect('{{keys:Mod+O}} {{path}}'.match(TOKEN)).toEqual(['{{keys:Mod+O}}'])
  })
})

describe('--rehash', () => {
  const en = new Map([
    ['os.mac', 'macOS'],
    ['title', 'Concepts'],
    ['lead', 'Ferret records your screen.'],
  ])
  const pending = '0000000000'

  it('英語と同じ文でも、今の英語のハッシュが付いていれば保つ（未訳に戻さない）', () => {
    const have = new Map([
      ['os.mac', { hash: sourceHash('macOS'), text: 'macOS' }],
      ['title', { hash: sourceHash('Concepts'), text: 'Concepts' }],
      ['lead', { hash: pending, text: 'Ferret records your screen.' }],
    ])
    const out = rehashUnits(en, have)
    expect(out.get('os.mac')!.hash).toBe(sourceHash('macOS'))
    expect(out.get('title')!.hash).toBe(sourceHash('Concepts'))
    // まだ訳していない単位は未訳のまま
    expect(out.get('lead')!.hash).toBe(pending)
  })

  it('英語が変わって古いハッシュの単位は、英語と同じ文なら未訳に戻し、訳してあれば今のハッシュにする', () => {
    const have = new Map([
      ['os.mac', { hash: sourceHash('Mac'), text: 'macOS' }],
      ['lead', { hash: sourceHash('old'), text: 'Ferret enregistre votre écran.' }],
      ['gone', { hash: sourceHash('x'), text: 'x' }],
    ])
    const out = rehashUnits(en, have)
    expect(out.get('os.mac')!.hash).toBe(pending)
    expect(out.get('lead')!.hash).toBe(sourceHash('Ferret records your screen.'))
    expect(out.has('gone')).toBe(false)
    expect(rehashUnits(en, have, true).get('os.mac')!.hash).toBe(sourceHash('macOS'))
  })
})
