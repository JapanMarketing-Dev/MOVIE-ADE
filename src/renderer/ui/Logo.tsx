import { useId } from 'react'
import { PRODUCT_NAME } from '@shared/i18n'
/**
 * ロゴマーク（フェレット）。
 *
 * 胴は「n」の字のアーチ（巣穴の入口の形）で、両端がそのまま脚になる。頭は右肩に載せ、
 * しっぽは左脚の外側から三日月で流す。穴にもぐって見つけ出すフェレットを、線の太さを揃えた図形だけで描く。
 * 色は currentColor なので、置いた場所の文字色に従い、ライト・ダークの両方で使える。
 * 形の正本は build/brand/ferret-mark.svg（32 グリッド）。アプリアイコン（build/icon.svg）も同じ形から作る。
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
  // 目は mask で抜く。同じ画面に複数置いても mask の id がぶつからないようにする
  const eye = `${useId()}-eye`
  return (
    <svg
      className={['logo', className ?? ''].join(' ').trim()}
      width={size}
      height={size}
      viewBox="0.2 1 32 32"
      fill="none"
      role="img"
      aria-label={PRODUCT_NAME}
    >
      <mask id={eye} maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
        <rect width="32" height="32" fill="#fff" />
        <circle cx="26.2" cy="12.4" r="1.05" fill="#000" />
      </mask>
      <g mask={`url(#${eye})`} fill="currentColor">
        <path d="M10 24V19A6.5 6.5 0 0 1 23 19V24" fill="none" stroke="currentColor" strokeWidth="3.8" strokeLinecap="round" />
        <path d="M21.2 11.6A4 4 0 0 1 28.4 11.2L30.6 14.4C29.2 16 26.4 16.4 24.2 15.6C21.8 14.8 20.6 13.4 21.2 11.6Z" />
        <circle cx="23" cy="9.6" r="1.5" />
        <path d="M8.4 16.6A8.6 8.6 0 0 1 1.8 24.9A6.6 6.6 0 0 0 8.4 22.6Z" />
      </g>
    </svg>
  )
}
