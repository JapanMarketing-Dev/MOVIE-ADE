import type { ReactNode } from 'react'

/**
 * 空状態。
 *
 * 何も無い画面は「失敗」ではなく「次にやることの案内」。
 * 見出しは、今できる動作をそのまま書く（「◯◯がありません」で終わらせない）。
 * 短い文とボタンだけにする。装飾の絵（art）は受け取っても描かない。
 */
export function EmptyState({
  title,
  description,
  actions,
  hints,
  size = 'md',
  className,
  testId
}: {
  /** 互換のために受け取るだけ。描かない */
  art?: ReactNode
  title: string
  description?: ReactNode
  actions?: ReactNode
  /** 下に並べる短い手がかり（ショートカットなど） */
  hints?: ReactNode
  size?: 'sm' | 'md'
  className?: string
  testId?: string
}) {
  return (
    <div
      className={['empty', `empty--${size}`, className ?? ''].join(' ').trim()}
      data-testid={testId}
    >
      <div className="empty__inner">
        <h2 className="empty__title">{title}</h2>
        {description != null && <p className="empty__description">{description}</p>}
        {actions != null && <div className="empty__actions">{actions}</div>}
        {hints != null && <div className="empty__hints">{hints}</div>}
      </div>
    </div>
  )
}
