import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import { answerNote, answerOption, optionAnswer, type ChecklistItem, type ChecklistOption } from '@shared/humanChecklist'
import type { OrchestraRules } from '@shared/orchestrator'
import type { TranslationKey } from '@shared/i18n'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { useToast } from '../ui'

type T = ReturnType<typeof useT>

/**
 * 選択肢の無い項目にも、番号の頭の文字で決まった選択肢を出す（すべての項目を選んで答えられるように）。
 * 承認（A）・画面の確認（B）・人が用意するもの（P）・そのほか（決めること D・DESIGN-6 など）
 */
export function itemOptions(item: Pick<ChecklistItem, 'key' | 'options'>, t: T): ChecklistOption[] {
  if (item.options?.length) return item.options
  const list = (keys: TranslationKey[]): ChecklistOption[] => keys.map((k, i) => ({ n: i + 1, text: t(k), recommended: false }))
  if (/^A\d/.test(item.key)) return list(['orchestra.answerApprove', 'orchestra.answerReject'])
  if (/^B\d/.test(item.key)) return list(['orchestra.answerOk', 'orchestra.answerNg'])
  if (/^P\d/.test(item.key)) return list(['orchestra.answerDone', 'orchestra.answerLater', 'orchestra.answerCannot'])
  return list(['orchestra.answerGo', 'orchestra.answerHold', 'orchestra.answerStop'])
}

/**
 * 確認リストの1項目への答え（Claude Code の質問と同じ形）。番号の選択肢（おすすめは一番上）を押すか、欄に番号か自由な文を書いて Enter。
 * 選択肢を選んだあとに欄に書いた文は、その選択肢への補足になる（`1. 承認する — 金曜までに`）。
 * 答えは main が human.md の「## 回答」に書く（orchestra:answer）。送るのはダッシュボードの「回答をまとめて Agent に送る」
 */
export function ChecklistAnswer({ item, onSave, onAllow }: {
  item: ChecklistItem
  onSave: (key: string, answer: string) => Promise<void>
  /** 承認の項目を「今後は確認なしで進めてよい操作」に足す */
  onAllow?: (text: string) => void
}) {
  const t = useT()
  const options = itemOptions(item, t)
  const picked = answerOption({ options }, item.answer)
  const pickedOption = picked === null ? undefined : options.find((o) => o.n === picked)
  // 選択肢を選んでいれば欄はその補足、選んでいなければ自由な答え
  const freeText = !item.answer ? '' : picked === null ? item.answer : answerNote({ options }, item.answer)
  const [draft, setDraft] = useState(freeText)
  const focused = useRef(false)
  // 読み直しで答えが変わったら欄も合わせる（書いている途中は上書きしない）
  useEffect(() => { if (!focused.current) setDraft(freeText) }, [freeText])

  const save = (answer: string) => { void onSave(item.key, answer) }
  const commit = () => {
    const value = draft.trim()
    const n = /^\d{1,2}$/.test(value) ? Number(value) : null
    const option = n !== null ? options.find((o) => o.n === n) : undefined
    if (option) { setDraft(''); save(optionAnswer(option)); return }
    if (value === (freeText || '')) return
    save(pickedOption ? optionAnswer(pickedOption, value) : value)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return
    e.preventDefault()
    commit()
  }

  return <div className="checklist-answer" data-testid={`orchestra-answer-${item.key}`}>
    <div className="checklist-answer__options" role="group" aria-label={`${item.key} ${item.label}`.trim()}>
    {options.map((o) => <button key={o.n} type="button" className={`checklist-answer__option${picked === o.n ? ' is-picked' : ''}`} aria-pressed={picked === o.n}
      onClick={() => save(picked === o.n ? '' : optionAnswer(o, draft.trim()))} data-testid={`orchestra-answer-${item.key}-${o.n}`}>
      <span className="checklist-answer__num">{o.n}</span>{o.text}
      {o.recommended && <span className="checklist-answer__rec">{t('orchestra.answerRecommended')}</span>}
    </button>)}
    </div>
    <div className="checklist-answer__free">
    <input className="checklist-answer__input" value={draft} placeholder={pickedOption ? t('orchestra.answerPlaceholderNote') : t('orchestra.answerPlaceholderPick')} aria-label={t('orchestra.answerPlaceholder')}
      onFocus={() => { focused.current = true }} onBlur={() => { focused.current = false; commit() }}
      onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} data-testid={`orchestra-answer-input-${item.key}`} />
    {item.answer && <button type="button" className="checklist-answer__clear" title={t('orchestra.answerClear')} aria-label={t('orchestra.answerClear')} onClick={() => { setDraft(''); save('') }} data-testid={`orchestra-answer-clear-${item.key}`}>
      <X size={12} aria-hidden="true" />
    </button>}
    {onAllow && item.key.startsWith('A') && <button type="button" className="st-link checklist-answer__allow" title={t('orchestra.allowFromItemHint')}
      onClick={() => { onAllow([item.label && `[${item.label}]`, item.note].filter(Boolean).join(' ')); save(optionAnswer(options[0]!)) }} data-testid={`orchestra-answer-allow-${item.key}`}>
      {t('orchestra.allowFromItem')}
    </button>}
    </div>
  </div>
}

/**
 * 全体として人の確認なしで進めてよい操作（1行に1つ）。設定の orchestra.allowed に保存し、
 * 全体の CLAUDE.md / AGENTS.md・各 subagent に入る。答えをまとめて送るときにも添える
 */
export function AllowedOperations({ rules, onChange }: { rules: OrchestraRules; onChange: (next: OrchestraRules) => void }) {
  const t = useT()
  return <label className="pt-field orchestra__allowed">
    <span>{t('orchestra.allowedTitle')}</span>
    <textarea className="st-textarea" rows={3} value={rules.allowed ?? ''} placeholder={t('orchestra.allowedPlaceholder')} spellCheck={false}
      onChange={(e) => onChange({ ...rules, allowed: e.target.value })} data-testid="orchestra-allowed" />
  </label>
}

/**
 * 全体のルールを読み、確認なしで進めてよい操作だけを少し待ってまとめて保存する（保存すると全体の CLAUDE.md と subagent を書き直す）。
 * ほかのルールは送らない（設定の画面や Agent が書き換えた共通のルールを古い値で戻さない）
 */
export function useOrchestraRules(): [OrchestraRules | null, (next: OrchestraRules) => void] {
  const toast = useToast()
  const [rules, setRules] = useState<OrchestraRules | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    let cancelled = false
    void window.ade.invoke('app:settings').then((s) => { if (!cancelled) setRules(s.orchestra ?? {}) }).catch(() => { if (!cancelled) setRules({}) })
    return () => { cancelled = true }
  }, [])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const update = (next: OrchestraRules) => {
    setRules(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      void window.ade.invoke('settings:orchestraAllowed', next.allowed ?? '').catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
    }, 500)
  }
  return [rules, update]
}
