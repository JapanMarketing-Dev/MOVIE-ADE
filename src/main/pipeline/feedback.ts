/**
 * ④ feedback.md の生成（02_requirements.md 6章の形式）。
 * URL・要素・直前の操作は操作ログから機械的に付いた値（ItemContext）をそのまま書く。
 */
import type { FeedbackDocument, FeedbackItem, Quote, Speaker } from './types'
import { formatDuration, formatTimecode } from './text'
import { redactElementText, redactText, redactUrl } from './redact'
import { renderAgentPrompt } from '@shared/agentPrompt'
import { describeTargetUrl } from '@shared/preview'
import { groupByTarget, targetHeading, targetOfUrl, type ReviewTarget } from '@shared/reviewTarget'
import { getLocale, translate, type MessageParams, type SupportedLocale, type TranslationKey } from '@shared/i18n'

export interface RenderOptions {
  /** 「要確認」の指摘も書き出すか（既定: false。設計7章4で送信対象から外す） */
  includeNeedsCheck: boolean;
  /** 話者名を出すか。マイク1本に複数人（AUD-2後段）では false */
  showSpeakers: boolean
  /**
   * 取れなかったもの（Capture gaps）。
   * 「書かなければ何も起きなかったと主張したことになる」ため、分かっている欠落は必ず出す
   * （04_benchmark.md 3.9 / AREC）。
   */
  captureGaps: string[]
  /** 書き出す言語。省略時は画面の言語（文字起こしの言語とは別） */
  locale: SupportedLocale
}

const speakerKey: Record<Speaker, TranslationKey> = { self: 'feedbackMd.speaker.self', other: 'feedbackMd.speaker.other' }

export function renderFeedbackMarkdown(doc: FeedbackDocument, options: Partial<RenderOptions> = {}): string {
  const opt: RenderOptions = {
    includeNeedsCheck: false,
    showSpeakers: doc.meta.twoSpeakers,
    captureGaps: [],
    locale: getLocale(),
    ...options
  }
  const tr = (key: TranslationKey, params?: MessageParams): string => translate(opt.locale, key, params)

  const items = doc.items.filter((it) => it.include || (opt.includeNeedsCheck && it.status === 'needs_check'))

  const lines: string[] = []
  lines.push(`# ${tr('feedbackMd.title', { count: items.length })}`)
  // markdown / Mermaid のプレビュー（ade-preview://）は、Agent が直すファイルの相対パスで示す
  // 録画の途中で対象（URL・ファイル）を切り替えたら、指摘を対象ごとの節に分ける
  const groups = groupByTarget(items, (it) => it.context.url, doc.meta.urlPresets ?? [])
  const sectioned = groups.length > 1
  if (sectioned) lines.push(tr('feedbackMd.targets', { count: groups.length }))
  else if (doc.meta.targetUrl) lines.push(`- ${tr('feedbackMd.label.target')}: ${describeTargetUrl(doc.meta.targetUrl) ?? redactUrl(doc.meta.targetUrl)}`)
  lines.push(tr('feedbackMd.recorded', { at: formatRecordedAt(doc.meta.startedAt), duration: formatDuration(doc.meta.durationMs, opt.locale) }))
  lines.push(tr('feedbackMd.penNote'))
  lines.push(tr('feedbackMd.sttNote'))
  // NF-14 プロンプトインジェクションへの手当て。画面由来の文字列を指示として扱わせない
  lines.push(tr('feedbackMd.injectionNote'))
  lines.push(tr('feedbackMd.acceptanceNote'))
  if (!doc.organizedByLlm) {
    lines.push(tr('feedbackMd.ruleOnly'))
  } else {
    // 見出しと要望はLLMの整理結果（推論）であることを形式上はっきりさせる（AREC）
    lines.push(tr('feedbackMd.organized'))
  }
  if (doc.note) {
    lines.push('')
    lines.push(tr('feedbackMd.note', { note: doc.note }))
  }

  let n = 0
  if (sectioned) {
    groups.forEach((group, index) => {
      lines.push('')
      lines.push(...renderSection(group.target, index + 1, tr))
      for (const it of group.items) {
        n += 1
        lines.push('')
        // 節の下なので、指摘の見出しを1段下げる
        lines.push(...renderItem(it, n, opt, tr).map((line, i) => (i === 0 ? `#${line}` : line)))
      }
    })
  } else {
    for (const it of items) {
      n += 1
      lines.push('')
      lines.push(...renderItem(it, n, opt, tr))
    }
  }

  const skipped = doc.items.filter((it) => !it.include && it.status === 'needs_check').length
  const gaps = [...opt.captureGaps]
  if (!opt.includeNeedsCheck && skipped > 0) {
    gaps.push(tr('feedbackMd.skipped', { count: skipped }))
  }
  if (gaps.length > 0) {
    lines.push('')
    lines.push('---')
    lines.push(tr('feedbackMd.gapsHeading'))
    for (const g of gaps) lines.push(`- ${g}`)
  }

  return `${lines.join('\n')}\n`
}

type Tr = (key: TranslationKey, params?: MessageParams) => string

/** 対象の節の見出し。Agent がどのファイル・どの環境のURLへの指摘か分かるように書く */
function renderSection(target: ReviewTarget, n: number, tr: Tr): string[] {
  if (target.kind === 'none') return [`## ${tr('feedbackMd.sectionNone', { n })}`]
  // URL のクエリに秘密が入りうるので、見出しも伏せ字にした URL から作る（NF-14）
  const safeName = target.kind === 'url' && target.url ? targetOfUrl(redactUrl(target.url)).name : target.name
  const out = [`## ${tr('feedbackMd.section', { n, name: targetHeading({ ...target, name: safeName }) })}`]
  if (target.kind === 'file') out.push(tr('feedbackMd.sectionFile', { path: target.name }))
  else {
    if (target.label) out.push(tr('feedbackMd.sectionEnv', { label: target.label }))
    if (target.url) out.push(`- URL: ${redactUrl(target.url)}`)
  }
  return out
}

function renderItem(it: FeedbackItem, n: number, opt: RenderOptions, tr: Tr): string[] {
  const mark = it.status === 'needs_check' ? tr('feedbackMd.needsCheckMark') : ''
  const out: string[] = [`## ${n}. [${formatTimecode(it.t)}] ${mark}${it.title}`]

  if (it.request) out.push(tr('feedbackMd.request', { value: it.request }))
  // 受け入れ条件。要望から機械的に作る（要望が無ければ見出しから）。結論の出ていない指摘には付けない
  if (it.status !== 'needs_check') {
    out.push(it.request ? tr('feedbackMd.doneWhen', { request: it.request }) : tr('feedbackMd.doneWhenTitle', { title: it.title }))
  }
  if (it.quotes.length > 0) out.push(tr('feedbackMd.quotes', { value: renderQuotes(it.quotes, opt.showSpeakers, tr) }))
  if (it.images.length > 0) out.push(`- ${tr('feedbackMd.label.images')}: ${it.images.join(' / ')}`)

  const c = it.context
  if (c.url) {
    const vp = c.viewport !== undefined ? tr('feedbackMd.viewport', { px: c.viewport }) : ''
    out.push(`- URL: ${describeTargetUrl(c.url) ?? redactUrl(c.url)}${vp}`)
  }
  if (c.element) {
    const safe = redactElementText(c.element.text, {
      ...(c.element.sensitive !== undefined ? { sensitive: c.element.sensitive } : {}),
      selector: c.element.selector
    })
    const text = safe ? tr('feedbackMd.elementText', { text: safe }) : ''
    out.push(tr('feedbackMd.element', { selector: c.element.selector, text }))
  }
  if (c.priorOps) out.push(tr('feedbackMd.priorOps', { value: redactText(c.priorOps) }))

  return out
}

function renderQuotes(quotes: Quote[], showSpeakers: boolean, tr: Tr): string {
  return quotes
    .map((q) => {
      const text = q.text.trim()
      if (q.source === 'text') return tr('feedbackMd.quoteWritten', { text })
      return showSpeakers ? tr('feedbackMd.quoteSpeaker', { speaker: tr(speakerKey[q.speaker]), text }) : tr('feedbackMd.quote', { text })
    })
    .join(tr('feedbackMd.quoteSeparator'))
}

/** 「2026-10-02 10:40」形式。ISO文字列をローカル時刻で表示する */
function formatRecordedAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 送信時にターミナルへ入力する1行（02_requirements.md 6章・設計7章） */
export function renderSendCommand(sessionRelativeDir: string, template?: string | null, feedbackMd?: string): string {
  // 文面は設定（Settings.agentPrompt）と共通。空なら既定文（src/shared/agentPrompt.ts）。
  // 絶対パスを渡さなければ {{path}} も相対パスになる
  return renderAgentPrompt({ relativeDir: sessionRelativeDir, feedbackMd }, template)
}
