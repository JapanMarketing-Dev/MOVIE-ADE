import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Globe, RotateCw } from 'lucide-react'
import type { BrowserState } from '@shared/types'
import { SHORTCUTS } from '../lib/shortcut'
import { errorMessage } from '../lib/errors'
import { Field, IconButton, Tooltip, useToast } from '../ui'
import { useT } from '../lib/i18n'

/**
 * 内蔵ブラウザの 戻る・進む・再読込・URL欄（WS-2）。
 * 並びは Orca に合わせる: ← → ⟳ ［URL］。
 * エディタモードとフィードバックモードの両方のツールバーで同じものを使う。
 *
 * ツールチップの向き（`tooltipSide`）は呼び出し側が決める。
 * ブラウザのツールバーのすぐ下はネイティブのビューで、下向きに出すと隠れるため。
 * フィードバックモードでは `tooltipSide` を省略し、OS標準の title に任せる
 * （上にも下にも逃げ場がなく、画面共有に出る画面でもあるため）。
 */
export function NavControls({
  state,
  urlInputRef,
  tooltipSide
}: {
  state: BrowserState
  urlInputRef?: React.RefObject<HTMLInputElement | null>
  tooltipSide?: 'top' | 'bottom'
}) {
  const t = useT()

  /** ツールチップを使う場面と、OS標準の title で済ませる場面を1か所で切り替える */
  const wrap = (label: string, shortcut: string | undefined, node: React.ReactElement) =>
    tooltipSide ? (
      <Tooltip label={label} shortcut={shortcut} side={tooltipSide}>
        {node}
      </Tooltip>
    ) : (
      node
    )

  return (
    <>
      <div className="browser-toolbar__nav">
        {wrap(
          t('browser.back'),
          undefined,
          <IconButton
            label={t('browser.back')}
            title={tooltipSide ? undefined : t('browser.back')}
            icon={<ArrowLeft size={16} strokeWidth={1.75} />}
            onClick={() => void window.ade.invoke('browser:back')}
            disabled={!state.canGoBack}
            data-testid="nav-back"
          />
        )}
        {wrap(
          t('browser.forward'),
          undefined,
          <IconButton
            label={t('browser.forward')}
            title={tooltipSide ? undefined : t('browser.forward')}
            icon={<ArrowRight size={16} strokeWidth={1.75} />}
            onClick={() => void window.ade.invoke('browser:forward')}
            disabled={!state.canGoForward}
            data-testid="nav-forward"
          />
        )}
        {wrap(
          t('browser.reload'),
          SHORTCUTS.reload(),
          <IconButton
            label={t('browser.reload')}
            title={tooltipSide ? undefined : t('browser.reloadWithKey', { key: SHORTCUTS.reload() })}
            icon={<RotateCw size={16} strokeWidth={1.75} className={state.loading ? 'is-spinning' : undefined} />}
            onClick={() => void window.ade.invoke('browser:reload')}
            data-testid="nav-reload"
          />
        )}
      </div>

      <UrlField state={state} inputRef={urlInputRef} />
    </>
  )
}

/**
 * URL 欄。入れて Enter で、前に出ているタブをその URL へ移す。
 * エディタのツールバー（NavControls）と、フィードバックモードのタブの帯（FeedbackBrowserBar）で同じものを使う
 */
export function UrlField({
  state,
  inputRef,
  testId = 'url-input'
}: {
  state: BrowserState
  inputRef?: React.RefObject<HTMLInputElement | null>
  testId?: string
}) {
  const displayed = state.url === 'about:blank' ? '' : state.url
  const [draft, setDraft] = useState(displayed)
  const editing = useRef(false)
  const toast = useToast()

  // 入力中はユーザーの文字を上書きしない。遷移が起きたら表示を追従させる。
  // タブを切り替えたら、打ちかけの文字は捨てて、前に出たタブの URL を出す
  useEffect(() => {
    if (!editing.current) setDraft(displayed)
  }, [displayed])
  useEffect(() => {
    editing.current = false
    setDraft(displayed)
    // タブが変わったときだけ（URL の変化は上で追う）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeTabId])

  return (
    <form
      className="url-form"
      onSubmit={(event) => {
        event.preventDefault()
        editing.current = false
        // URLとして読めない入力は開かずに知らせる（いまのページはそのまま）
        void window.ade.invoke('browser:navigate', draft).catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
      }}
    >
      <Field
        ref={inputRef}
        mono
        icon={<Globe size={14} strokeWidth={1.75} />}
        type="text"
        value={draft}
        placeholder="http://localhost:3000"
        aria-label="URL"
        autoComplete="off"
        data-testid={testId}
        onChange={(event) => {
          editing.current = true
          setDraft(event.target.value)
        }}
        onBlur={() => {
          editing.current = false
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            editing.current = false
            setDraft(displayed)
            event.currentTarget.blur()
          }
        }}
      />
      {/* 読み込み中は URL欄の下端に線が流れる。文字で「読み込み中」と書くより静か */}
      <span className={`url-progress${state.loading ? ' is-loading' : ''}`} aria-hidden="true" />
    </form>
  )
}
