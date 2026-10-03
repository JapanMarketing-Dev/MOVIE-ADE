import type { ReactNode } from 'react'

/**
 * 枠線だけの小さな四角に、単色のアイコンを1つ載せる。
 * 一覧の先頭に置く「何の道具か」の印に使う。
 * 以前は道具ごとのグラデーションで塗っていたが、Orca に合わせて単色にした。
 * tone は互換のために受け取るだけで、見た目は変えない。
 */
export type IconTileTone = 'brand' | 'pen' | 'voice' | 'agent' | 'record'

export function IconTile({
  size = 'md',
  children
}: {
  tone?: IconTileTone
  size?: 'sm' | 'md' | 'lg'
  children: ReactNode
}) {
  return (
    <span className={`icon-tile icon-tile--${size}`} aria-hidden="true">
      {children}
    </span>
  )
}
