import { CLOSABLE_PANELS, DEFAULT_LAYOUT, FOOTER_ITEMS, TERMINAL_DOCKS, withPanel, type Dock, type PanelId } from '@shared/layout'
import { Button } from '../ui'
import { useT } from '../lib/i18n'
import { setLayout, useLayout } from '../lib/layout'

/**
 * 設定の「レイアウト」欄の中身（行だけ）。左右のパネルの表示、ターミナルの置き場所（右か下）、フッターに出す項目を選ぶ。
 * 左右のパネルの置き場所は固定（プロジェクト一覧は左・ファイルツリーは右）。開閉はタイトルバーのボタンと同じ値。
 * 値は lib/layout.ts が持ち、変えたその場で画面に反映・保存する（閉じたときの一括保存の対象外）。
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
      {CLOSABLE_PANELS.map((id) => <div key={id} className="st-layout__panel">
        {toggle(t('settings.layout.show', { panel: panelName(id) }), layout.panels[id].visible,
          (visible) => setLayout((prev) => withPanel(prev, id, { visible })), `layout-${id}-visible`)}
      </div>)}
      {/* ターミナルは常に表示する（閉じる手段を持たない）ので、表示の切り替えは出さない。置き場所（右か下）だけ選べる */}
      <div className="st-layout__panel">
        {dockSelect(t('settings.layout.position', { panel: panelName('terminal') }), layout.panels.terminal.dock, TERMINAL_DOCKS,
          (dock) => setLayout((prev) => withPanel(prev, 'terminal', { dock: dock as Dock })), 'layout-terminal-dock')}
      </div>
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
