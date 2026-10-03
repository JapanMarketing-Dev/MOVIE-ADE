import { useState, type FocusEvent, type PointerEvent, type ReactNode } from 'react'
import { AppWindow, Eraser, Globe, MicOff, Monitor, PanelsTopLeft, Pause, Play, PenTool, TriangleAlert, Type } from 'lucide-react'
import type { BrowserState, CaptureTarget } from '@shared/types'
import { captureTargetLabel } from '@shared/captureTarget'
import { formatShortcut } from '../lib/shortcut'
import { IconButton, RecordButton, RecordDot } from '../ui'
import { useT } from '../lib/i18n'

/**
 * フィードバックモードのツールバー（設計 3章 / MODE-2）。
 *
 * MTGで相手に画面共有される画面なので、幅いっぱいの帯ではなく
 * **浮いたピル**にして、レビュー対象の画面を最大限見せる。
 *
 * ⚠ 内蔵ブラウザ（WebContentsView）はネイティブのビューで、DOMの上に必ず重なる。
 * つまりピルをページの上に本当に浮かせることはできない。そこで上に細い帯
 * （--size-fb-bar）を確保し、その中でピルを浮かせる。
 *
 * 録画中・一時停止中はひと目で分かるようにする（REC-5 / NF-11）:
 *   録画中   … 縁が赤く光り、点が呼吸し、経過時間が赤くなる
 *   一時停止 … 縁と時間が琥珀色になり、時間が点滅し、「一時停止中」の札が出る
 *
 * ツールチップはビューに隠れるので出さない。代わりにピルの中の
 * 「案内の枠」（ふだんはページ名）を、指しているボタンの名前とキーに差し替える。
 *
 * 録画中の警告（上限が近い・保存の失敗など）もトーストはビューに隠れるので、
 * 同じ枠に数秒だけ出す（notice）。ボタンの案内より優先する。
 */
/** 録画中に使える書き込みの道具（PEN-1 / TXT-1）*/
export type AnnotationTool = 'none' | 'pen' | 'text'

type Keys = ReadonlyArray<string>

/** menu.ts の accelerator と対応させる（録画 CmdOrCtrl+Shift+R / モード CmdOrCtrl+Shift+M）*/
const KEYS = {
  record: ['Mod', 'Shift', 'R'],
  mode: ['Mod', 'Shift', 'M'],
  holdPen: ['Alt']
} as const satisfies Record<string, Keys>

/** キーを1つずつキーキャップにする（⌘ ⇧ R） */
function KeyCaps({ keys }: { keys: Keys }) {
  return (
    <span className="fb-keycaps" aria-hidden="true">
      {keys.map((key) => (
        <kbd key={key} className="fb-keycap">
          {formatShortcut(key)}
        </kbd>
      ))}
    </span>
  )
}

/** マイクの入力レベル。5本のバーで、声の大きさに合わせて伸びる */
function MicLevel({ level, live }: { level: number; live: boolean }) {
  // rms は話し声でも 0.05〜0.2 程度なので5倍して 0〜1 に寄せる
  const t = useT()
  const value = live ? Math.min(1, level * 5) : 0
  return (
    <span
      className={`fb-mic${live ? ' is-live' : ''}`}
      role="meter"
      aria-label={t('feedback.micLevel')}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Number(value.toFixed(2))}
    >
      {[0.35, 0.7, 1, 0.7, 0.35].map((weight, index) => (
        <span
          // 並びは固定。キーは位置で足りる
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          className="fb-mic__bar"
          style={{ transform: `scaleY(${Math.max(0.18, Math.min(1, value * weight * 1.6))})` }}
        />
      ))}
    </span>
  )
}

export function FeedbackToolbar({
  state,
  level = 0,
  captureMic = true,
  recording,
  elapsed,
  tool = 'none',
  onToolChange,
  onToggleRecording,
  onBackToEditor,
  paused = false,
  busy = false,
  onPause,
  onClear,
  notice,
  target = { kind: 'browser' },
  onPickTarget
}: {
  level?: number
  captureMic?: boolean
  state: BrowserState
  recording: boolean
  elapsed: string
  /** 選択中の道具。録画中だけ選べる */
  tool?: AnnotationTool
  onToolChange?: (tool: AnnotationTool) => void
  onToggleRecording: () => void
  onBackToEditor: () => void
  paused?: boolean
  busy?: boolean
  onPause?: () => void
  onClear?: () => void
  /** 帯に短く出す警告。無ければページ名・ボタンの案内を出す */
  notice?: string | null
  /** 録画の対象（内蔵ブラウザ／画面全体／別のウインドウ） */
  target?: CaptureTarget
  /** 録画の対象の選択画面を開く。録画中は押せない */
  onPickTarget?: () => void
}) {
  /* 録画中は書き込みの道具が使える。止まっている間は押せない */
  const t = useT()
  const pick = (next: AnnotationTool) => onToolChange?.(tool === next ? 'none' : next)
  // 画面・ウインドウを録っているときは、内蔵ブラウザのページ名ではなく録っている対象を出す
  const page = target.kind === 'browser' ? state.title || state.url.replace(/^https?:\/\//, '') : captureTargetLabel(target)
  const isPaused = recording && paused
  const toolsOff = !recording || paused || busy

  /*
   * 指しているボタンの案内。無ければページ名を出す。
   * 押せないボタンはイベントを受けないので、ボタンを包む枠（data-hint）で拾い、
   * ピル全体への委譲で読む（離れたときに消し損ねない）。
   */
  const hints: Record<string, { label: string; keys?: Keys; note?: string }> = {
    target: { label: t('feedback.target', { target: captureTargetLabel(target) }) },
    record: { label: recording ? t('feedback.stop') : t('feedback.record'), keys: KEYS.record },
    pause: { label: paused ? t('feedback.resume') : t('feedback.pause') },
    pen: { label: t('feedback.pen'), keys: KEYS.holdPen, note: t('feedback.whileHeld') },
    text: { label: t('feedback.text') },
    clear: { label: t('feedback.clear') },
    editor: { label: t('feedback.toEditor'), keys: KEYS.mode }
  }
  const [hintId, setHintId] = useState<string | null>(null)
  const hint = hintId ? hints[hintId] : undefined
  const pointHint = (event: PointerEvent | FocusEvent) => {
    const slot = (event.target as Element).closest<HTMLElement>('[data-hint]')
    setHintId(slot?.dataset.hint ?? null)
  }
  const slot = (id: string, node: ReactNode) => (
    <span className="fb-slot" data-hint={id}>
      {node}
    </span>
  )

  const pillClass = [
    'fb-pill',
    recording ? 'is-recording' : '',
    isPaused ? 'is-paused' : '',
    tool !== 'none' && recording && !paused ? `has-tool has-tool--${tool}` : ''
  ]
    .filter(Boolean)
    .join(' ')

  const divider = <span className="fb-pill__divider" aria-hidden="true" />

  return (
    <div className="fb-bar" data-testid="feedback-toolbar">
      <div
        className={pillClass}
        onPointerOver={pointHint}
        onPointerLeave={() => setHintId(null)}
        onFocus={pointHint}
        onBlur={() => setHintId(null)}
      >
        <span className="fb-status">
          {isPaused ? (
            <span className="fb-status__pause" aria-hidden="true">
              <span />
              <span />
            </span>
          ) : (
            <RecordDot active={recording} size={9} />
          )}
          <span className="fb-status__elapsed" data-testid="elapsed">
            {elapsed}
          </span>
          {isPaused && <span className="fb-status__badge">{t('feedback.paused')}</span>}
        </span>

        {captureMic ? (
          <MicLevel level={level} live={recording && !paused} />
        ) : (
          <span className="fb-mic is-off" role="img" aria-label={t('feedback.micOff')}>
            <MicOff size={15} strokeWidth={1.75} />
          </span>
        )}

        {divider}

        {onPickTarget && slot(
          'target',
          <IconButton
            label={t('feedback.pickTarget')}
            size="sm"
            className="fb-btn"
            disabled={recording || busy}
            onClick={onPickTarget}
            data-testid="feedback-target"
            icon={target.kind === 'screen' ? <Monitor size={18} strokeWidth={1.75} /> : target.kind === 'window' ? <AppWindow size={18} strokeWidth={1.75} /> : <Globe size={18} strokeWidth={1.75} />}
          />
        )}
        {slot(
          'record',
          <RecordButton
            compact
            recording={recording}
            disabled={busy}
            onClick={onToggleRecording}
            data-testid="feedback-record"
          />
        )}
        {slot(
          'pause',
          <IconButton
            label={paused ? t('feedback.resume') : t('feedback.pause')}
            size="sm"
            className={`fb-btn${isPaused ? ' fb-btn--resume' : ''}`}
            disabled={!recording || busy}
            onClick={onPause}
            icon={paused ? <Play size={18} strokeWidth={2} /> : <Pause size={18} strokeWidth={1.75} />}
          />
        )}

        {divider}

        {slot(
          'pen',
          <IconButton
            label={t('feedback.pen')}
            size="sm"
            className="fb-btn fb-btn--tool"
            disabled={toolsOff}
            selected={tool === 'pen'}
            onClick={() => pick('pen')}
            icon={<PenTool size={18} strokeWidth={1.75} />}
          />
        )}
        {slot(
          'text',
          <IconButton
            label={t('feedback.text')}
            size="sm"
            className="fb-btn fb-btn--tool"
            disabled={toolsOff}
            selected={tool === 'text'}
            onClick={() => pick('text')}
            icon={<Type size={18} strokeWidth={1.75} />}
          />
        )}
        {slot(
          'clear',
          <IconButton
            label={t('feedback.clear')}
            size="sm"
            className="fb-btn"
            disabled={toolsOff}
            onClick={onClear}
            icon={<Eraser size={18} strokeWidth={1.75} />}
          />
        )}

        {divider}

        {/* ふだんはページ名だけ（パスやフォルダは出さない。MODE-2）。指したボタンの案内に差し替わる */}
        <span className={`fb-hint${notice ? ' has-notice' : ''}`} title={notice ?? (hint ? undefined : state.url)}>
          {notice ? (
            <span className="fb-hint__notice" role="alert" data-testid="feedback-notice" key={notice}>
              <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
              <span className="fb-hint__notice-text">{notice}</span>
            </span>
          ) : hint ? (
            <span className="fb-hint__tip" key={hintId}>
              <span>{hint.label}</span>
              {hint.keys && <KeyCaps keys={hint.keys} />}
              {hint.note && <span className="fb-hint__note">{hint.note}</span>}
            </span>
          ) : (
            <span className="fb-hint__page">{page || t('feedback.noPage')}</span>
          )}
        </span>

        {divider}

        {slot(
          'editor',
          <IconButton
            label={t('feedback.toEditorMode')}
            size="sm"
            className="fb-btn"
            icon={<PanelsTopLeft size={18} strokeWidth={1.75} />}
            onClick={onBackToEditor}
            data-testid="back-to-editor"
          />
        )}
      </div>

      {/* よく使うキー。文字は出さず、記号とキーキャップだけ。幅が足りないときは隠す */}
      <div className="fb-keys" aria-hidden="true">
        {[
          { title: t('feedback.keyRecord'), icon: <span className="fb-keys__rec" />, keys: KEYS.record },
          { title: t('feedback.toEditorMode'), icon: <PanelsTopLeft size={14} strokeWidth={1.75} />, keys: KEYS.mode },
          { title: t('feedback.keyHoldPen'), icon: <PenTool size={14} strokeWidth={1.75} />, keys: KEYS.holdPen }
        ].map(({ title, icon, keys }) => (
          <span key={title} className="fb-keys__item" title={title}>
            {icon}
            <KeyCaps keys={keys} />
          </span>
        ))}
      </div>
    </div>
  )
}
