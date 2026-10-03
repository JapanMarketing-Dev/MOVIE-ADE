import { PRODUCT_NAME } from '@shared/i18n'
/**
 * ロゴマーク。
 *
 * 四隅のかぎ括弧（画面の一部を「囲む」）と、中央の点（録る）だけの単色の図形。
 * 色は currentColor なので、置いた場所の文字色に従い、ライト・ダークの両方で使える。
 * アプリアイコン（build/icon.svg）も同じ図形から作る。
 */
export function Logo({
  size = 20,
  className
}: {
  size?: number
  /** 互換のために受け取るだけ。動きは付けない */
  animated?: boolean
  className?: string
}) {
  return (
    <svg
      className={['logo', className ?? ''].join(' ').trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-label={PRODUCT_NAME}
    >
      <path
        d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="square"
      />
      <rect x="9" y="9" width="6" height="6" fill="currentColor" />
    </svg>
  )
}
