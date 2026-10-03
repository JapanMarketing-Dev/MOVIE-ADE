import { useEffect, useState } from 'react'
import { useT } from '../lib/i18n'

type TelemetryState = { active: boolean; enabled: boolean; noticeShown: boolean }

/**
 * 設定の「クラッシュレポートを送る」（src/main/telemetry.ts）。
 * 自分で状態を読み、切り替えたらすぐ保存する。OFF はすぐ効き、ON は次の起動から。
 */
export function CrashReportsSetting() {
  const t = useT()
  const [state, setState] = useState<TelemetryState | null>(null)
  /** この画面を開いたときの値。ON に戻したときだけ「次の起動から」を出す */
  const [initial, setInitial] = useState<boolean | null>(null)

  useEffect(() => {
    void window.ade.invoke('telemetry:state').then((s) => { setState(s); setInitial(s.enabled) }).catch(() => undefined)
  }, [])

  const change = (enabled: boolean) => {
    setState((s) => (s ? { ...s, enabled } : s))
    void window.ade.invoke('settings:crashReports', enabled).catch(() => undefined)
  }

  if (!state) return null
  return <>
    <label className="st-row st-row--switch" data-testid="crash-reports-setting">
      <span className="st-row__label">{t('settings.privacy.crashReports')}</span>
      <input type="checkbox" role="switch" className="st-switch" checked={state.enabled} onChange={(e) => change(e.target.checked)} />
    </label>
    <p className="st-note">{t('settings.privacy.crashReportsHint')}</p>
    {state.enabled && !state.active && initial === false && <p className="st-note st-note--warn">{t('settings.privacy.crashReportsRestart')}</p>}
    {state.enabled && !state.active && initial !== false && <p className="st-note">{t('settings.privacy.crashReportsDevOnly')}</p>}
  </>
}
