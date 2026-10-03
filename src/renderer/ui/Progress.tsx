import type { ReactNode } from 'react'

/**
 * 処理中の表示。
 * どれも transform / opacity だけで動かす（レイアウトを起こさない）。
 */

/** 小さい回転。ボタンの中や行の末尾に置く */
export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <span
      className="spinner"
      style={{ width: size, height: size }}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  )
}

/**
 * 進行表示。
 * value を渡すと確定（0〜1）、省略すると不定（ブランドの線が往復する）。
 */
export function Progress({ value, label }: { value?: number; label?: string }) {
  const determinate = typeof value === 'number'
  return (
    <div
      className={`progress${determinate ? '' : ' progress--indeterminate'}`}
      role="progressbar"
      aria-label={label}
      aria-valuenow={determinate ? Math.round(value * 100) : undefined}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
    >
      <span
        className="progress__bar"
        style={determinate ? { transform: `scaleX(${Math.min(1, Math.max(0, value))})` } : undefined}
      />
    </div>
  )
}

/**
 * 文章の代わりに置く骨組み。一覧を読み込んでいる間に使う。
 * 行の形だけ見せて、文字が入る場所を先に確保する。
 */
export function Skeleton({ width, height = 12 }: { width?: number | string; height?: number }) {
  return <span className="skeleton" style={{ width: width ?? '100%', height }} aria-hidden="true" />
}

/**
 * 録画中であることを示す点（REC-5 / NF-11）。
 * ブランドの動き（素早い ease-out）とは別に、ゆっくりした呼吸にして、
 * 画面共有の相手にも「録っている」と伝わるようにする。
 */
export function RecordDot({ active = false, size = 8 }: { active?: boolean; size?: number }) {
  return (
    <span
      className={`record-dot${active ? ' record-dot--active' : ''}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  )
}

/** 一覧の行などを、順番に現れさせるための入れ物 */
export function Stagger({ children, step = 28 }: { children: ReactNode[]; step?: number }) {
  return (
    <>
      {children.map((child, index) => (
        <div
          // 並びは呼び出し側が決める。ここは出現の遅延を付けるだけ
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          className="stagger__item"
          style={{ animationDelay: `${Math.min(index, 12) * step}ms` }}
        >
          {child}
        </div>
      ))}
    </>
  )
}
