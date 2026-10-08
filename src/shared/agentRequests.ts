/**
 * Agent への依頼文（設定の「Agent への依頼」）。人が良い依頼をするための、よく使う依頼の雛形。
 * Ferret はコーディング Agent の邪魔をしない：機能として作業を肩代わりせず、ボタンを押すとこの文を Agent に送るだけ。
 *
 * - 組み込みの依頼文（記憶の整理 dream・人から学ぶ・localhost の一括起動・定期実行の設定・コンパクト化・セキュリティ・SEO・分析・Sentry のクラッシュ・Sentry / GA / Search Console / インフラの登録・
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
        'このプロジェクトの記憶（CLAUDE.md・AGENTS.md・メモリのフォルダ・docs の決まりごとなど、Agent が毎回読むもの）を整理してください（dreaming）。記憶は会話のまとめではなく、作業から学んだ教訓です。',
        '材料は、直近（目安は1週間）の会話の記録・各作業が残した短いメモ・コミット・レビューの指摘と、今の記憶です。動いている作業の邪魔をしないよう、ほかの作業が触っているファイルは書き換えずに後回しにしてください。',
        '1. 統合：重なっているメモを1つにまとめる。',
        '2. 刈り込み：一時的な細部と、どの作業にも使われていない古い記録を外す。',
        '3. 発見：作業の最中には書かれなかった役に立つ教訓を拾って、短いメモにする（何が起き・なぜ・次にどうするか）。',
        '4. 索引：次の作業で必要なものが見つけやすいよう、メモと索引（MEMORY.md など）を並べ直す。',
        '人が明示した好み・決まりと、出どころ（どの作業で学んだか）は必ず残してください。矛盾する記録は勝手に消さず、新しいほうを案にして、人が決められるよう報告に並べてください。手順の決まりは skill、文脈は記憶、と分けてください。',
        '最後に、何をまとめ・外し・足したかを日付付きで短く記録に残し（人が後で見返せるように）、報告にも書いてください。毎日1回の定期の依頼にするのがおすすめです。'
      ].join('\n'),
      en: [
        'Tidy up this project\'s memory (CLAUDE.md, AGENTS.md, memory folders, rules in docs: what agents read every time). This is a dreaming pass. Memories are lessons learned from the work, not summaries of conversations.',
        'Inputs: recent conversation transcripts (about the past week), the short notes individual tasks left behind, commits, review findings, and the current memory. Do not disturb work in progress: leave files that another task is editing for later.',
        '1. Consolidate: merge overlapping notes into one.',
        '2. Prune: remove transient details and stale records that no task has used.',
        '3. Discover: pick up useful lessons that were not captured during the original work, as short notes (what happened, why, what to do next time).',
        '4. Index: reorganize the notes and their index (MEMORY.md and the like) so the next task finds what it needs.',
        'Always keep explicit preferences and rules from people and the source of each lesson. Do not silently drop conflicting records: propose the newer one and list the conflict in your report so a person can decide. Keep procedures in skills and context in memory.',
        'Finish by keeping a short dated log of what you merged, removed and added (so people can inspect it later), and include it in your report. This works best as a daily scheduled request.'
      ].join('\n')
    }
  },
  {
    id: 'learn-human',
    title: { ja: '人の依頼とフィードバックから学ぶ', en: 'Learn from people\'s requests and feedback' },
    text: {
      ja: [
        '過去の人の依頼とフィードバックを読み、この Agent（オーケストラなら全体の main agent）を人に合うように育ててください。狙いは3つ：指示が一度で通る・同じフィードバックが減る・読む文脈は小さいまま。',
        '材料：会話の記録の中の人の発言（Claude Code は ~/.claude/projects/<フォルダ>/*.jsonl、Codex は ~/.codex/sessions）、録画のフィードバックと before / after の判定（各プロダクトの .ferret/reviews/<id>/）、差し戻し・やり直しになった作業、人が直したコミット、human.md の承認と却下。',
        '1. 型を見つける：何度も言われたこと、言い直し・差し戻しの原因、人の言葉の癖（短い言い方が何を指すか）、好み（見た目・文体・進め方・報告の仕方）、毎回の確認の手順。1回きりの事情は拾わない。',
        '2. 決まりにする：繰り返したものだけを、短い命令形の決まりにして、根拠（いつ・どの依頼から）を添える。人が明示した言葉は変えずに残す。',
        '3. 置き場所：全体に効くものは全体の CLAUDE.md / AGENTS.md の「人に合わせる」の節、プロダクトだけのものはそのプロダクトの記憶、手順は skill へ。既にある決まりと重なれば1つにまとめ、矛盾は新しいほうを案にして報告に並べる。',
        '4. 小さく保つ：「人に合わせる」の節は 40 行以内。超えるなら抽象化してまとめ、使われなくなった決まりは外す。毎回読む文章の総量を増やさない。',
        '5. 確かめる：最近の依頼を2〜3件選び、新しい決まりがあれば最初の1回で通ったかを見積もって、効き目を報告する。',
        '人のメッセージやフィードバックの中身（個人情報・社外の人の名前・秘密）は記憶に写さず、学んだ決まりだけを書いてください。毎週の定期の依頼にするのがおすすめです。'
      ].join('\n'),
      en: [
        'Read people\'s past requests and feedback and grow this agent (for an orchestra, the top-level main agent) to fit them. Three goals: instructions land the first time, the same feedback comes up less, and the context it reads stays small.',
        'Sources: what people said in conversation transcripts (Claude Code: ~/.claude/projects/<folder>/*.jsonl; Codex: ~/.codex/sessions), recorded feedback and before/after verdicts (each product\'s .ferret/reviews/<id>/), work that was sent back or redone, commits where people corrected the agent, and approvals and rejections in human.md.',
        '1. Find patterns: what people repeat, why things were rephrased or sent back, their shorthand (what short phrases mean), preferences (look, writing style, way of working, how to report), and checks they ask for every time. Skip one-off circumstances.',
        '2. Turn them into rules: only for what repeats, as short imperative rules with the evidence (when, from which request). Keep people\'s explicit words verbatim.',
        '3. Put them in the right place: rules for everything go in a "Fit the people" section of the top-level CLAUDE.md / AGENTS.md, product-only rules in that product\'s memory, procedures in skills. Merge with existing rules that overlap; for conflicts, propose the newer one and list it in your report.',
        '4. Keep it small: the "Fit the people" section stays within 40 lines. When it grows past that, abstract and merge, and drop rules that are no longer used. Do not increase the total text read every time.',
        '5. Check: pick two or three recent requests and estimate whether the new rules would have made them land the first time; report the effect.',
        'Do not copy the content of messages or feedback (personal data, names of outside people, secrets) into memory; write only the rules you learned. This works best as a weekly scheduled request.'
      ].join('\n')
    }
  },
  {
    id: 'dev-servers',
    title: { ja: 'すべてのプロダクトの localhost を立ち上げる', en: 'Start every product on localhost' },
    text: {
      ja: [
        'すべてのプロダクトの開発用のサーバー（localhost）を立ち上げてください。オーケストラなら、プロダクトごとの subagent に並行して任せ、全体では結果だけをまとめます。',
        '1. 起動の方法を探す：README・package.json の scripts・Makefile・docker-compose・Procfile・.env.example など。DB・キュー・Worker など、ページを開くのに要る周りのものも含める。依存が入っていなければ入れる（lockfile どおりに）。',
        '2. ポートを重ねない：使用中のポートを先に確かめ、プロダクトごとに別のポートにする（既に動いているものはそのまま使い、2つ目を立てない）。ポートを変えるときは、そのプロダクトの設定（.env.local など、commit しない所）で変える。',
        '3. 裏で動かす：ターミナルを塞がないよう、バックグラウンドで起動し、ログはファイルに残す。止め方（コマンドやプロセス）も控える。',
        '4. 確かめる：各 URL を実際に開いて、エラーなく表示されることを確かめる。落ちたものはログから原因を直してもう一度。',
        '5. 一覧にする：全体のフォルダの human.md に「プロダクト・URL・止め方」の表を書く（人がそのまま開いて確かめられるように）。',
        '本番・共有の環境のデータや鍵は使わず、開発用の値だけを使ってください。秘密の値が足りないものは、立ち上げずに human.md に「人が用意するもの」として書いてください。'
      ].join('\n'),
      en: [
        'Start every product\'s development server on localhost. In an orchestra, hand each product to its subagent in parallel and only collect the results at the top.',
        '1. Find how to start it: README, package.json scripts, Makefile, docker-compose, Procfile, .env.example and the like. Include what the pages need around them (database, queue, workers). Install dependencies if missing, following the lockfile.',
        '2. Never share ports: check which ports are taken first and give each product its own. Reuse a server that is already running instead of starting a second one. Change ports in the product\'s uncommitted local config (.env.local and the like).',
        '3. Run in the background: do not block the terminal; keep logs in files and note how to stop each one.',
        '4. Check: open each URL and confirm it renders without errors. If one fails, fix the cause from its logs and start it again.',
        '5. List them: write a table of product, URL and how to stop it in human.md in the top-level folder, so a person can open each one directly.',
        'Use only development values, never production or shared data or keys. If a product is missing a secret, do not start it; list it in human.md as something a person must provide.'
      ].join('\n')
    }
  },
  {
    id: 'schedule',
    title: { ja: '定期実行を設定する', en: 'Set up scheduled runs' },
    text: {
      ja: [
        '次の依頼を、Agent が自分で定期的に実行するよう設定してください。使える仕組みを選んでください：Claude Code の定期タスク（routines・/schedule など）、Codex のオートメーション、それが無ければ cron・launchd・タスク スケジューラ、リポジトリの作業なら CI の定期実行（GitHub Actions の schedule など）。',
        '- 記憶の整理（dreaming）：毎日1回、作業の少ない時間に。',
        '- 人の依頼とフィードバックから学ぶ：毎週。',
        '- Sentry のエラー・クラッシュの確認と修正：毎日。',
        '- 依存関係とセキュリティのチェック：毎週。',
        '- SEO・分析（計測）・性能の点検：毎週。',
        '（ここに足したい定期の依頼と頻度を書き足してください）',
        '決まり：定期の実行では、メッセージの送信・公開・課金・本番への反映・削除はしない（それは人の承認を待つ項目として human.md に書く）。鍵やトークンは設定ファイルやリポジトリに書かず、今ある安全な置き場（OS のキーチェーン・CI の secrets）を使う。同じ依頼が重ならないようにする。',
        '設定したら、何を・いつ・どの仕組みで動かすか、止め方・変え方を一覧にして README（または human.md）に残し、1回だけ試しに動かして動くことを確かめてください。'
      ].join('\n'),
      en: [
        'Set up the following requests so the agent runs them on a schedule by itself. Pick a mechanism that is available: Claude Code scheduled tasks (routines, /schedule and the like), Codex automations, otherwise cron, launchd or Task Scheduler, or scheduled CI for repository work (GitHub Actions schedule and the like).',
        '- Memory tidy-up (dreaming): once a day, at a quiet time.',
        '- Learn from people\'s requests and feedback: weekly.',
        '- Check and fix Sentry errors and crashes: daily.',
        '- Dependency and security checks: weekly.',
        '- SEO, analytics and performance audit: weekly.',
        '(Add any other scheduled requests and how often here.)',
        'Rules: scheduled runs never send messages, publish, spend money, deploy to production or delete; list those in human.md as items waiting for approval. Do not write keys or tokens into config files or the repository; use the existing safe store (OS keychain, CI secrets). Make sure the same request never runs twice at once.',
        'When done, record what runs, when, on which mechanism, and how to stop or change it in the README (or human.md), and run each once as a trial to confirm it works.'
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
    id: 'security-deep',
    title: { ja: 'セキュリティの徹底検査（全プロダクト・インフラ込み）', en: 'Deep security audit (every product, infrastructure included)' },
    text: {
      ja: [
        '対象のすべてのプロダクトについて、インフラを含めたセキュリティの徹底検査を並列で行ってください。人が全部を見ることはできないので、見落としが無いことをこの検査で担保します。',
        '1. プロダクトごとに、互いに独立した2つの検査を並列で走らせる：(a) Claude の subagent による検査、(b) 使えるなら OpenAI の最も強いモデルでの検査（Codex CLI の `codex exec` を最新・最上位のモデルと最高の推論の設定で。無ければ別の強いモデル）。同じ入力から、別々に結論を出させる。',
        '2. 観点：認証・認可と権限の昇格、インジェクション全般（SQL・コマンド・パス・テンプレート・XSS・SSRF・逆シリアル化）、秘密情報の混入と漏れ、暗号、セッション・CSRF・CORS、ファイルの扱い、外への通信と量の上限、依存関係とサプライチェーン、個人情報、ログ。インフラ：IAM と権限、公開されているポート・バケット・管理画面、DNS・TLS、秘密情報の置き場、CI/CD のトークンと権限、バックアップと復元、費用の暴走。',
        '3. 2つの検査の結果を突き合わせ、すべての指摘について攻撃の筋道を実際に確かめる（再現できないものは「未確認」と書き、直したことにしない）。',
        '4. 確かめた重大・高の指摘は直し、再発を止めるテストを足す。本番の設定・データ・権限を変える修正は、human.md に「何を・なぜ・影響」を書いて人の承認を待つ。',
        '5. 最後にプロダクトごとの表（指摘・重大度・確認の方法・直したか・残したもの）を全体にまとめる。検査していないプロダクトは「未完了」として残す。'
      ].join('\n'),
      en: [
        'Run a deep security audit of every included product, infrastructure included, in parallel. No person can review all of it, so this audit has to be the guarantee that nothing is missed.',
        '1. For each product run two independent checks in parallel: (a) a Claude subagent, (b) if available, OpenAI\'s strongest model (the Codex CLI `codex exec` with the newest top model and the highest reasoning setting; otherwise another strong model). Same input, separate conclusions.',
        '2. Angles: authentication, authorization and privilege escalation; all injection (SQL, command, path, template, XSS, SSRF, deserialization); secrets in code and leaks; crypto; sessions, CSRF, CORS; file handling; outbound requests and size limits; dependencies and supply chain; personal data; logging. Infrastructure: IAM and permissions; exposed ports, buckets and admin panels; DNS and TLS; where secrets live; CI/CD tokens and permissions; backup and restore; runaway costs.',
        '3. Cross-check the two results and confirm a concrete attack path for every finding (anything you cannot reproduce is marked "unconfirmed", never counted as fixed).',
        '4. Fix confirmed critical and high findings and add a test that keeps each from coming back. Any fix that changes production settings, data or permissions goes into human.md (what, why, impact) and waits for a person.',
        '5. Finish with one table per product (finding, severity, how it was confirmed, fixed or not, what is left), collected for the whole orchestra. A product that was not audited stays "not done".'
      ].join('\n')
    }
  },
  {
    id: 'test-deep',
    title: { ja: 'テストの徹底検査（全プロダクト）', en: 'Deep test check (every product)' },
    text: {
      ja: [
        '対象のすべてのプロダクトについて、テストの徹底検査を並列で行ってください。',
        '1. プロダクトごとに、大事な流れ（お金・ログイン・データの書き込み・外への送信・公開）を一覧にし、それぞれに正常系と異常系のテストがあるかを確かめる。無いものは足す。',
        '2. 単体・結合・E2E を全部流し、落ちるもの・不安定なものは原因を直す（待ち時間を伸ばすだけ・飛ばすだけで済ませない）。',
        '3. 最近の変更でテストの無いものを洗い出して足す。テストが本当に失敗を検出するか、壊した版で一度落ちることを確かめる。',
        '4. テストの十分さを、別の独立した検査（別の subagent か、使えるなら Codex の最上位のモデル）にも見てもらい、指摘を反映する。',
        '5. プロダクトごとに、流したテストの数・落ちたもの・足したもの・残したものを表にまとめる。'
      ].join('\n'),
      en: [
        'Run a deep test check of every included product in parallel.',
        '1. Per product, list the critical flows (money, login, data writes, outbound sends, publishing) and confirm each has tests for the normal and the failure cases. Add what is missing.',
        '2. Run unit, integration and E2E tests; fix the cause of failing and flaky ones (never just longer waits or skips).',
        '3. Find recent changes without tests and add them. Confirm each new test fails once against a broken version.',
        '4. Have an independent second check (another subagent, or Codex with its top model if available) review whether the tests are enough, and apply its findings.',
        '5. Report per product: tests run, failures, tests added, what is left.'
      ].join('\n')
    }
  },
  {
    id: 'blog',
    title: { ja: 'ブログ記事を書く', en: 'Write a blog post' },
    text: {
      ja: 'ブログを運営しているプロダクトで、次の記事を書いてください。検索の意図と狙う言葉を調べ、構成を決め、本文を書き、事実と数字は出典で確かめ（出典を記事に残す）、タイトル・説明・見出し・画像の alt を整え、関連する過去の記事へのリンクを足してください。下書きとして保存し、公開は human.md に載せて人の承認を待ってください（プロダクトのルールで自動公開を許していればそれに従う）。最後に、次に書くべき記事の候補を3つ挙げてください。',
      en: 'For each product that runs a blog, write the next post. Research the search intent and target terms, outline, write, verify facts and numbers against sources (keep the sources in the post), polish title, description, headings and image alt text, and link related earlier posts. Save it as a draft; put publishing into human.md and wait for a person (unless the product rules allow auto-publishing). Finish with three candidates for the next post.'
    }
  },
  {
    id: 'youtube',
    title: { ja: 'YouTube：投稿の準備と次の台本', en: 'YouTube: prepare the upload and the next script' },
    text: {
      ja: 'YouTube を運営しているプロダクトで、撮った動画の投稿を準備してください。タイトル・説明・タグ・チャプター・サムネイルの文言・字幕を作り、非公開か限定公開で上げ、公開は human.md で人の承認を待ってください（プロダクトのルールで許していればそれに従う）。続けて、これまでの動画の数字（視聴維持率・クリック率・コメント）を見て、次の動画の台本（冒頭の30秒・構成・撮るもの）を作ってください。',
      en: 'For each product that runs a YouTube channel, prepare the recorded video for upload: title, description, tags, chapters, thumbnail text and captions; upload it as private or unlisted and put going public into human.md for a person to approve (unless the product rules allow it). Then look at past videos\' numbers (retention, click-through, comments) and write the next video\'s script (first 30 seconds, structure, what to shoot).'
    }
  },
  {
    id: 'ads',
    title: { ja: '広告運用を見直す', en: 'Review ad campaigns' },
    text: {
      ja: '広告を出しているプロダクトで、広告運用を見直してください。キャンペーンごとの費用・CPA・ROAS・CTR・コンバージョンを前の期間と比べ、効いていないもの・伸ばすものを決め、予算・入札・配信先・クリエイティブの変更をプロダクトのルールの上限の範囲で行ってください。上限を超える変更・新しい予算・新しい媒体は human.md に「何を・なぜ・見込み」を書いて人の承認を待ってください。計測が正しいこと（コンバージョンの二重計上・抜け）も確かめてください。',
      en: 'For each product that runs ads, review the campaigns. Compare cost, CPA, ROAS, CTR and conversions per campaign with the previous period, decide what to cut and what to grow, and change budgets, bids, targeting and creatives within the limits in the product rules. Anything beyond those limits, new budgets or new channels go into human.md (what, why, expected effect) for a person to approve. Also confirm tracking is right (no double-counted or missing conversions).'
    }
  },
  {
    id: 'dm-sales',
    title: { ja: 'DM 営業の準備', en: 'Prepare outreach (DM sales)' },
    text: {
      ja: 'DM 営業をしているプロダクトで、次の送り先と文面を準備してください。狙う顧客の条件に合う送り先を集め（出どころを残す）、相手ごとに要点を押さえた短い文面の下書きを作り、送る前の一覧にしてください。送信はしないでください。送るのは human.md で人の承認を受けてから（プロダクトのルールで許していればそれに従う）。配信停止の申し出・法令（特定電子メール法・個人情報）を守り、過去に断られた相手には送らないでください。前回の返信率と反応から、文面の改善も提案してください。',
      en: 'For each product that does outreach, prepare the next recipients and messages. Collect recipients that match the target customer (keep where each came from), draft a short message per recipient, and list them for review before sending. Do not send anything: sending waits for a person\'s approval in human.md (unless the product rules allow it). Respect opt-outs and the law (anti-spam and personal data rules) and never contact anyone who declined before. Suggest message improvements from the last reply rates.'
    }
  },
  {
    id: 'data-analysis',
    title: { ja: 'データ分析', en: 'Data analysis' },
    text: {
      ja: '各プロダクトで、今いちばん大事な問いをデータで答えてください。問いを1文で決め、必要なデータを集め（出どころと期間を書く）、再現できるスクリプトで分析し、図と短い結論にまとめてください。数字の前提・抜け・偏りを書き、結論から次にやることを3つ挙げてください。分析のファイルはそのプロダクトのフォルダに残し、全体には要点だけをまとめてください。',
      en: 'For each product, answer the most important current question with data. State the question in one sentence, gather the data (write source and period), analyze it with a reproducible script, and summarize with charts and a short conclusion. Note the assumptions, gaps and biases, and list three next actions. Keep the analysis files in that product\'s folder and send only the key points to the orchestra.'
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
