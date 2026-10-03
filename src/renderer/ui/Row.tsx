import type { ReactNode } from 'react'

/**
 * 一覧の行。指摘一覧・履歴・設定の項目をこれで組む。
 *
 * 選択中は、左端にブランドの線が伸びる（面を塗らない）。
 * 新しく現れた行は下から浮かび上がる — 分解が終わって指摘が並ぶ瞬間（EXT-2）が、
 * このアプリで一番うれしい瞬間なので、そこに動きを置いている。
 */
export function Row({
  leading,
  title,
  meta,
  description,
  trailing,
  selected = false,
  appear = false,
  onClick,
  className,
  testId
}: {
  /** 左端。サムネイル、アイコン、通し番号など */
  leading?: ReactNode
  title: ReactNode
  /** 題名の右の小さな情報（時刻・URLなど） */
  meta?: ReactNode
  description?: ReactNode
  trailing?: ReactNode
  selected?: boolean
  /** 現れる動きを付ける。Stagger と組み合わせて順番に出す */
  appear?: boolean
  onClick?: () => void
  className?: string
  testId?: string
}) {
  const interactive = onClick != null
  return (
    <div
      className={[
        'row',
        selected ? 'is-selected' : '',
        interactive ? 'is-interactive' : '',
        appear ? 'row--appear' : '',
        className ?? ''
      ]
        .join(' ')
        .trim()}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-current={selected || undefined}
      data-testid={testId}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onClick?.()
              }
            }
          : undefined
      }
    >
      {leading != null && <div className="row__leading">{leading}</div>}
      <div className="row__body">
        <div className="row__head">
          <span className="row__title">{title}</span>
          {meta != null && <span className="row__meta">{meta}</span>}
        </div>
        {description != null && <p className="row__description">{description}</p>}
      </div>
      {trailing != null && <div className="row__trailing">{trailing}</div>}
    </div>
  )
}

/** 区切られた箱。設定の節や、指摘のまとまりに使う */
export function Card({
  title,
  actions,
  children,
  className
}: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={['card', className ?? ''].join(' ').trim()}>
      {(title != null || actions != null) && (
        <header className="card__head">
          {title != null && <h3 className="card__title">{title}</h3>}
          {actions != null && <div className="card__actions">{actions}</div>}
        </header>
      )}
      <div className="card__body">{children}</div>
    </section>
  )
}
