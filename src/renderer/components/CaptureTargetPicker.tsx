import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppWindow, CircleCheck, Globe, Info, Monitor, RefreshCw, ScreenShare, Search, ShieldAlert, Smartphone, SquareArrowOutUpRight, X } from 'lucide-react'
import type { CaptureSourceInfo, CaptureSourceList, CaptureTarget, DesktopAppInfo } from '@shared/types'
import { captureTargetLabel, targetFromSource, targetIncludes, toggleSourceInTarget } from '@shared/captureTarget'
import { MAX_COMPOSITE_SOURCES } from '@shared/captureComposite'
import { deviceKindOf, groupByApp } from '@shared/desktopApps'
import { filterApps, matchLaunchedWindow } from '@shared/desktopAppCatalog'
import { delay } from '@shared/delay'
import { Button, Field, IconButton, Modal, Segmented, Spinner } from '../ui'
import { useT } from '../lib/i18n'
import { errorMessage } from '../lib/errors'

/**
 * 録画の対象を選ぶ小さな画面（REC-2 の拡張）。
 *
 * 内蔵ブラウザ（既定）／画面全体（ディスプレイを選ぶ）／別のウインドウ（デスクトップアプリ。一覧から選ぶ）／
 * スマホ（iOS シミュレータ・Android Emulator のウインドウだけを出す。録る対象としてはウインドウ）。
 * 画面とウインドウはサムネイルで選ぶ。ウインドウはアプリ名を添え、同じアプリのものを並べる。
 * 選んだ対象は次回の既定として覚える（Settings.capture）。
 *
 * - カードを押すとその1つを選ぶ（これまでどおり）。カードの左上のチェックで、画面・ウインドウを複数選べる。
 *   複数選ぶと、録画ウインドウが横に並べて1本の動画にする（CaptureTarget.also / @shared/captureComposite）
 * - 「ウインドウ」では、まだ開いていないアプリも名前で選べる（capture:apps）。選ぶとアプリを開き（前面へ出し）、
 *   ウインドウが出たらそれを選んでカードにフォーカスを移す
 * - macOS の一覧には、いま表示しているデスクトップ（Spaces）のウインドウしか出ない。その説明を添える
 *
 * ⚠ 内蔵ブラウザのビューはDOMの上に重なるので、開いている間は App 側でビューを隠す。
 */

/** 選択画面のタブ。mobile は録る対象としては window（スマホのシミュレータ／エミュレータのウインドウ） */
type Kind = CaptureTarget['kind'] | 'mobile'

const KIND_OPTIONS = [
  { value: 'browser' as const, label: 'capture.kind.browser' as const, icon: <Globe size={14} />, testId: 'capture-kind-browser' },
  { value: 'screen' as const, label: 'capture.kind.screen' as const, icon: <Monitor size={14} />, testId: 'capture-kind-screen' },
  { value: 'window' as const, label: 'capture.kind.window' as const, icon: <AppWindow size={14} />, testId: 'capture-kind-window' },
  { value: 'mobile' as const, label: 'capture.kind.mobile' as const, icon: <Smartphone size={14} />, testId: 'capture-kind-mobile' }
]

/** アプリの一覧に一度に出す数（多いときは検索で絞ってもらう） */
const APPS_SHOWN = 40
/** アプリを開いてからウインドウを探す回数（1秒ごと）。capture:sources の許可（操作から30秒）に収まるようにする */
const LAUNCH_POLLS = 15

/** いまの対象を開いたときのタブ（スマホのウインドウならスマホ） */
function kindOf(target: CaptureTarget): Kind {
  return target.kind === 'window' && (target.device || deviceKindOf(target.appName, target.name)) ? 'mobile' : target.kind
}

/** そのタブで選べる対象か（スマホのウインドウは「ウインドウ」のタブでも選べる。複数選んでいればどのタブでも保つ） */
function fits(target: CaptureTarget, kind: Kind): boolean {
  if (target.kind !== 'browser' && target.also?.length) return kind !== 'browser'
  if (kind === 'window') return target.kind === 'window'
  if (kind === 'mobile') return kindOf(target) === 'mobile'
  return target.kind === kind
}

export function CaptureTargetPicker({
  value,
  pageTitle,
  onChoose,
  onStart,
  onClose,
  onAdd,
  initialKind
}: {
  value: CaptureTarget
  /** 内蔵ブラウザで開いているページの名前 */
  pageTitle: string
  /** 対象を覚えて閉じる */
  onChoose: (target: CaptureTarget) => void
  /** 対象を覚えて、そのまま録画を始める */
  onStart: (target: CaptureTarget) => void
  onClose: () => void
  /**
   * 録画中に開いたとき。選んだものを今の録画に足して同時に録る（@shared/captureTracks）。
   * 渡すと［選ぶ］［これを録画］の代わりに［録画に足す］だけを出す（複数選ぶチェックは出さない）
   */
  onAdd?: (target: CaptureTarget) => void
  /** 開いたときのタブ。省略時はいまの対象のタブ */
  initialKind?: Kind
}) {
  const t = useT()
  const [kind, setKind] = useState<Kind>(initialKind ?? kindOf(value))
  const [selected, setSelected] = useState<CaptureTarget | null>(initialKind && !fits(value, initialKind) ? null : value)
  const [list, setList] = useState<CaptureSourceList | null>(null)
  const [loading, setLoading] = useState(false)
  const [limitHit, setLimitHit] = useState(false)
  const [apps, setApps] = useState<DesktopAppInfo[] | null>(null)
  const [appsLoading, setAppsLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [launching, setLaunching] = useState<string | null>(null)
  const [appNote, setAppNote] = useState<{ tone: 'ok' | 'warning'; text: string } | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const cards = useRef(new Map<string, HTMLButtonElement>())
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const multi = !onAdd

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

  // 「ウインドウ」を開いたら、入れてあるアプリの名前を読む（画面には触れない）
  useEffect(() => {
    if (kind !== 'window' || apps || appsLoading) return
    setAppsLoading(true)
    window.ade.invoke('capture:apps')
      .then((next) => { if (alive.current) setApps(next) })
      .catch(() => { if (alive.current) setApps([]) }) // 失敗は main の IPC が Sentry へ送る（一覧が空になるだけ）
      .finally(() => { if (alive.current) setAppsLoading(false) })
  }, [kind, apps, appsLoading])

  // アプリを開いて見つけたウインドウのカードへフォーカスを移す（描かれてから）
  useEffect(() => {
    if (!focusId) return
    const card = cards.current.get(focusId)
    if (!card) return
    card.focus()
    card.scrollIntoView?.({ block: 'nearest' })
    setFocusId(null)
  }, [focusId, list, kind])

  const pickKind = (next: Kind) => {
    setKind(next)
    setLimitHit(false)
    if (next === 'browser') setSelected({ kind: 'browser' })
    else if (!selected || !fits(selected, next)) setSelected(fits(value, next) ? value : null)
  }

  /** カードの左上のチェック。選んでいなければ足し、選んでいれば外す */
  const toggle = (source: CaptureSourceInfo) => {
    const base = selected && fits(selected, kind) ? selected : null
    const next = toggleSourceInTarget(base, source)
    setLimitHit(next === base && !!base && !targetIncludes(base, source.id))
    setSelected(next)
  }

  /** アプリを開いて（前面へ出して）、ウインドウが出たらそれを選ぶ */
  const launch = async (app: DesktopAppInfo) => {
    if (launching) return
    setLaunching(app.name)
    setAppNote(null)
    try {
      const before = new Set((list?.sources ?? []).filter((s) => s.kind === 'window').map((s) => s.id))
      const info = await window.ade.invoke('capture:launchApp', app.id)
      for (let i = 0; i < LAUNCH_POLLS; i++) {
        await delay(i === 0 ? 600 : 1000)
        if (!alive.current) return
        const next = await window.ade.invoke('capture:sources')
        if (!alive.current) return
        setList(next)
        const found = matchLaunchedWindow(next.sources, info, before)
        if (!found) continue
        // 複数選んでいる途中なら足す。そうでなければその1つを選ぶ
        setSelected((current) => (multi && current && current.kind !== 'browser' && current.also?.length ? toggleSourceInTarget(current, found) ?? targetFromSource(found)
          : targetFromSource(found)))
        setFocusId(found.id)
        setAppNote({ tone: 'ok', text: t('capture.apps.selected', { name: app.name }) })
        return
      }
      setAppNote({ tone: 'warning', text: t('capture.apps.windowNotFound', { name: app.name }) })
    } catch (err) {
      if (alive.current) setAppNote({ tone: 'warning', text: errorMessage(err) })
    } finally {
      if (alive.current) setLaunching(null)
    }
  }

  const all = list?.sources ?? []
  // ウインドウは同じアプリのものを並べる。スマホはシミュレータ／エミュレータのウインドウだけ
  const sources = kind === 'mobile' ? all.filter((source) => source.kind === 'window' && source.device)
    : kind === 'window' ? groupByApp(all.filter((source) => source.kind === 'window')).flatMap((group) => group.windows)
      : all.filter((source) => source.kind === kind)
  const isMac = window.ade.platform === 'darwin'
  const needsAccess = !!list && list.screenAccess !== 'granted' && isMac
  const ready = selected !== null && fits(selected, kind)
  const shownApps = useMemo(() => filterApps(apps ?? [], query), [apps, query])

  return (
    <Modal className="rv-modal" label={onAdd ? t('capture.addTitle') : t('capture.title')} onClose={onClose}>
      <div className="rv-modal__panel capture-picker" data-testid="capture-picker">
        <header className="rv-modal__head">
          <h2><ScreenShare size={16} aria-hidden="true" />{onAdd ? t('capture.addTitle') : t('capture.title')}</h2>
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
                {kind === 'screen' ? t('capture.pickDisplay') : kind === 'mobile' ? t('capture.pickDevice') : t('capture.pickWindow')}
                {' '}{t('capture.noBrowserLog')}
                {multi && <>{' '}{t('capture.multiHint', { n: MAX_COMPOSITE_SOURCES })}</>}
              </span>
              <IconButton label={t('capture.refreshList')} size="sm" icon={<RefreshCw size={14} />} disabled={loading} onClick={() => void load()} />
            </div>
            {/* macOS の一覧の制約（Spaces・フルスクリーン）。技術的に録れないものを先に伝える */}
            {isMac && (
              <p className="capture-picker__note" data-testid="capture-spaces-note">
                <Info size={14} aria-hidden="true" />
                <span>{kind === 'screen' ? t('capture.spacesScreenNote') : t('capture.spacesWindowNote')}</span>
              </p>
            )}
            {kind !== 'screen' && list?.appFullScreen && (
              <p className="capture-picker__note capture-picker__note--warning" data-testid="capture-fullscreen-note">
                <Info size={14} aria-hidden="true" />
                <span>{t('capture.fullScreenNote')}</span>
              </p>
            )}
            {limitHit && <p className="capture-picker__note capture-picker__note--warning" role="status">{t('capture.multiLimit', { n: MAX_COMPOSITE_SOURCES })}</p>}
            {loading && !list ? (
              <div className="capture-picker__loading"><Spinner size={18} label={t('capture.loading')} /></div>
            ) : sources.length === 0 ? (
              <p className="rv-modal__empty">{kind === 'screen' ? t('capture.noScreens') : kind === 'mobile' ? t('capture.noDevices') : t('capture.noWindows')}</p>
            ) : (
              <div className="capture-grid" role="list">
                {sources.map((source) => {
                  const included = targetIncludes(selected && fits(selected, kind) ? selected : null, source.id)
                  const label = source.appName ? `${source.appName} — ${source.name}` : source.name
                  return (
                    <div role="listitem" className="capture-item" key={source.id}>
                      <button
                        type="button"
                        ref={(el) => { if (el) cards.current.set(source.id, el); else cards.current.delete(source.id) }}
                        className={`capture-card${included ? ' is-selected' : ''}`}
                        aria-pressed={included}
                        title={label}
                        data-source-id={source.id}
                        onClick={() => { setLimitHit(false); setSelected(targetFromSource(source)) }}
                      >
                        <span className="capture-card__thumb">
                          {source.thumbnail ? <img src={source.thumbnail} alt="" />
                            : source.device ? <Smartphone size={24} aria-hidden="true" />
                              : source.kind === 'window' ? <AppWindow size={24} aria-hidden="true" /> : <Monitor size={24} aria-hidden="true" />}
                          {included && <span className="capture-card__check"><CircleCheck size={16} aria-hidden="true" /></span>}
                        </span>
                        <span className="capture-card__label">
                          {source.appIcon && <img className="capture-card__app" src={source.appIcon} alt="" />}
                          <span className="capture-card__names">
                            {source.appName && source.appName !== source.name && <span className="capture-card__app-name">{source.appName}</span>}
                            <span className="capture-card__name">{source.name}</span>
                          </span>
                        </span>
                      </button>
                      {multi && (
                        <label className="capture-card__multi" title={t('capture.multiToggle', { name: source.name })}>
                          <input type="checkbox" checked={included} onChange={() => toggle(source)} aria-label={t('capture.multiToggle', { name: label })} data-testid="capture-multi" />
                        </label>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            {kind === 'window' && (
              <section className="capture-apps" aria-label={t('capture.apps.title')} data-testid="capture-apps">
                <div className="capture-apps__head">
                  <h3>{t('capture.apps.title')}</h3>
                  <span className="capture-picker__hint">{t('capture.apps.hint')}</span>
                </div>
                <Field icon={<Search size={14} />} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('capture.apps.search')} aria-label={t('capture.apps.search')} data-testid="capture-apps-search" />
                {appNote && <p className={`capture-picker__note${appNote.tone === 'warning' ? ' capture-picker__note--warning' : ''}`} role="status">{appNote.text}</p>}
                {appsLoading && !apps ? (
                  <div className="capture-picker__loading capture-picker__loading--small"><Spinner size={16} label={t('capture.loading')} /></div>
                ) : shownApps.length === 0 ? (
                  <p className="rv-modal__empty">{t('capture.apps.empty')}</p>
                ) : (
                  <ul className="capture-apps__list">
                    {shownApps.slice(0, APPS_SHOWN).map((app) => (
                      <li key={app.id}>
                        <button type="button" className="capture-apps__item" title={app.path} disabled={!!launching} onClick={() => void launch(app)}>
                          <AppWindow size={14} aria-hidden="true" />
                          <span className="capture-apps__name">{app.name}</span>
                          {launching === app.name ? <Spinner size={12} label={t('capture.apps.launching', { name: app.name })} /> : <SquareArrowOutUpRight size={12} aria-hidden="true" />}
                        </button>
                      </li>
                    ))}
                    {shownApps.length > APPS_SHOWN && <li className="capture-picker__hint">{t('capture.apps.more', { n: shownApps.length - APPS_SHOWN })}</li>}
                  </ul>
                )}
              </section>
            )}
          </>
        )}

        <footer className="capture-picker__foot">
          <span className="capture-picker__current">{selected && ready ? captureTargetLabel(selected) : t('capture.notSelected')}</span>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          {onAdd ? (
            <Button variant="primary" disabled={!ready} onClick={() => selected && onAdd(selected)} data-testid="capture-add">{t('capture.addThis')}</Button>
          ) : <>
            <Button disabled={!ready} onClick={() => selected && onChoose(selected)} data-testid="capture-choose">{t('capture.choose')}</Button>
            <Button variant="record" disabled={!ready} onClick={() => selected && onStart(selected)} data-testid="capture-start">{t('capture.recordThis')}</Button>
          </>}
        </footer>
      </div>
    </Modal>
  )
}
