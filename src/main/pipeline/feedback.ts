/**
 * ④ feedback.md の生成（02_requirements.md 6章の形式）。
 * URL・要素・直前の操作は操作ログから機械的に付いた値（ItemContext）をそのまま書く。
 */
import type { FeedbackDocument, FeedbackItem, Quote, Speaker } from './types'
import { basename, join } from 'node:path'
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
  /**
   * 判定モデルでの受け入れ確認（設定で有効なときだけ）。各指摘に BEFORE の画像の絶対パスを書き、末尾に手順の節を足す。
   * dir はレビューのフォルダ（絶対パス）。キーは書かない（Agent には中継の URL が環境変数で渡る）
   */
  decision?: { threshold: number; dir: string } | null
  /**
   * 進み具合を書くファイル（progress.json の絶対パス）。Agent が作業しながら指摘のIDごとに書き、Ferret が画面に出す。
   * 省略時は「このファイルと同じフォルダの progress.json」と書く
   */
  progressFile?: string
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

  if (items.length > 0) lines.push('', ...renderProgress(opt, tr))
  if (opt.decision) lines.push('', ...renderDecisionCheck(opt.decision.threshold, tr))

  return `${lines.join('\n')}\n`
}

/**
 * 判定モデルへ送る問い（JSON）。shell の単一引用符で囲めるよう、文に ' を入れない。
 * test/unit/decision.test.ts が JSON として読めることを確かめる
 */
export const DECISION_QUESTIONS_JSON = JSON.stringify({
  done: {
    type: 'noul',
    instructions: 'Is the requested change visibly implemented in the AFTER image compared to BEFORE?',
    criteria: { false: 'The AFTER screen does not show the requested change.', true: 'The AFTER screen clearly shows the requested change where the finding points.' }
  },
  status: {
    type: 'choice',
    instructions: 'How far is the finding implemented on the AFTER screen, judged against its Done when line?',
    criteria: {
      done: 'Fully implemented: the AFTER screen meets the Done when line.',
      partial: 'Some of the requested change is visible, but not all of it.',
      not_done: 'The relevant area is unchanged or still has the reported problem.',
      cannot_tell: 'The relevant area is not visible, or the evidence is not enough.'
    }
  }
})

/**
 * 依頼の本文を作る node の1行（macOS / Linux / Windows で同じ）。画像は FERRET_DECISION_IMAGES=1 のときだけ。
 * FERRET_DECISION_IMAGE_FORMAT=data-uri なら data:image/…;base64, を付ける（Cloudflare Workers AI は data URI でないと 422）
 */
export const DECISION_NODE_LINE = `node -e 'const f=require("fs"),e=process.env,b={model:e.FERRET_DECISION_MODEL,state:e.STATE,questions:JSON.parse(e.Q)};if(e.FERRET_DECISION_IMAGES==="1")b.images=[e.BEFORE,e.AFTER].map(p=>{const s=f.readFileSync(p).toString("base64");return e.FERRET_DECISION_IMAGE_FORMAT==="data-uri"?"data:image/"+(/\\.png$/i.test(p)?"png":"jpeg")+";base64,"+s:s});f.writeFileSync("req.json",JSON.stringify(b))'`

/** feedback.md の末尾の受け入れ確認の節。全件が同じ回で合格するまで、判定と修正を繰り返させる */
function renderDecisionCheck(threshold: number, tr: Tr): string[] {
  const p = { threshold: String(threshold) }
  return [
    '---',
    `## ${tr('feedbackMd.check.heading')}`,
    tr('feedbackMd.check.intro'),
    '',
    tr('feedbackMd.check.capture'),
    tr('feedbackMd.check.judge'),
    tr('feedbackMd.check.imageFormat'),
    tr('feedbackMd.check.pass', p),
    tr('feedbackMd.check.loop'),
    tr('feedbackMd.check.progress'),
    '',
    tr('feedbackMd.check.rules'),
    tr('feedbackMd.check.exits'),
    tr('feedbackMd.check.report'),
    '',
    tr('feedbackMd.check.snippet'),
    '```sh',
    'STATE=\'<title> / <request> / Done when: <...>\' BEFORE=/abs/path/01.png AFTER=/abs/path/after-01.png',
    `export STATE BEFORE AFTER Q='${DECISION_QUESTIONS_JSON}'`,
    DECISION_NODE_LINE,
    'curl -sS -X POST "$FERRET_DECISION_URL" -H \'content-type: application/json\' --data-binary @req.json',
    '```',
    tr('feedbackMd.check.windows'),
    '',
    tr('feedbackMd.check.imageSize')
  ]
}

type Tr = (key: TranslationKey, params?: MessageParams) => string

/**
 * 進み具合の節。Ferret は直ったかを判定しないので、Agent に指摘のIDごとに progress.json へ書かせる。
 * 受け入れ確認（判定モデル）が有効なら、合格してから done にさせる（受け入れ確認の節と食い違わないように）
 */
function renderProgress(opt: RenderOptions, tr: Tr): string[] {
  const path = opt.progressFile ?? tr('feedbackMd.progress.sameFolder')
  return [
    '---',
    `## ${tr('feedbackMd.progress.heading')}`,
    tr('feedbackMd.progress.intro', { path }),
    tr('feedbackMd.progress.format'),
    tr('feedbackMd.progress.when'),
    // 未完了の指摘はサブエージェントなどで並列に。前提が合わない指摘は直さずに人間へ戻させる（needs_human）
    tr('feedbackMd.progress.parallel'),
    tr('feedbackMd.progress.needsHuman'),
    ...(opt.decision ? [tr('feedbackMd.progress.decision'), tr('feedbackMd.progress.decisionNeedsHuman')] : [])
  ]
}

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
  // 進み具合（progress.json）のキー。番号は編集で振り直すので、変わらない ID を書く
  out.push(tr('feedbackMd.findingId', { id: it.id }))

  if (it.request) out.push(tr('feedbackMd.request', { value: it.request }))
  // 受け入れ条件。要望から機械的に作る（要望が無ければ見出しから）。結論の出ていない指摘には付けない
  if (it.status !== 'needs_check') {
    out.push(it.request ? tr('feedbackMd.doneWhen', { request: it.request }) : tr('feedbackMd.doneWhenTitle', { title: it.title }))
  }
  if (it.quotes.length > 0) out.push(tr('feedbackMd.quotes', { value: renderQuotes(it.quotes, opt.showSpeakers, tr) }))
  if (it.images.length > 0) out.push(`- ${tr('feedbackMd.label.images')}: ${it.images.join(' / ')}`)
  // 受け入れ確認で判定モデルへ送る BEFORE（注釈付きの静止画）。Agent がどこから読んでも開けるよう絶対パスで書く
  const before = opt.decision ? it.images.find((name) => /^\.\/\d+\.png$/.test(name)) : undefined
  if (opt.decision && before) out.push(tr('feedbackMd.beforeImage', { path: join(opt.decision.dir, basename(before)) }))

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
