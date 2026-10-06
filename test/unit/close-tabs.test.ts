import { describe, expect, it } from 'vitest'
import { CLOSE_TABS_ACTIONS, nextActiveAfterClose, tabsToClose } from '../../src/renderer/editor/closeTabs'
import { en } from '../../src/shared/i18n/en'
import { ja } from '../../src/shared/i18n/ja'

/**
 * 中央のタブ列の右クリックの「閉じる」（closeTabs.ts）。
 * ブラウザ・指摘・設定のタブは閉じず、「右側」は画面の並び（ドラッグで並べ替えた後）で数えることを固定する。
 */
const order = ['browser', 'file:/p/a.ts', 'findings', 'file:/p/b.md', 'settings', 'file:/p/c.html', 'file:/p/d.ts']
const dirty = new Set(['file:/p/b.md', 'file:/p/d.ts'])
const isDirty = (tab: string) => dirty.has(tab)

describe('tabsToClose', () => {
  it('閉じる: そのタブだけ', () => {
    expect(tabsToClose('close', 'file:/p/b.md', order, isDirty)).toEqual(['file:/p/b.md'])
    expect(tabsToClose('close', 'browser', order, isDirty)).toEqual([])
  })

  it('ほかを閉じる: ほかのファイルのタブ（固定のタブは残す）', () => {
    expect(tabsToClose('closeOthers', 'file:/p/b.md', order, isDirty)).toEqual(['file:/p/a.ts', 'file:/p/c.html', 'file:/p/d.ts'])
  })

  it('右側を閉じる: 画面の並びで右にあるファイルのタブ（間の設定のタブは残す）', () => {
    expect(tabsToClose('closeRight', 'file:/p/b.md', order, isDirty)).toEqual(['file:/p/c.html', 'file:/p/d.ts'])
    expect(tabsToClose('closeRight', 'file:/p/d.ts', order, isDirty)).toEqual([])
    expect(tabsToClose('closeRight', 'file:/p/x.ts', order, isDirty)).toEqual([])
  })

  it('保存済みを閉じる: 未保存の変更が無いものだけ', () => {
    expect(tabsToClose('closeSaved', 'file:/p/b.md', order, isDirty)).toEqual(['file:/p/a.ts', 'file:/p/c.html'])
  })

  it('すべて閉じる: ファイルのタブ全部（未保存のものも。確認は呼び出し側）', () => {
    expect(tabsToClose('closeAll', 'file:/p/a.ts', order, isDirty)).toEqual(['file:/p/a.ts', 'file:/p/b.md', 'file:/p/c.html', 'file:/p/d.ts'])
  })

  it('どの操作にもメニューの文言がある', () => {
    for (const action of CLOSE_TABS_ACTIONS) {
      expect(en[`centerTabs.menu.${action}`]).toBeTruthy()
      expect(ja[`centerTabs.menu.${action}`]).toBeTruthy()
    }
  })
})

describe('nextActiveAfterClose', () => {
  const files = ['a', 'b', 'c', 'd']
  it('右隣の残ったもの、無ければ左隣', () => {
    expect(nextActiveAfterClose(files, 'b', new Set(['b']))).toBe('c')
    expect(nextActiveAfterClose(files, 'b', new Set(['b', 'c']))).toBe('d')
    expect(nextActiveAfterClose(files, 'd', new Set(['d']))).toBe('c')
    expect(nextActiveAfterClose(files, 'c', new Set(['c', 'd', 'b']))).toBe('a')
  })

  it('全部閉じたら null（ブラウザへ戻す）', () => {
    expect(nextActiveAfterClose(files, 'a', new Set(files))).toBeNull()
  })
})
