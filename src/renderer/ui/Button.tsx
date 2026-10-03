import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Spinner } from './Progress'

/**
 * ボタン。
 *
 * variant で「どれくらい強く誘うか」を決める。1画面に primary は1つだけ。
 *   primary … 主要アクション。ブランドのグラデーションが出る唯一のボタン
 *   default … 通常
 *   ghost   … 控えめ。ツールバーの中など、並べても騒がしくならない
 *   danger  … 取り消せない操作
 *   record  … 録画。ブランドとは別系統の赤（REC-5 / NF-11）
 */
export type ButtonVariant = 'primary' | 'default' | 'ghost' | 'danger' | 'record'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant
  /** 文字の左に置くアイコン（lucide を 16px で） */
  icon?: ReactNode
  /** 処理中。スピナーに差し替わり、押せなくなる */
  busy?: boolean
  /** 選択状態（トグルとして使うとき）。aria-pressed も立てる */
  selected?: boolean
  /** E2Eが掴む印。ハイフン付きの属性は型に無いので明示的に受ける */
  'data-testid'?: string
  children?: ReactNode
}

export function Button({
  variant = 'default',
  icon,
  busy = false,
  selected,
  className,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={['btn', `btn--${variant}`, busy ? 'is-busy' : '', className ?? '']
        .join(' ')
        .trim()}
      disabled={disabled || busy}
      aria-pressed={selected}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Spinner size={14} /> : icon}
      {children != null && <span className="btn__label">{children}</span>}
    </button>
  )
}

/**
 * アイコンだけのボタン。
 * 文字が無いぶん、`label` を必ず受け取って読み上げと title に使う。
 * ツールチップを付けたいときは Tooltip で包む。
 */
export function IconButton({
  variant = 'ghost',
  label,
  icon,
  busy = false,
  selected,
  size = 'md',
  className,
  disabled,
  ...rest
}: Omit<ButtonProps, 'children' | 'icon'> & {
  label: string
  icon: ReactNode
  size?: 'sm' | 'md'
}) {
  return (
    <button
      type="button"
      className={[
        'btn',
        'btn--icon',
        `btn--${variant}`,
        size === 'sm' ? 'btn--icon-sm' : '',
        busy ? 'is-busy' : '',
        className ?? ''
      ]
        .join(' ')
        .trim()}
      disabled={disabled || busy}
      aria-label={label}
      aria-pressed={selected}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Spinner size={14} /> : icon}
    </button>
  )
}
