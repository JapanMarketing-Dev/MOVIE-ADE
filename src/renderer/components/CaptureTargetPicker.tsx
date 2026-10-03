import { useCallback, useEffect, useState } from 'react'
import { AppWindow, CircleCheck, Globe, Monitor, RefreshCw, ScreenShare, ShieldAlert, X } from 'lucide-react'
import type { CaptureSourceList, CaptureTarget } from '@shared/types'
import { captureTargetLabel, targetFromSource } from '@shared/captureTarget'
import { Button, IconButton, Modal, Segmented, Spinner } from '../ui'
import { useT } from '../lib/i18n'

/**
 * 録画の対象を選ぶ小さな画面（REC-2 の拡張）。
 *
 * 内蔵ブラウザ（既定）／画面全体（ディスプレイを選ぶ）／別のウインドウ（一覧から選ぶ）。
 * 画面とウインドウはサムネイルで選ぶ。選んだ対象は次回の既定として覚える（Settings.capture）。
 *
 * ⚠ 内蔵ブラウザのビューはDOMの上に重なるので、開いている間は App 側でビューを隠す。
 */

type Kind = CaptureTarget['kind']

const KIND_OPTIONS = [
  { value: 'browser' as const, label: 'capture.kind.browser' as const, icon: <Globe size={14} />, testId: 'capture-kind-browser' },
  { value: 'screen' as const, label: 'capture.kind.screen' as const, icon: <Monitor size={14} />, testId: 'capture-kind-screen' },
  { value: 'window' as const, label: 'capture.kind.window' as const, icon: <AppWindow size={14} />, testId: 'capture-kind-window' }
]

export function CaptureTargetPicker({
  value,
  pageTitle,
  onChoose,
  onStart,
  onClose
}: {
  value: CaptureTarget
  /** 内蔵ブラウザで開いているページの名前 */
  pageTitle: string
  /** 対象を覚えて閉じる */
  onChoose: (target: CaptureTarget) => void
  /** 対象を覚えて、そのまま録画を始める */
  onStart: (target: CaptureTarget) => void
  onClose: () => void
}) {
  const t = useT()
  const [kind, setKind] = useState<Kind>(value.kind)
  const [selected, setSelected] = useState<CaptureTarget | null>(value)
  const [list, setList] = useState<CaptureSourceList | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setList(await window.ade.invoke('capture:sources'))
    } catch { // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
      setList({ screenAccess: 'unknown', sources: [] })
    } finally {
      setLoading(false)
    }
  }, [])

  // 画面・ウインドウを選ぶときだけ一覧を取る（一覧の取得で macOS の許可ダイアログが出ることがある）
  useEffect(() => {
    if (kind !== 'browser' && !list && !loading) void load()
  }, [kind, list, loading, load])

  const pickKind = (next: Kind) => {
    setKind(next)
    if (next === 'browser') setSelected({ kind: 'browser' })
    else if (selected?.kind !== next) setSelected(value.kind === next ? value : null)
  }

  const sources = (list?.sources ?? []).filter((source) => source.kind === kind)
  const needsAccess = !!list && list.screenAccess !== 'granted' && window.ade.platform === 'darwin'
  const ready = selected !== null && selected.kind === kind

  return (
    <Modal className="rv-modal" label={t('capture.title')} onClose={onClose}>
      <div className="rv-modal__panel capture-picker" data-testid="capture-picker">
        <header className="rv-modal__head">
          <h2><ScreenShare size={16} aria-hidden="true" />{t('capture.title')}</h2>
          <IconButton label={t('common.close')} icon={<X size={16} />} onClick={onClose} />
        </header>

        <Segmented options={KIND_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} value={kind} onChange={pickKind} ariaLabel={t('capture.kindLabel')} className="capture-picker__kinds" />

        {kind === 'browser' ? (
          <button type="button" className="capture-card capture-card--browser is-selected" aria-pressed="true" onClick={() => setSelected({ kind: 'browser' })}>
            <span className="capture-card__browser-icon" aria-hidden="true"><Globe size={28} strokeWidth={1.5} /></span>
            <span className="capture-card__body">
              <span className="capture-card__name">{pageTitle || t('capture.browserPage')}</span>
              <span className="capture-card__note">{t('capture.browserNote')}</span>
            </span>
          </button>
        ) : (
          <>
            {needsAccess && (
              <div className="capture-picker__access" role="alert" data-testid="capture-access">
                <ShieldAlert size={16} aria-hidden="true" />
                <div>
                  <p>{t('capture.needsPermission')}</p>
                  <p className="capture-picker__steps">{t('capture.permissionSteps')}</p>
                  <div className="capture-picker__access-actions">
                    <Button variant="primary" onClick={() => void window.ade.invoke('capture:openScreenSettings')}>{t('capture.openSystemSettings')}</Button>
                    <Button variant="ghost" icon={<RefreshCw size={14} />} onClick={() => void load()}>{t('capture.recheck')}</Button>
                  </div>
                </div>
              </div>
            )}
            <div className="capture-picker__bar">
              <span className="capture-picker__hint">
                {kind === 'screen' ? t('capture.pickDisplay') : t('capture.pickWindow')}
                {' '}{t('capture.noBrowserLog')}
              </span>
              <IconButton label={t('capture.refreshList')} size="sm" icon={<RefreshCw size={14} />} disabled={loading} onClick={() => void load()} />
            </div>
            {loading && !list ? (
              <div className="capture-picker__loading"><Spinner size={18} label={t('capture.loading')} /></div>
            ) : sources.length === 0 ? (
              <p className="rv-modal__empty">{kind === 'screen' ? t('capture.noScreens') : t('capture.noWindows')}</p>
            ) : (
              <div className="capture-grid" role="list">
                {sources.map((source) => {
                  const isSelected = selected?.kind === source.kind && selected.sourceId === source.id
                  return (
                    <button
                      type="button"
                      role="listitem"
                      key={source.id}
                      className={`capture-card${isSelected ? ' is-selected' : ''}`}
                      aria-pressed={isSelected}
                      title={source.name}
                      onClick={() => setSelected(targetFromSource(source))}
                    >
                      <span className="capture-card__thumb">
                        {source.thumbnail ? <img src={source.thumbnail} alt="" /> : <Monitor size={24} aria-hidden="true" />}
                        {isSelected && <span className="capture-card__check"><CircleCheck size={16} aria-hidden="true" /></span>}
                      </span>
                      <span className="capture-card__label">
                        {source.appIcon && <img className="capture-card__app" src={source.appIcon} alt="" />}
                        <span className="capture-card__name">{source.name}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </>
        )}

        <footer className="capture-picker__foot">
          <span className="capture-picker__current">{selected && ready ? captureTargetLabel(selected) : t('capture.notSelected')}</span>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={!ready} onClick={() => selected && onChoose(selected)} data-testid="capture-choose">{t('capture.choose')}</Button>
          <Button variant="record" disabled={!ready} onClick={() => selected && onStart(selected)} data-testid="capture-start">{t('capture.recordThis')}</Button>
        </footer>
      </div>
    </Modal>
  )
}
