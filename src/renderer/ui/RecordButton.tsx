import { Square } from 'lucide-react'
import { formatShortcut } from '../lib/shortcut'
import { useT } from '../lib/i18n'

/**
 * 録画ボタン。この画面で最も目立つ主要アクション。
 *
 * 2つの役目を1つのボタンで兼ねるため、状態で色の系統を変える:
 *   押す前 … 録画のグラデーション（赤→橙）で塗り、うっすら光らせる（「ここから始める」）
 *   録画中 … 暗い地に赤い縁と赤い停止記号。ゆっくり呼吸させる（REC-5 / NF-11。赤は録画専用）
 * 押す前と録画中で「塗り」と「縁」を入れ替え、色が同じ赤でも一目で区別できるようにする。
 *
 * フィードバックモードの浮いたツールバーでも同じ部品を使う（compact）。
 */
export function RecordButton({
  recording,
  compact = false,
  disabled = false,
  onClick,
  'data-testid': testId
}: {
  recording: boolean
  /** フィードバックモードの細いツールバー用 */
  compact?: boolean
  disabled?: boolean
  onClick?: () => void
  'data-testid'?: string
}) {
  const t = useT()
  return (
    <button
      type="button"
      className={[
        'record-btn',
        recording ? 'is-recording' : '',
        compact ? 'record-btn--compact' : ''
      ]
        .join(' ')
        .trim()}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={recording}
      title={`${recording ? t('record.stop') : t('record.start')} (${formatShortcut('Mod', 'Shift', 'R')})`}
      data-testid={testId}
    >
      <span className="record-btn__mark" aria-hidden="true">
        {recording ? <Square size={9} strokeWidth={0} fill="currentColor" /> : null}
      </span>
      <span className="record-btn__label">{recording ? t('record.buttonStop') : t('record.buttonRecord')}</span>
    </button>
  )
}
