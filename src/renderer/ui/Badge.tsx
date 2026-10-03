import type { ReactNode } from 'react'

/**
 * バッジ。件数や状態の札。
 *   neutral … 既定
 *   brand   … 選ばれている・自分のもの
 *   success / warning / danger … 結果
 *   record  … 録画中（赤はここだけ）
 */
export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'record'

export function Badge({
  tone = 'neutral',
  icon,
  children,
  className
}: {
  tone?: BadgeTone
  icon?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <span className={['badge', `badge--${tone}`, className ?? ''].join(' ').trim()}>
      {icon}
      {children}
    </span>
  )
}

/** 数字だけの小さな丸。タブやボタンの右上に重ねる */
export function CountBadge({ count, tone = 'brand' }: { count: number; tone?: BadgeTone }) {
  if (count <= 0) return null
  return (
    <span className={`count-badge count-badge--${tone}`}>{count > 99 ? '99+' : count}</span>
  )
}
