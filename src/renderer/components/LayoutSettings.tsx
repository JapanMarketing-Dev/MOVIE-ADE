import { DEFAULT_LAYOUT, DOCKS, FOOTER_ITEMS, PANEL_IDS, withPanel, type Dock, type PanelId } from '@shared/layout'
import { Button } from '../ui'
import { useT } from '../lib/i18n'
import { setLayout, useLayout } from '../lib/layout'

/**
 * 設定の「レイアウト」欄の中身（行だけ）。パネルごとの置き場所（左・右・上・下）と表示、フッターに出す項目を選ぶ。
 * 値は lib/layout.ts が持ち、変えたその場で画面に反映・保存する（閉じたときの一括保存の対象外）。
 * パネルの見出しのつまみをドラッグして画面の端へ運んでも、同じ値が変わる（PanelDock.tsx）。
 * 外側の section・見出しは設定ページ（SettingsPage）が出す。
 */
export function LayoutSettings() {
  const t = useT()
  const layout = useLayout()
  const panelName = (id: PanelId | 'footer') => t(`settings.layout.panel.${id}`)

  const dockSelect = (label: string, value: string, options: readonly string[], onChange: (v: string) => void, testId: string) => (
    <label className="st-row">
      <span className="st-row__label">{label}</span>
      <span className="rv-select">
        <select className="st-select" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId}>
          {options.map((d) => <option key={d} value={d}>{t(`settings.layout.dock.${d as Dock}`)}</option>)}
        </select>
      </span>
    </label>
  )
  const toggle = (label: string, checked: boolean, onChange: (v: boolean) => void, testId: string) => (
    <label className="st-row st-row--switch">
      <span className="st-row__label">{label}</span>
      <input type="checkbox" role="switch" className="st-switch" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
    </label>
  )

  return <>
      <p className="st-note">{t('settings.layout.intro')}</p>
      {PANEL_IDS.map((id) => <div key={id} className="st-layout__panel">
        {/* ターミナルは常に表示する（閉じる手段を持たない）ので、表示の切り替えは出さない。置き場所だけ選べる */}
        {id !== 'terminal' && toggle(t('settings.layout.show', { panel: panelName(id) }), layout.panels[id].visible,
          (visible) => setLayout((prev) => withPanel(prev, id, { visible })), `layout-${id}-visible`)}
        {dockSelect(t('settings.layout.position', { panel: panelName(id) }), layout.panels[id].dock, DOCKS,
          (dock) => setLayout((prev) => withPanel(prev, id, { dock: dock as Dock })), `layout-${id}-dock`)}
      </div>)}
      <div className="st-layout__panel">
        {toggle(t('settings.layout.show', { panel: panelName('footer') }), layout.footer.visible,
          (visible) => setLayout((prev) => ({ ...prev, footer: { ...prev.footer, visible } })), 'layout-footer-visible')}
      </div>
      <p className="st-note">{t('settings.layout.footerItems')}</p>
      <div className="st-layout__items">
        {FOOTER_ITEMS.map((id) => <label key={id} className="st-layout__item">
          <input type="checkbox" checked={layout.footer.items[id]} disabled={!layout.footer.visible}
            onChange={(e) => {
              const on = e.target.checked
              setLayout((prev) => ({ ...prev, footer: { ...prev.footer, items: { ...prev.footer.items, [id]: on } } }))
            }} data-testid={`layout-item-${id}`} />
          <span>{t(`settings.layout.item.${id}`)}</span>
        </label>)}
      </div>
      <div className="st-agent__reset">
        <Button variant="ghost" onClick={() => setLayout(DEFAULT_LAYOUT)} data-testid="layout-reset">{t('settings.layout.reset')}</Button>
      </div>
  </>
}
