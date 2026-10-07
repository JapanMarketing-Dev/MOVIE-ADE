/**
 * Agent への依頼文（設定の「Agent への依頼」）。人が良い依頼をするための、よく使う依頼の雛形。
 * Ferret はコーディング Agent の邪魔をしない：機能として作業を肩代わりせず、ボタンを押すとこの文を Agent に送るだけ。
 *
 * - 組み込みの依頼文（記憶の整理 dream・コンパクト化・セキュリティ・SEO・分析・Sentry のクラッシュ・Sentry / GA / Search Console / インフラの登録・
 *   性能・アクセシビリティ・依存関係）と、利用者が足した依頼文。接続とログインは全体で1回、設定はプロダクトごと
 * - 文面は編集できる（組み込みは変えた分だけ保存し、「既定に戻す」で戻る）
 * - 選んだものをまとめて1つの依頼にできる。毎日・毎週の定期にもできる（Agent が手すきのときに main が送る）
 * - オーケストレーターから送ると、すべてのプロダクトに subagent で並行して行うよう添える
 * Electron に依存しない純粋な処理だけを置く（送るのは src/main/agentRequests.ts）。
 */

export type AgentRequestSchedule = 'off' | 'daily' | 'weekly'
export const AGENT_REQUEST_SCHEDULES: readonly AgentRequestSchedule[] = ['off', 'daily', 'weekly']
export type RequestLanguage = 'ja' | 'en'

/** 保存する形（settings.json の agentRequests） */
export interface AgentRequestPrefs {
  /** 組み込みの変更分と、利用者が足した依頼文（custom）。並びは組み込み → 足したもの */
  items: AgentRequestItemPrefs[]
  /** 定期の依頼を最後に送った時刻（ISO8601） */
  lastRunAt?: Record<string, string>
}

export interface AgentRequestItemPrefs {
  id: string
  /** 足した依頼文の名前（組み込みは画面の言語の名前を使う） */
  title?: string
  /** 変えた文面。無ければ組み込みの文面 */
  text?: string
  schedule?: AgentRequestSchedule
  /** 「まとめて送る」に入れる */
  batch?: boolean
  /** 利用者が足した依頼文 */
  custom?: true
}

/** 画面に出す1件（組み込みと変更分を合わせたもの） */
export interface AgentRequest {
  id: string
  title: string
  text: string
  schedule: AgentRequestSchedule
  batch: boolean
  custom: boolean
  /** 組み込みの文面から変えている */
  edited: boolean
}

export const MAX_REQUEST_CHARS = 6000
const MAX_TITLE_CHARS = 80
const MAX_ITEMS = 50

type Builtin = { id: string; title: Record<RequestLanguage, string>; text: Record<RequestLanguage, string> }

/** どの依頼にも付ける決まり（Agent は人に質問しない・結果は短く） */
const CLOSING: Record<RequestLanguage, string> = {
  ja: '進め方は任せます。途中で人に質問せず、判断に迷う点は理由を添えて選んでください。最後に、やったこと・確かめたこと・残したことを短く報告してください。',
  en: 'Use your judgment on how to proceed. Do not stop to ask questions; when unsure, choose and note why. End with a short report: what you did, how you checked it, and what is left.'
}

export const BUILTIN_REQUESTS: readonly Builtin[] = [
  {
    id: 'dream',
    title: { ja: '記憶を整理する（dream）', en: 'Tidy up memory (dream)' },
    text: {
      ja: [
        'このプロジェクトの記憶（CLAUDE.md・AGENTS.md・メモリのフォルダ・docs の決まりごとなど、Agent が毎回読むもの）を整理してください。記憶は会話のまとめではなく、作業から学んだ教訓です。',
        '1. 統合：重なっているメモを1つにまとめる。',
        '2. 刈り込み：一時的な細部と、最近の作業で使われていない古い記録を外す。',
        '3. 発見：最近の会話・コミット・レビューの指摘から、まだ書かれていない役に立つ教訓を拾って、短いメモにする。',
        '4. 索引：次の作業で必要なものが見つけやすいよう、メモと索引（MEMORY.md など）を並べ直す。',
        '人が明示した好み・決まりと、出どころ（どの作業で学んだか）は必ず残し、矛盾するものは新しいほうに揃えて理由を書いてください。手順の決まりは skill、文脈は記憶、と分けてください。'
      ].join('\n'),
      en: [
        'Tidy up this project\'s memory (CLAUDE.md, AGENTS.md, memory folders, rules in docs: what agents read every time). Memories are lessons learned from the work, not summaries of conversations.',
        '1. Consolidate: merge overlapping notes into one.',
        '2. Prune: remove transient details and stale records that recent work has not used.',
        '3. Discover: from recent conversations, commits and review findings, pick up useful lessons not yet written down, as short notes.',
        '4. Index: reorganize the notes and their index (MEMORY.md and the like) so the next task finds what it needs.',
        'Always keep explicit preferences and rules from people and the source of each lesson; resolve contradictions toward the newer one and note why. Keep procedures in skills and context in memory.'
      ].join('\n')
    }
  },
  {
    id: 'compact',
    title: { ja: '指示の文章をコンパクトにする', en: 'Compact the instructions' },
    text: {
      ja: [
        'Agent 向けの文章（CLAUDE.md・AGENTS.md・skills・メモリ・README の決まりごと）が長くなりすぎています。中身を落とさずに抽象化して、短くしてください。',
        '- 重複と言い換えを1つにする。個別の事例が続くところは、それらを含む原則1つにまとめる（代表の例だけ残す）。',
        '- 人が明示した決まり・禁止事項・数値の上限・パスやコマンドは、言葉を変えずに残す。',
        '- 古くなった記述は今のコードと照らして直すか外す。',
        '- 目安は今の半分以下。終わったら、外したもの・まとめたものの一覧を短く示してください。'
      ].join('\n'),
      en: [
        'The agent-facing text (CLAUDE.md, AGENTS.md, skills, memory, rules in README) has grown too long. Abstract and shorten it without losing substance.',
        '- Merge duplicates and rephrasings. Where specific cases pile up, replace them with one principle that covers them (keep one representative example).',
        '- Keep explicit rules, prohibitions, numeric limits, paths and commands from people word for word.',
        '- Check outdated statements against the current code and fix or remove them.',
        '- Aim for half the current length or less. Finish with a short list of what you removed and what you merged.'
      ].join('\n')
    }
  },
  {
    id: 'security',
    title: { ja: 'セキュリティチェック（あらゆる観点）', en: 'Security check (every angle)' },
    text: {
      ja: [
        'このプロジェクトをあらゆる観点でセキュリティチェックし、見つけたものを直してください。',
        '観点：認証・認可と権限の昇格／入力の検証とインジェクション（SQL・コマンド・パス・テンプレート・XSS・SSRF・逆シリアル化）／秘密情報（鍵・トークンの混入、ログ・エラー・クライアントへの漏れ）／暗号と乱数／セッション・CSRF・CORS・Cookie／ファイルの扱い（パス・リンク・アップロード・一時ファイル）／外への通信と取得の上限（DoS・量の上限・タイムアウト）／依存関係とサプライチェーン（既知の脆弱性・固定されていない版・インストールのスクリプト）／インフラと設定（IaC・CI の権限・公開の範囲・既定の設定）／個人情報とプライバシー／ログと監視／クライアント側（Electron・ブラウザ拡張・モバイルなら、その特有の権限と境界）。',
        '各指摘は、攻撃の筋道を具体的に確かめてから直す（推測だけで直さない）。重大度の高い順に、直したものには再発を止めるテストを足してください。直せないものは、理由と影響を書いて残してください。'
      ].join('\n'),
      en: [
        'Run a security check of this project from every angle and fix what you find.',
        'Angles: authentication, authorization and privilege escalation; input validation and injection (SQL, command, path, template, XSS, SSRF, deserialization); secrets (keys and tokens in the repo, leaks through logs, errors or the client); crypto and randomness; sessions, CSRF, CORS, cookies; file handling (paths, links, uploads, temp files); outbound requests and limits (DoS, size limits, timeouts); dependencies and supply chain (known vulnerabilities, unpinned versions, install scripts); infrastructure and configuration (IaC, CI permissions, exposure, defaults); personal data and privacy; logging and monitoring; client-side boundaries (Electron, browser extensions, mobile permissions where relevant).',
        'Confirm a concrete attack path before fixing anything (no fixes on speculation). Go from most to least severe, and add a test that stops each fixed issue from coming back. For anything you cannot fix, write down why and the impact.'
      ].join('\n')
    }
  },
  {
    id: 'seo',
    title: { ja: 'SEO を直す', en: 'Fix SEO' },
    text: {
      ja: 'このプロジェクトの公開ページの SEO を点検して直してください。title・description・見出しの構造・canonical・OGP と X のカード・構造化データ（JSON-LD）・sitemap.xml と robots.txt・多言語なら hreflang・リンク切れ・画像の alt・表示速度（Core Web Vitals）・モバイル表示・インデックスさせないページの指定。検索で見つけてほしいページごとに、狙う言葉と中身が合っているかも確かめてください。',
      en: 'Audit and fix SEO for this project\'s public pages: titles, descriptions, heading structure, canonical URLs, Open Graph and X cards, structured data (JSON-LD), sitemap.xml and robots.txt, hreflang for multilingual pages, broken links, image alt text, speed (Core Web Vitals), mobile rendering, and which pages must not be indexed. For each page meant to be found by search, check that its content matches the terms it targets.'
    }
  },
  {
    id: 'analytics',
    title: { ja: '分析（計測）を直す', en: 'Fix analytics' },
    text: {
      ja: 'このプロジェクトの分析（計測）を点検して直してください。大事な流れ（登録・ログイン・主要な操作・課金・離脱しやすい所）のイベントが漏れなく・重複なく送られているか、名前と属性が揃っているか、ファネルとして追えるか。個人情報・秘密情報を送っていないか、同意（Cookie・オプトアウト）と開発・テスト環境の除外が効いているか。直したら、実際にイベントが届くことを確かめてください。',
      en: 'Audit and fix analytics in this project. Check that events for the key flows (sign-up, login, main actions, payments, drop-off points) fire exactly once, with consistent names and properties, and can be followed as funnels. Make sure no personal or secret data is sent, consent (cookies, opt-out) is respected, and development and test environments are excluded. After fixing, confirm the events actually arrive.'
    }
  },
  {
    id: 'sentry',
    title: { ja: 'Sentry のエラー・クラッシュを直す', en: 'Fix Sentry errors and crashes' },
    text: {
      ja: 'Sentry（使っていればその CLI か API）で、このプロジェクトの未解決の issue・新しいエラー・クラッシュを、影響の大きい順に調べて直してください。各 issue について、スタック・パンくず・リリース・環境から原因を特定し、再現するテストを書いてから直す。想定内のもの（中断・利用者の操作）は送らないようにし、送る情報に個人情報が入っていないかも確かめる。直したものは次のリリースで解決の扱いにしてください（本番の設定は変えない）。',
      en: 'Using Sentry (its CLI or API if available), investigate this project\'s unresolved issues, new errors and crashes, highest impact first, and fix them. For each issue, find the cause from the stack, breadcrumbs, release and environment, write a test that reproduces it, then fix it. Stop reporting expected cases (aborts, user actions), and check that no personal data is sent. Mark fixed issues as resolved in the next release (do not change production settings).'
    }
  },
  {
    id: 'sentry-setup',
    title: { ja: 'Sentry を登録する', en: 'Set up Sentry' },
    text: {
      ja: 'Sentry でエラーとクラッシュを受け取れるようにしてください。Sentry の CLI・ログイン・組織への接続は全体で1回だけ行い、各プロダクトでは、そのプロダクト用の Sentry のプロジェクトを作る（あれば使う）・SDK と DSN を組み込む・リリース名と環境（本番・開発）を付ける・ソースマップを上げる・個人情報を送らない設定にする、をプロダクトごとに行ってください。DSN などの値は各プロダクトの環境変数に置き、ほかのプロダクトと混ぜないでください。最後にテストのエラーを1件送って届くことを確かめ、送ったものは解決にしてください。',
      en: 'Make errors and crashes reach Sentry. Connect the Sentry CLI, login and organization once for everything; then, per product, create (or reuse) that product\'s Sentry project, add the SDK and DSN, set the release name and environments (production, development), upload source maps, and turn off sending personal data. Keep the DSN and other values in each product\'s own environment variables, never shared between products. Finally send one test error to confirm it arrives, then resolve it.'
    }
  },
  {
    id: 'analytics-setup',
    title: { ja: 'Google Analytics を入れる', en: 'Set up Google Analytics' },
    text: {
      ja: 'Google Analytics（GA4）で計測できるようにしてください。Google のアカウントへの接続は全体で1回だけ行い、各プロダクトでは、そのプロダクト用のプロパティとデータストリームを作る（あれば使う）・計測 ID をそのプロダクトの設定に置く・大事な操作のイベントを送る・同意（Cookie）と開発環境の除外を入れる、をプロダクトごとに行ってください。計測 ID はプロダクトごとに分け、混ぜないでください。最後にリアルタイムのレポートで届くことを確かめてください。',
      en: 'Set up Google Analytics (GA4). Connect the Google account once for everything; then, per product, create (or reuse) that product\'s property and data stream, put the measurement ID in that product\'s config, send events for the key actions, and add consent (cookies) and the exclusion of development environments. Keep measurement IDs separate per product. Finally confirm the data arrives in the realtime report.'
    }
  },
  {
    id: 'search-console',
    title: { ja: 'Search Console に登録する', en: 'Register in Search Console' },
    text: {
      ja: 'Google Search Console に登録してください。Google のアカウントへの接続は全体で1回だけ行い、公開しているプロダクトごとに、そのドメインのプロパティを作る（あれば使う）・所有権を確認する（DNS か HTML のファイル）・sitemap.xml を送る・robots.txt とインデックスさせないページを確かめる、を行ってください。公開していないプロダクトは飛ばし、理由を書いてください。',
      en: 'Register with Google Search Console. Connect the Google account once for everything; then, for each public product, create (or reuse) the property for its domain, verify ownership (DNS or HTML file), submit sitemap.xml, and check robots.txt and the pages that must not be indexed. Skip products that are not public and say why.'
    }
  },
  {
    id: 'infra',
    title: { ja: 'インフラを登録・確かめる', en: 'Register and check infrastructure' },
    text: {
      ja: 'インフラを登録して確かめてください。クラウドの CLI・ログイン・アカウントへの接続は全体で1回だけ行い、各プロダクトでは、そのプロダクトのインフラ（アカウント・プロジェクト・リージョン・インスタンス・DB・ドメイン・タグ・秘密情報・CI/CD）を一覧にし、足りないものを作り、タグと名前の付け方を揃えてください。インフラはプロダクトごとに分け、ほかのプロダクトと共有しないでください。費用と公開の範囲（外から見えるもの）も確かめてください。',
      en: 'Register and check the infrastructure. Connect the cloud CLIs, logins and accounts once for everything; then, per product, list that product\'s infrastructure (account, project, region, instances, databases, domains, tags, secrets, CI/CD), create what is missing, and make tags and names consistent. Keep infrastructure separate per product, never shared with other products. Also check costs and what is exposed to the outside.'
    }
  },
  {
    id: 'performance',
    title: { ja: '性能を直す', en: 'Fix performance' },
    text: {
      ja: 'このプロジェクトの遅いところを測ってから直してください。起動・初回表示・よく使う操作・大きなデータ・重いクエリ（N+1・索引）・バンドルの大きさ・メモリの増え続け。直す前と後の数値を並べ、効果の無い変更は戻してください。',
      en: 'Measure, then fix, what is slow in this project: startup, first render, frequent actions, large data, heavy queries (N+1, indexes), bundle size, growing memory. Show numbers before and after each change and revert changes that do not help.'
    }
  },
  {
    id: 'accessibility',
    title: { ja: 'アクセシビリティを直す', en: 'Fix accessibility' },
    text: {
      ja: 'このプロジェクトの画面のアクセシビリティを点検して直してください。キーボードだけでの操作とフォーカスの見え方・スクリーンリーダーでの名前と役割（ARIA）・色のコントラスト・文字の拡大・動きを減らす設定・フォームのラベルとエラー表示。WCAG 2.2 AA を目安にしてください。',
      en: 'Audit and fix accessibility in this project\'s screens: keyboard-only use and visible focus, names and roles for screen readers (ARIA), color contrast, text zoom, reduced motion, form labels and error messages. Use WCAG 2.2 AA as the bar.'
    }
  },
  {
    id: 'dependencies',
    title: { ja: '依存関係を更新する', en: 'Update dependencies' },
    text: {
      ja: 'このプロジェクトの依存関係を更新してください。既知の脆弱性があるものを先に、次に古くなったもの。大きな版の更新は変更点を読んで、使っている所を直してから。ロックファイルを揃え、テストとビルドが通ることを確かめてください。使っていない依存は外してください。',
      en: 'Update this project\'s dependencies: those with known vulnerabilities first, then outdated ones. For major versions, read the changes and fix the code that uses them. Keep the lockfile consistent, make sure tests and the build pass, and remove unused dependencies.'
    }
  }
]

function str(value: unknown): value is string {
  return typeof value === 'string'
}

export function sanitizeAgentRequestPrefs(raw: unknown): AgentRequestPrefs | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Partial<AgentRequestPrefs>
  const seen = new Set<string>()
  const items = (Array.isArray(r.items) ? r.items : []).slice(0, MAX_ITEMS).flatMap((item): AgentRequestItemPrefs[] => {
    if (!item || typeof item !== 'object') return []
    const i = item as Partial<AgentRequestItemPrefs>
    if (!str(i.id) || !/^[\w-]{1,64}$/.test(i.id) || seen.has(i.id)) return []
    const custom = i.custom === true
    if (!custom && !BUILTIN_REQUESTS.some((b) => b.id === i.id)) return []
    seen.add(i.id)
    const title = str(i.title) ? i.title.trim().slice(0, MAX_TITLE_CHARS) : undefined
    const text = str(i.text) ? i.text.slice(0, MAX_REQUEST_CHARS) : undefined
    if (custom && (!title || !text?.trim())) return []
    return [{
      id: i.id,
      ...(title && custom ? { title } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(i.schedule && AGENT_REQUEST_SCHEDULES.includes(i.schedule) && i.schedule !== 'off' ? { schedule: i.schedule } : {}),
      ...(i.batch === true ? { batch: true } : {}),
      ...(custom ? { custom: true as const } : {})
    }]
  })
  const lastRunAt = r.lastRunAt && typeof r.lastRunAt === 'object' && !Array.isArray(r.lastRunAt)
    ? Object.fromEntries(Object.entries(r.lastRunAt).filter((e): e is [string, string] => seen.has(e[0]) && str(e[1]) && Number.isFinite(Date.parse(e[1]))))
    : {}
  return { items, ...(Object.keys(lastRunAt).length ? { lastRunAt } : {}) }
}

/** 画面に出す一覧（組み込み → 足したもの） */
export function resolveAgentRequests(prefs: AgentRequestPrefs | undefined, lang: RequestLanguage): AgentRequest[] {
  const saved = new Map((prefs?.items ?? []).map((i) => [i.id, i]))
  const builtins = BUILTIN_REQUESTS.map((b): AgentRequest => {
    const s = saved.get(b.id)
    const text = s?.text ?? b.text[lang]
    return { id: b.id, title: b.title[lang], text, schedule: s?.schedule ?? 'off', batch: s?.batch ?? false, custom: false, edited: s?.text !== undefined && s.text !== b.text[lang] }
  })
  const custom = (prefs?.items ?? []).filter((i) => i.custom).map((i): AgentRequest => ({
    id: i.id, title: i.title ?? '', text: i.text ?? '', schedule: i.schedule ?? 'off', batch: i.batch ?? false, custom: true, edited: false
  }))
  return [...builtins, ...custom]
}

/** 組み込みの文面（「既定に戻す」） */
export function builtinRequestText(id: string, lang: RequestLanguage): string | null {
  return BUILTIN_REQUESTS.find((b) => b.id === id)?.text[lang] ?? null
}

/**
 * 送る文。1件ならその文、複数なら番号付きでまとめる。最後に共通の決まり。
 * オーケストレーターから送るときは、すべてのプロダクトに subagent で並行して行うよう添える
 */
export function composeAgentRequest(requests: ReadonlyArray<Pick<AgentRequest, 'title' | 'text'>>, lang: RequestLanguage, orchestrator: boolean): string {
  const body = requests.length === 1
    ? requests[0]!.text.trim()
    : requests.map((r, i) => `## ${i + 1}. ${r.title}\n\n${r.text.trim()}`).join('\n\n')
  const intro = requests.length > 1
    ? (lang === 'ja' ? '次の依頼をまとめて行ってください。互いに関係しないものは並行して進めてください。' : 'Do the following requests together. Run the ones that do not depend on each other in parallel.')
    : ''
  const fanOut = orchestrator
    ? (lang === 'ja'
      ? 'これはオーケストレーターからの依頼です。共通の部分（共通のルール・共有のコード）を先に1回で済ませてから、すべてのプロダクトにそれぞれの subagent で並行して行ってください。インフラなどプロダクトごとに分けるものは混ぜないでください。最後にプロダクトごとの結果をまとめてください。'
      : 'This request comes from the orchestrator. Do the shared part (shared rules, shared code) once first, then do it for every product in parallel through each product\'s subagent. Keep infrastructure and other per-product things separate. Finish with the results per product.')
    : ''
  return [intro, fanOut, body, CLOSING[lang]].filter(Boolean).join('\n\n').slice(0, 8000)
}

const DAY_MS = 24 * 60 * 60 * 1000

/** 定期の依頼のうち、送る時期が来たもの（一度も送っていなければすぐ） */
export function dueRequests(requests: readonly AgentRequest[], lastRunAt: Record<string, string> | undefined, now: number): AgentRequest[] {
  return requests.filter((r) => {
    if (r.schedule === 'off' || !r.text.trim()) return false
    const last = Date.parse(lastRunAt?.[r.id] ?? '')
    const every = r.schedule === 'daily' ? DAY_MS : 7 * DAY_MS
    return !Number.isFinite(last) || now - last >= every
  })
}

/** 画面の変更を保存の形に戻す（組み込みの文面が既定と同じなら text を持たない） */
export function toPrefs(requests: readonly AgentRequest[], lang: RequestLanguage, lastRunAt?: Record<string, string>): AgentRequestPrefs {
  const items = requests.flatMap((r): AgentRequestItemPrefs[] => {
    const builtin = builtinRequestText(r.id, lang)
    const text = r.custom || r.text !== builtin ? r.text : undefined
    const item: AgentRequestItemPrefs = {
      id: r.id,
      ...(r.custom ? { title: r.title, custom: true as const } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(r.schedule !== 'off' ? { schedule: r.schedule } : {}),
      ...(r.batch ? { batch: true } : {})
    }
    return r.custom || Object.keys(item).length > 1 ? [item] : []
  })
  return { items, ...(lastRunAt && Object.keys(lastRunAt).length ? { lastRunAt } : {}) }
}
