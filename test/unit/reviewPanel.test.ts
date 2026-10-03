import { describe, expect, it } from 'vitest'
import { buildUrlTree, fileTargetEntry, sanitizeUrlHistory } from '../../src/shared/reviewTarget'
import { searchReviewPanel, splitHighlight } from '../../src/shared/reviewPanelSearch'
import { quickOpenMatchIndices } from '../../src/shared/quickOpen'
import { MAX_EXPANDED, expandedStorageKey, parseExpanded, serializeExpanded } from '../../src/shared/fileTreeState'
import type { ProjectUrl } from '../../src/shared/types'

const presets: ProjectUrl[] = [
  { id: 'l', label: 'local', url: 'http://localhost:3000/' },
  { id: 'd', label: 'dev', url: 'https://dev.example.com/app' },
  { id: 'w', label: 'iOS sim', launchCommand: 'open -a Simulator', windowMatch: 'Simulator' }
]

describe('確認先ごとの URL ツリー（閲覧履歴から）', () => {
  const history = [
    'http://localhost:3000/pricing',
    'http://localhost:3000/docs/setup',
    'http://localhost:3000/docs/api?v=2',
    'http://localhost:3000/',
    'http://localhost:3000/pricing#faq',
    'https://dev.example.com/app/settings',
    'http://127.0.0.1:5173/admin',
    'ade-preview://project/README.md'
  ]
  const groups = buildUrlTree(presets, history)

  it('URL の確認先ごとに、見たページをパスの木にする（確認先そのもののページは入れない）', () => {
    const local = groups.find((g) => g.id === 'l')!
    expect(local.nodes.map((n) => [n.depth, n.name, n.visited])).toEqual([
      [0, 'docs', false],
      [1, 'api?v=2', true],
      [1, 'setup', true],
      [0, 'pricing', true]
    ])
    // 途中の階層はオリジン＋パスで開ける。見たページは見た URL のまま開く（同じ環境）
    expect(local.nodes[0]!.url).toBe('http://localhost:3000/docs')
    expect(local.nodes[1]!.url).toBe('http://localhost:3000/docs/api?v=2')
  })

  it('確認先の下のパス（/app の下）も、その確認先にまとめる', () => {
    expect(groups.find((g) => g.id === 'd')!.nodes.map((n) => n.path)).toEqual(['/app', '/app/settings'])
  })

  it('どの確認先にも当たらない URL は、オリジンごとの登録外のまとまりにする。ウインドウだけの確認先は木を持たない', () => {
    expect(groups.map((g) => [g.id, g.registered])).toEqual([['l', true], ['d', true], ['other:http://127.0.0.1:5173', false]])
    expect(groups[2]!.label).toBe('127.0.0.1:5173')
  })

  it('履歴が無ければ、登録した確認先だけ（木は空）', () => {
    expect(buildUrlTree(presets, []).map((g) => [g.id, g.nodes.length])).toEqual([['l', 0], ['d', 0]])
  })
})

describe('閲覧履歴が壊れていても落ちない（Sentry MOVIE-ADE-J: history is not iterable）', () => {
  const broken: unknown[] = [undefined, null, { 0: 'http://localhost:3000/a' }, '{"not":"json', 'not json at all', 42, true]

  it('配列でない・壊れた JSON の履歴は空として扱い、確認先だけを出す', () => {
    for (const value of broken) {
      expect(sanitizeUrlHistory(value), String(value)).toEqual([])
      expect(buildUrlTree(presets, value).map((g) => [g.id, g.nodes.length]), String(value)).toEqual([['l', 0], ['d', 0]])
    }
  })

  it('保存した JSON の文字列はそのまま読む。文字列でない要素・空の要素は捨て、上限で切る', () => {
    expect(sanitizeUrlHistory(JSON.stringify(['http://localhost:3000/pricing', 3, null, '', '  ', { url: 'x' }]))).toEqual(['http://localhost:3000/pricing'])
    expect(sanitizeUrlHistory(Array.from({ length: 300 }, (_, i) => `http://localhost:3000/${i}`))).toHaveLength(200)
    expect(buildUrlTree(presets, JSON.stringify(['http://localhost:3000/pricing'])).find((g) => g.id === 'l')!.nodes.map((n) => n.name)).toEqual(['pricing'])
  })
})

describe('まとめた検索（⌘P と同じあいまい一致）', () => {
  const sources = [
    { id: 't:l', kind: 'target' as const, text: 'local http://localhost:3000/' },
    { id: 'u:l:/pricing', kind: 'url' as const, text: 'local /pricing' },
    { id: 'u:d:/app/settings', kind: 'url' as const, text: 'dev /app/settings' }
  ]
  const files = ['docs/pricing.md', 'src/settings.ts', 'README.md']

  it('確認先・ページを先に、ファイルを後に、良い順で返す', () => {
    expect(searchReviewPanel('pricing', sources, files).map((h) => h.id)).toEqual(['u:l:/pricing', 'file:docs/pricing.md'])
    expect(searchReviewPanel('settings', sources, files).map((h) => h.kind)).toEqual(['url', 'file'])
  })

  it('文字を順に拾うあいまい一致で、一致した位置を返す（強調表示に使う）', () => {
    const [hit] = searchReviewPanel('lpr', sources, [])
    expect(hit!.id).toBe('u:l:/pricing')
    expect(hit!.indices).toEqual(quickOpenMatchIndices('lpr', 'local /pricing'))
    expect(splitHighlight('local /pricing', [0, 7, 8])).toEqual([
      { text: 'l', hit: true }, { text: 'ocal /', hit: false }, { text: 'pr', hit: true }, { text: 'icing', hit: false }
    ])
  })

  it('空の問い合わせ・一致なしは空', () => {
    expect(searchReviewPanel('  ', sources, files)).toEqual([])
    expect(searchReviewPanel('zzz', sources, files)).toEqual([])
    expect(quickOpenMatchIndices('zzz', 'local')).toEqual([])
  })
})

describe('ファイルを押したときの対象', () => {
  it('md も他のテキストも、ade-preview:// のプレビューで開く（相対パスを持つ）', () => {
    expect(fileTargetEntry('docs/a.md')).toMatchObject({ kind: 'file', path: 'docs/a.md', url: 'ade-preview://project/docs/a.md', title: 'a.md' })
    expect(fileTargetEntry('src/app.ts').url).toBe('ade-preview://project/src/app.ts')
  })
})

describe('ツリーの開閉の保存', () => {
  it('プロジェクトごとの鍵で、開いたフォルダを読み書きする', () => {
    expect(expandedStorageKey('feedbackTree', 'p1')).toBe('ade.feedbackTree.expanded.p1')
    const raw = serializeExpanded(['src/main', 'src', 'docs'])
    expect(JSON.parse(raw)).toEqual(['docs', 'src', 'src/main'])
    expect([...parseExpanded(raw)]).toEqual(['docs', 'src', 'src/main'])
  })

  it('壊れた値・プロジェクトの外を指す値は捨てる', () => {
    expect(parseExpanded(null).size).toBe(0)
    expect(parseExpanded('{').size).toBe(0)
    expect([...parseExpanded(JSON.stringify(['ok', '/abs', '../up', 'a/../b', 3, '']))]).toEqual(['ok'])
  })

  it('上限で切る（浅いものを残す）', () => {
    const many = Array.from({ length: MAX_EXPANDED + 50 }, (_, i) => `a/${i}`)
    expect(parseExpanded(serializeExpanded(['a', ...many])).has('a')).toBe(true)
    expect(parseExpanded(serializeExpanded(many)).size).toBe(MAX_EXPANDED)
  })
})
