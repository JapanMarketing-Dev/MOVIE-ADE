import type { InputHTMLAttributes, ReactNode, Ref } from 'react'

/**
 * 入力欄。
 * フォーカスするとブランドの線が縁に出る（「いま自分が触っている場所」）。
 * 先頭のアイコンと末尾の補助表示を取れるようにして、URL欄も指摘の編集欄も同じ形で作る。
 */
export function Field({
  icon,
  trailing,
  invalid = false,
  className,
  inputClassName,
  mono = false,
  ref,
  'data-testid': testId,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  icon?: ReactNode
  trailing?: ReactNode
  invalid?: boolean
  /** URLやコードなど、等幅で読みたい値 */
  mono?: boolean
  inputClassName?: string
  /** React 19 では ref をそのまま props で受け取れる */
  ref?: Ref<HTMLInputElement>
  /** E2Eが掴む印。ハイフン付きの属性は型に無いので明示的に受ける */
  'data-testid'?: string
}) {
  return (
    <div
      className={['field', invalid ? 'is-invalid' : '', className ?? ''].join(' ').trim()}
      data-disabled={rest.disabled || undefined}
    >
      {icon != null && <span className="field__icon">{icon}</span>}
      <input
        ref={ref}
        className={['field__input', mono ? 'field__input--mono' : '', inputClassName ?? '']
          .join(' ')
          .trim()}
        spellCheck={false}
        aria-invalid={invalid || undefined}
        data-testid={testId}
        {...rest}
      />
      {trailing != null && <span className="field__trailing">{trailing}</span>}
    </div>
  )
}
