import { describe, expect, it } from 'vitest'
import { currentDockGroup, groupDockTargets } from '../../src/shared/dockGroups'

const shop = { id: 'shop', name: '営業企業DB', urls: [{ label: 'prd', url: 'https://shop.example.com/' }, { label: 'local', url: 'http://localhost:3000' }, { label: 'figma' }] }
const abm = { id: 'abm', name: 'abm-targeting', urls: [{ label: 'prd', url: 'https://abm.example.com' }, { label: 'local', url: 'http://localhost:3001' }] }
const idle = { id: 'idle', name: 'site', urls: [] }

describe('全体のフィードバックの帯（2段のタブ）', () => {
  it('上の段はプロダクト、下の段は prd・local と、そのプロダクトの確認リスト', () => {
    const groups = groupDockTargets([shop, abm, idle], [])
    expect(groups.map((g) => g.label)).toEqual(['営業企業DB', 'abm-targeting'])
    expect(groups[0]!.items.map((i) => i.label)).toEqual(['prd', 'local'])
  })

  it('確認リストの行はオリジンか名前でプロダクトに入り、同じ URL は1つにまとめて印を付ける。B1 のプロダクトが先', () => {
    const groups = groupDockTargets([shop, abm], [
      { key: 'B1', label: 'ABM ターゲット', url: 'https://abm.example.com/list', note: '一覧' },
      { key: 'B2', label: '営業企業DB', url: 'https://shop.example.com', note: '検索' },
      { key: 'B3', label: 'abm-targeting', url: 'https://other.example.net/x', note: '' }
    ])
    expect(groups.map((g) => g.id)).toEqual(['p:abm', 'p:shop'])
    expect(groups[0]!.items).toEqual([
      { key: '', label: 'prd', url: 'https://abm.example.com' },
      { key: '', label: 'local', url: 'http://localhost:3001' },
      { key: 'B1', label: '一覧', url: 'https://abm.example.com/list' },
      { key: 'B3', label: 'abm-targeting', url: 'https://other.example.net/x' }
    ])
    expect(groups[1]!.items[0]).toEqual({ key: 'B2', label: 'prd', url: 'https://shop.example.com/' })
  })

  it('同じオリジンのプロダクトが複数なら、名前で分ける（同じホストの別のパス・同じ localhost）', () => {
    const a = { id: 'a', name: 'blog', urls: [{ label: 'local', url: 'http://127.0.0.1:5000/?p=blog' }] }
    const b = { id: 'b', name: 'shop', urls: [{ label: 'local', url: 'http://127.0.0.1:5000/?p=shop' }] }
    const groups = groupDockTargets([a, b], [
      { key: 'B1', label: 'shop', url: 'http://127.0.0.1:5000/?b=1', note: '' },
      { key: 'B2', label: 'x', url: 'http://127.0.0.1:5000/?p=blog', note: '' }
    ])
    expect(groups.map((g) => [g.id, g.items.map((i) => i.key)])).toEqual([['p:b', ['', 'B1']], ['p:a', ['B2']]])
  })

  it('どのプロダクトにも合わない行は、行の名前ごとに上の段のタブになる', () => {
    const groups = groupDockTargets([shop], [
      { key: 'B1', label: '日程調整', url: 'https://cal.example.org/a', note: '予約' },
      { key: 'B2', label: '日程調整', url: 'https://cal.example.org/b', note: '' }
    ])
    expect(groups.map((g) => [g.label, g.items.map((i) => i.key)])).toEqual([['日程調整', ['B1', 'B2']], ['営業企業DB', ['', '']]])
  })

  it('開いているページのプロダクト：同じ URL を先に、無ければ同じオリジン。どれでもなければ null', () => {
    const groups = groupDockTargets([shop, abm], [])
    expect(currentDockGroup(groups, 'https://shop.example.com')).toBe('p:shop')
    expect(currentDockGroup(groups, 'http://localhost:3001/settings')).toBe('p:abm')
    expect(currentDockGroup(groups, 'about:blank')).toBeNull()
  })
})
