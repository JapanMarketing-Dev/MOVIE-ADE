import type { ReactNode } from 'react'

/**
 * セグメント切替（PC｜スマホ、エディタ｜フィードバック）。
 *
 * 選択中の背景は1枚の「つまみ」を transform で動かして表現する。
 * 項目ごとに背景を付け外しすると、切り替えが瞬間的で、どちらへ動いたか分からない。
 */
export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: ReactNode
  title?: string
  /** data-testid。E2Eが掴む */
  testId?: string
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className
}: {
  options: ReadonlyArray<SegmentedOption<T>>
  value: T
  onChange: (value: T) => void
  ariaLabel: string
  className?: string
}) {
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value)
  )

  return (
    <div
      className={['segmented', className ?? ''].join(' ').trim()}
      role="group"
      aria-label={ariaLabel}
      style={{ '--segmented-count': options.length } as React.CSSProperties}
    >
      {/* 選択中を示すつまみ。項目の下を滑る */}
      <span
        className="segmented__thumb"
        style={{ transform: `translateX(${index * 100}%)` }}
        aria-hidden="true"
      />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="segmented__item"
          aria-pressed={option.value === value}
          title={option.title}
          data-testid={option.testId}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  )
}
