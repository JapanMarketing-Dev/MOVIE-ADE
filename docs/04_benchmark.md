# 04. 先行例ベンチマーク — MOVIE-ADE

最終更新: 2026-10-02

## 0. 調査の前提

実際にクローンしてコードを読んだ。パスは各リポジトリのルートからの相対パスで示す（例: `orca/src/renderer/src/assets/main.css:283`）。

| 製品 | 取得元 | 読んだコミット | ライセンス | 規模 |
|---|---|---|---|---|
| **Orca** 1.4.214 | `github.com/stablyai/orca` | `7577366` (2026-10-01) | **MIT** (Copyright 2026 Lovecast Inc. / `orca/LICENSE`) | Electron 43.7.5 + React 19 + TS、31,862ファイル |
| **herdr** v0.9.3 | `github.com/herdrdev/herdr` | `d6b40d4` (2026-10-01) | **Apache-2.0** (`herdr/LICENSE`)。vendor の libghostty-vt / portable-pty は MIT | Rust / ratatui + crossterm + portable-pty + tokio、★41,864 |
| **FeedbackRecorder** 0.2.0 | `github.com/magnuslandahl/FeedbackRecorder` | `906b794` (2026-10-01) | **MIT** (Copyright 2026 Magnus Landahl) | Electron 44 + 素のHTML/CSS/JS、約12.5k行 |
| **Clipy** / AREC 0.3-draft | `clipy.online/for-agents`、`/docs/arec`、`/spec` | 2026-10-02 取得 | クローズド。**仕様文書のみ CC BY 4.0** | 公開ドキュメントのみ |

01_concept.md の未決事項「`harder` が指す製品」は **herdr で確定**した（`herdrdev/herdr`、Apache-2.0、Rust、Agent状態検知つきターミナルマルチプレクサ）。`SuperCodeAgents/herdr-terminal` と `heeen/herdr` はいずれも fork。

---

## 1. 比較表

### 1.1 機能の対応

| 機能 | Orca | herdr | FeedbackRecorder | Clipy | 本システム |
|---|---|---|---|---|---|
| 形態 | デスクトップADE（Electron） | ターミナルマルチプレクサ（CLI） | 単機能デスクトップ（Electron） | Chrome拡張＋Macアプリ＋クラウド | デスクトップADE（Electron） |
| 内蔵ブラウザ | ◎ `<webview>`＋CDP | ✕ | ✕ | ー（拡張なので対象タブ） | ◎ |
| 内蔵ターミナル / Agent | ◎ xterm.js＋node-pty、38種のAgent対応 | ◎ portable-pty、24種 | ✕ | ✕ | ○ 1〜数タブ、並列管理なし |
| Agent状態の検知・表示 | ○ OSCタイトル＋画面本文＋hook | **◎ 最も作り込まれている**（TOMLマニフェスト22本） | ✕ | ✕ | ○ herdr方式の簡易版 |
| 画面録画 | ✕ | ✕ | ◎ `getDisplayMedia`＋MediaRecorder | ◎ | ◎ |
| 音声録音 | △ 音声入力（dictation、sherpa-onnx）のみ | ✕ | ○ **マイクのみ（意図的）** | ○ | ◎ **マイク＋PC音声の2系統** |
| ローカル文字起こし | △ sherpa-onnx（dictation用） | ✕ | ◎ whisper.cpp 同梱＋Silero VAD | ✕ クラウド | ◎ whisper.cpp |
| 話者分離 | ✕ | ✕ | ✕ | ✕ | ◎ 系統で分離（自分／相手） |
| ペン描画 | ○ スクショへのマークアップ（`PenTool`） | ✕ | ✕ | ○ draw / flare | ◎ 対象画面へ直接 |
| キーフレーム抽出 | ✕ | ✕ | **◎ 2スケール差分＋settle＋revisit** | ○ 発話ポインタ基準 | ◎ 発話・ペン基準＋FR方式 |
| 要素情報（セレクタ/HTML/CSS） | **◎ Grab/Annotate** | ✕ | ✕ | △ クリック座標のみ | ◎ Orca方式を踏襲 |
| 指摘のバッチ蓄積 | ◎ 1ページ20件まで溜めて一括送信 | ✕ | △ キーフレームへのコメント | ◎ requests配列 | ◎ |
| Agentへの受け渡し | ◎ PTYへブラケットペースト | ー | ○ クリップボード／zip D&D | ◎ `.arec` URL / MCP / CLI | ◎ ファイル＋PTY送信 |
| 出力形式 | Markdown（`## Design Feedback:`） | ー | `agent-brief.md` ＋ `run.json` | **AREC**（Markdown＋識別コメント） | `feedback.md` ＋ `session.json` |
| MTGでの画面共有 | ✕ | ✕ | △ 録画バーが `setContentProtection(true)` | ✕ | **◎ フィードバックモード** |
| 端末内完結 | ○ | ◎ | ◎ | ✕ クラウド必須 | ◎ |
| 料金 | 無料（OSS） | 無料（OSS） | 無料（OSS） | 無料15本 / Pro $9月 | 無料（自分のサブスク） |

### 1.2 本システムの要件への対応元

| 要件 | 主な参照先 |
|---|---|
| WS-2 内蔵ブラウザ・Cookie保持 | Orca `<webview>` ＋ `persist:` partition（`orca/src/shared/constants.ts:48`） |
| WS-3 PC／スマホ幅切替 | Orca の CDP `Emulation.setDeviceMetricsOverride` ＋ 7プリセット（`orca/src/shared/browser-viewport-presets.ts:15-72`） |
| WS-4 内蔵ターミナル | Orca の xterm.js 設定・流量制御一式 |
| REC-2/3 録画・音声 | FeedbackRecorder の `getDisplayMedia` ＋ MediaRecorder ＋ AudioContext WAV |
| EXT-1 文字起こし | FeedbackRecorder の whisper.cpp 同梱方式・VAD・`-l auto` の罠 |
| EXT-3/5 画像 | FeedbackRecorder のキーフレーム（2スケール差分・settle・revisit）、Orca の `capturePage`＋`crop` |
| EXT-4 要素情報 | Orca の Grab（セレクタ生成・computed CSS 16項目・React fiber） |
| REV-1/2 確認・編集 | Orca の注釈トレイ、FeedbackRecorder の Done 画面 |
| OUT-1/2 受け渡し | Orca の「本文→50ms→readiness再確認→Enter別送」、AREC の構成要素 |
| NF-5/6 起動・ターミナル速度 | Orca の boot graph gate、PTY 流量制御、WebGL 遅延ロード |
| 「ターミナルタブの状態表示」 | herdr の 4状態＋pending-idle 確定遅延 |

---

## 2. UI/UX仕様（ベンチマーク準拠）

**方針**: Orca の値をそのまま写すのではなく、「Orca に慣れた人が違和感なく使える」水準で、本システムの2モード構成に当てはめる。以下は実装エージェントがそのまま使える確定値として扱う。逸脱する場合は理由を明記した。

### 2.1 デザイントークン

正本は `src/renderer/styles/tokens.css`。値は Orca（`orca/src/renderer/src/assets/main.css` の `:root`＝ライト／`.dark`＝ダーク、MIT）から写している。Orca と同じく **oklch は使わず hex / `rgb()/alpha` / `color-mix()` で書く**。

**テーマの切り替え**（2026-10-03 実装）

- 設定は `Settings.theme?: 'system' | 'light' | 'dark'`（既定 system）。IPC は `'settings:theme'`、正規化は `src/shared/theme.ts`。
- 解決は main が持つ。`nativeTheme.themeSource` を設定に合わせ、`shouldUseDarkColors` からウインドウと内蔵ブラウザ（WebContentsView）の背景色を決める（Orca `src/main/ipc/settings.ts`）。
- renderer は解決済みの値を `<html data-theme>` に書くだけ（`src/renderer/lib/theme.ts`）。起動時は preload の `window.ade.initialTheme`（main が `additionalArguments` で渡す）、変更時は `'theme:changed'` イベント。**`prefers-color-scheme` は読まない**（Playwright が既定でライトに上書きするため。メディアクエリも CSS に書かない）。
- 切り替えの瞬間だけ `.theme-transition-disabled` を付け、2フレーム後に外す（Orca `lib/document-theme.ts`）。
- CSS 変数を JS で読む部品（xterm・Monaco）は、window の `'ade:themechange'` か `data-theme` の変化を聞いて作り直す。
- 切り替えのUIは設定ダイアログ（`ThemeSegmented`）とフッター（`ThemeToggle`）。

```css
/* tokens.css — :root がダーク（既定）、:root[data-theme='light'] がライト */
:root {
  color-scheme: dark;
  --color-bg-app: #0a0a0a;         /* Orca --background (dark) */
  --color-bg-chrome: #0f0f0f;      /* タイトルバー・ツールバー・ステータスバー */
  --color-bg-sidebar: #141414;
  --color-bg-panel: #171717;       /* Orca --card */
  --color-bg-elevated: #1e1e1e;    /* Orca --editor-surface。入力欄・ポップオーバー */
  --color-bg-terminal: #0f0f0f;
  --color-surface-hover: #262626;  /* Orca --muted */
  --color-surface-active: #404040; /* Orca --accent */
  --color-primary: #e5e5e5;        /* Orca --primary。主ボタンの地 */
  --color-primary-fg: #171717;
  --color-border: rgb(255 255 255 / 7%);         /* Orca --border */
  --color-border-strong: rgb(255 255 255 / 15%); /* Orca --input */
  --color-divider: #3f3f46;        /* ペイン分割線（--card に対し 3:1 以上） */
  --color-border-focus: #737373;   /* Orca --ring */
  --color-text: #fafafa;           /* Orca --foreground */
  --color-text-muted: #a1a1a1;     /* Orca --muted-foreground */
  --color-text-faint: rgb(255 255 255 / 52%);
  --color-accent: #3b82f6;         /* 青1色。選択・進行・リンクだけ */
  --color-success: #86efac;  --color-warning: #eab308;  --color-danger: #ff6568;
  --color-record: #ef4444;         /* 録画の赤。赤はここだけ */
  --agent-working: #eab308;  --agent-blocked: #f97316;  --agent-done: #86efac;
  --radius-sm: 4px;  --radius-md: 6px;  --radius-lg: 6px;  --radius-xl: 8px;
  --shadow-md: 0 10px 24px rgb(0 0 0 / 18%);  /* Orca --shadow-floating */
  --shadow-lg: 0 16px 36px rgb(0 0 0 / 24%);  /* Orca のタブ作成メニュー */
  --icon-stroke: 1.75;             /* lucide の線。ui.css の .lucide で一括指定 */
}

:root[data-theme='light'] {
  color-scheme: light;
  --color-bg-app: #ffffff;  --color-bg-chrome: #fafafa;  --color-bg-sidebar: #f5f5f5;
  --color-bg-panel: #ffffff;  --color-bg-elevated: #ffffff;  --color-bg-terminal: #ffffff;
  --color-surface-hover: #f5f5f5;  --color-surface-active: #ebebeb;
  --color-primary: #171717;  --color-primary-fg: #fafafa;
  --color-border: #e5e5e5;  --color-border-strong: #e5e5e5;
  --color-divider: #d4d4d8;  --color-border-focus: #a1a1a1;
  --color-text: #0a0a0a;  --color-text-muted: #737373;  --color-text-faint: rgb(24 24 27 / 64%);
  --color-accent: #2563eb;
  --color-success: #15803d;  --color-warning: #ca8a04;  --color-danger: #e40014;
  --color-record: #dc2626;
  --agent-working: #ca8a04;  --agent-blocked: #ea580c;  --agent-done: #15803d;
}
```

ターミナルの16色（`--term-*`）は Orca `src/shared/terminal-themes/defaults.ts` から写す。ダークは 'Ghostty Default Style Dark'（背景だけ `#0f0f0f` の無彩色にした）、ライトは 'Builtin Tango Light'。

**使わないもの**: グラデーション・光彩・ぼかしの影・艶・装飾の挿絵・色付きのアイコン札。旧トークン（`--gradient-*` / `--glow-*` / `--brand-*` / `--pattern-dots`）は互換のために名前だけ残し、中身は単色または「何も描かない値」にしてある。新しいCSSでは使わない。

**Orca から意図的に変えた点**

| 項目 | Orca | 本システム | 理由 |
|---|---|---|---|
| UIフォント | `'Geist'` を同梱 | **Inter / JetBrains Mono の latin サブセットだけ同梱**（fonts.css） | 和文は unicode-range から外れて OS のフォントへ落ちる。latin だけなので起動コストは約90KB |
| 角丸 | `--radius: 10px` から派生 | **4〜6px**（xl でも 8px） | 道具としてシャープに見せる。大きな角丸は「AIっぽい」印象の一因だった |
| `--color-divider` | ペイン分割だけ不透明 | 同じ思想で `#3f3f46`（ライト `#d4d4d8`） | `--border` では面の上で薄すぎる（Orca のコメントの要件を引き継ぐ） |
| アクセント | 用途別に複数（violet・blue など） | **青1色** | 意味のある色（録画の赤・状態色）以外を減らす |
| 録画 | 存在しない | `--color-record` を新設 | Orca に録画機能がない |
| テーマの解決 | renderer が `matchMedia` を読む | **main が解決して renderer へ送る** | Playwright の `colorScheme` 上書きでずれるため |

### 2.2 タイポグラフィと余白

Orca の実使用を集計すると、**Tailwind の既定スケールから意図的に外れた 11px 帯が density を決めている**（`orca/src/renderer/src/components/**/*.tsx` 内: `text-xs`(12px) 1719回、`text-[11px]` **955回**、`text-sm`(14px) 793回、`text-[10px]` 328回）。任意値だけで約1800回使われている。

本システムの文字サイズ（**モードで別の規約を持つ**のが最大の設計判断）:

| 用途 | エディタモード | フィードバックモード | 根拠 |
|---|---|---|---|
| 一覧の本文・ツールバーのラベル | **12px** | **13px** | Orca の基調は 12px。フィードバックモードは Zoom / Meet の画面共有で再エンコードされるため、**11px以下を使わず 13px を下限にする**（Orca の 11px density はローカル表示前提） |
| 補助情報（URL、時刻、話者） | 11px | 12px | 同上 |
| 見出し・強調 | 14px | 15px | |
| 経過時間（録画中） | 13px | **15px、`tabular-nums`、`font-weight: 600`** | 共有画面で一目で読める必要がある（REC-5） |
| 極小ラベル（バッジ内の数字） | 10px | 11px | Orca `text-[10px]` 328回 |
| ターミナル | 14px（xterm `fontSize`） | ー | Orca と同値 |

余白（Orca の実使用上位がそのまま使える水準）:

| トークン | 値 | Orca での出現 |
|---|---|---|
| 要素間 gap（既定） | **8px** | `gap-2` 1107回（最多） |
| 密なアイコン列の gap | 6px / 4px | `gap-1.5` 505、`gap-1` 456 |
| セクション間 gap | 12px | `gap-3` 444 |
| 行・ボタンの水平padding（既定） | **12px** | `px-3` 647回（最多） |
| 同（密） | 8px / 6px | `px-2` 586、`px-1.5` 228 |
| 行の垂直padding（既定） | **8px** | `py-2` 446回（最多） |
| 同（密） | 6px / 4px / 2px | `py-1.5` 278、`py-1` 249、`py-0.5` 214 |

→ 使う刻みは **2 / 4 / 6 / 8 / 10 / 12 / 16px** に限定する。`px-3 py-2` と `px-2 py-1.5` が二大パターン。カスタムスペーシングスケールは定義しない（Orca も `@theme` でスペーシングを定義せず Tailwind 既定を使っている）。

アイコン: **既定 14px**。Orca の事実上の標準（`size-3.5` 1333回 ＋ `size={14}` 98回）。密な場所は 12px（`size-3` 700回）、ボタン内の既定は 16px（shadcn の `[&_svg:not([class*='size-'])]:size-4`）。lucide-react を使う。

| 用途 | アイコン | 備考 |
|---|---|---|
| 録画開始 | `Circle`（塗りの赤ドット）/ `Disc` | Orca に録画UIがないので lucide から新規選定 |
| 停止 | `Square` | FeedbackRecorder の録画バーと同じ |
| 一時停止 | `Pause` | |
| ペン | `PenTool` | Orca のスクショ描画ボタンと同一 |
| テキスト配置 | `Type` | |
| 全消去 | `Eraser` | |
| ブラウザ 戻る/進む | `ArrowLeft` / `ArrowRight` | Orca と同一 |
| リロード | `RefreshCw`（読込中は `Loader2` に差し替え＋`animate-spin`） | Orca と同一 |
| 端末幅切替 | `Monitor` / `Smartphone` | Orca の Viewport Size サブメニューと同一 |
| タブを閉じる | `X` 12px、枠 16px（`rounded-sm`） | Orca と同一 |
| 指摘を削除 / 編集 | `Trash2` / `Pencil` | Orca の注釈トレイと同一 |
| 要確認 | `TriangleAlert` | |
| 送信 | `ArrowUp` または `Send` | |
| ローディング | **`Loader2` に統一** | Orca は `Loader2` 150回と `LoaderCircle` 108回が併存している。統一する |

### 2.3 エディタモードのレイアウト

```
┌──────────────────────────────────────────────────────────────────┐
│ ドラッグ帯 4px                                                      │ 36px
│ [≡] ロゴ16  [フォルダ名 chip 24px]        [● 録画] [フィードバック] [履歴] │ ─ titlebar
├────────────────────────────────┬───┬─────────────────────────────┤
│ ← → ⟳ [URL             ] [⋯]   │   │ ドラッグ帯 4px                │ 40px
│                                │ 6 │ [ターミナル 1 ●][+]           │ 32px
│                                │ p │─────────────────────────────│
│       内蔵ブラウザ               │ x │ $ claude                    │
│       （録画後は指摘一覧）         │   │                             │
│                                │   │                             │
├────────────────────────────────┴───┴─────────────────────────────┤
│ 録画: 2026-10-02 10:40 / 4:12   ·   12件   ·   whisper: small      │ 24px
└──────────────────────────────────────────────────────────────────┘
```

| 部位 | 値 | 根拠 |
|---|---|---|
| **トップバー高さ** | **36px**（`height` と `min-height` の両方を指定） | Orca `.titlebar` = 36px（`main.css:838-840`）、定数 `WORKSPACE_TOP_CHROME_HEIGHT = 36`（`sidebar/workspace-chrome-metrics.ts:3`） |
| 下端の罫線 | `box-shadow: inset 0 -1px 0 var(--border)`（`border-bottom` ではない） | Orca の理由: border-box で 35px に縮むと macOS トラフィックライト中心 y=18 と 0.5px ずれる（`main.css:866-874`） |
| macOS トラフィックライト | `titleBarStyle: 'hiddenInset'`、`trafficLightPosition: { x: 16, y: 12 }`、左パッド `calc(80px / var(--ui-zoom-factor, 1))` | Orca `createMainWindow.ts:122-129`（`18 - 6 = 12` の導出）、`main.css:885-888` |
| Windows | `titleBarStyle: 'hidden'` ＋ 自作ウィンドウコントロール **46×36px ×3 = 138px** を右端に予約（`--window-controls-width`）。close hover は `#c42b1c` 地・白文字 | Orca `main.css:918-960` |
| Linux | `frame: false`（`titleBarStyle: 'hidden'` が無視され二重タイトルバーになる） | Orca `createMainWindow.ts:120` |
| フォルダ名 chip | 高さ24px、`line-height: 24px`、12px / 600、`padding: 0 6px`、`border-radius: 4px`、`max-width: min(280px, 32vw)` | Orca のアプリ名チップ（`main.css:1053-1071`） |
| トップバーのアイコンボタン | `padding: 4px 8px`、`border-radius: 4px`、`transition: background 150ms`、無効時 `opacity: .45` | Orca `main.css:1012-1023, 1043-1046` |
| **ステータスバー高さ** | **24px**、`px-3 gap-4`、11px、`border-top: 1px solid var(--border)`、地は `--surface` | Orca `StatusBarSurface.tsx:103`、`STATUS_BAR_RESERVE_HEIGHT = 24` |
| **ターミナルタブバー** | 高さ **32px** ＋ その上に **4px のドラッグ帯**（計36px）。地 `--surface`、下に 1px 罫線 | Orca `TabGroupPanel.tsx:264`、`TabGroupSplitLayout.tsx:319`（36px の内訳が 4+32 であることはコメントに明記） |
| タブ幅 | 既定 **180px**、`min-[1280px]` 以上で **220px**、最小 **72px**（flex-shrink の床）、`px-1.5`、12px、`min-w-0 flex-1 truncate` | Orca `tab-bar/tab-width-rules.ts:3-5` |
| タブ内の閉じるボタン | 枠 **16×16px**（`rounded-sm`）、アイコン **12px** | Orca `SortableTab.tsx:329,358` |
| 新規タブ「+」 | **28×28px**（`rounded-md`）、アイコン 14px | Orca `tab-bar-surface.tsx:209,215` |
| タブストリップ | スクロールバー非表示（`::-webkit-scrollbar {width:0;height:0}`）、両端は `mask` でフェード（card色のオーバーレイではない） | Orca `main.css:694-734` |
| **メイン縦分割の divider** | ヒット領域 **6px**（`cursor: col-resize`）、可視ライン **3px**（`::after`、`border-radius: 1px`）、色 `--divider` → hover/ドラッグで `--divider-strong`、`transition: background 100ms ease` | Orca `.tab-group-split-resize-handle`（`main.css:776-820`） |
| 分割の既定比 / 最小 | ブラウザ側 60% / ターミナル側 40%。**最小ペイン 320px**、ドラッグ中の最小 **50px** | Orca `right-sidebar-width.ts:1-2`（非サイドバー領域の最小 320）、`pane-divider-drag.ts:15`（`MIN_PANE_SIZE = 50`） |
| ターミナル内のペイン分割 | `--divider-thickness: 4px`、交差部が ├ に見えるよう `--divider-extension: 5px` でヒット帯を延長 | Orca `terminal.css:78, 93-102` |
| **ブラウザツールバー** | 高さ **40px**。`gap-2 px-3 py-1.5`、下に 1px 罫線、地 `--surface`。ボタンは **28×28px**（`h-7 w-7`）、アイコン 16px | Orca `browser-navigation-control-row.tsx:56-93` |
| ブラウザツールバーの並び | ← / → / ⟳ / **[URL欄（中央、flex-1）]** / 録画 / 端末幅 / DevTools / 外部ブラウザで開く / ⋯ | Orca と同じ骨格（URL欄が中央スロット）。設計意図「変わるのは identity ウィジェットであって行ではない」（`browser-navigation-control-row.tsx:29-32`） |
| URL欄 | 高さ **28px**、`rounded-md`、`border: 1px solid var(--border-strong)`、地 `--surface-raised`、`px-3`、12px、**最小幅 120px** | Orca `ui/input.tsx:13`（h-9 を本システムは密な h-7 に）、折り畳み時のアドレス最小幅 120px（`use-browser-chrome-tool-fold.ts:30`） |
| 狭い時のツールバー折り畳み順 | 外部ブラウザ → DevTools → 端末幅 → 録画 の順に ⋯ へ落とす | Orca の思想を踏襲: 「この chrome が存在する理由であるページツールが**最後に**抜ける」（`use-browser-chrome-tool-fold.ts:5-7`）。本システムの存在理由は録画なので録画を最後に残す |
| スクロールバー | 一覧・パネル **12px**（thumb の `min-height: 28px`）、ターミナル **14px**、タブストリップ **0** | Orca `main.css:550-564, 657-659, 700-703` |

### 2.4 指摘一覧（録画後に左ペインへ表示）

Orca の共有リストテーブル規格（`orca/src/renderer/src/lib/list-table-layout.ts`）を基礎にし、サムネイルを持つぶん行高を上げる。

| 部位 | 値 | 根拠 |
|---|---|---|
| コンテナ | `rounded-md border border-border/50`、地 `color-mix(in srgb, var(--surface) 40%, var(--bg))` | Orca `list-table-layout.ts:6,9-10` |
| ヘッダ | `sticky top-0 h-8`（32px）、`gap-3 px-3`、11px / 500、`uppercase tracking-[0.08em]`、色 `--fg-muted`、下に 1px 罫線 | Orca `list-table-layout.ts:9-10` |
| **指摘行** | **最小高 76px**、`gap-3 px-3 py-2`、本文 12px、下に `border-b border-border/50`、hover `--surface-hover`、選択 `--surface-raised`、フォーカスリング `ring-[3px] ring-ring/50` | Orca の行は `min-h-11`(44px)＋`px-3 py-3`。サムネイル 63px ＋ `py-2`×2 = 79 なので 76px を下限にする |
| サムネイル | **112×63px**（16:9）、`rounded-sm`、地 `--media-bg`、`object-fit: contain` | 16:9 で 1 行に収まり、Orca のリスト行の密度感を壊さない最大値 |
| 連番バッジ | **20×20px** 丸、地 `--annotation-badge`、白 11px / 600。サムネイル左上に `-4px` オフセットで重ねる | Orca の注釈バッジは 24px 丸・`#2563eb`・白1px枠（`browser-annotation-viewport-bridge.ts:151`）。一覧内は 20px に縮める |
| 行の構成 | 1行目: `[00:14]` 11px muted ＋ **見出し** 13px/600 ＋ 「要確認」チップ<br>2行目: 要望 12px<br>3行目: 発話（原文）11px muted、話者は 11px/600 色付き<br>4行目: URL 11px muted `truncate` ＋ セレクタ `font-mono` 11px | 情報密度は Orca の 2段トークン構成（`herdr/src/config/sidebar.rs:439-474` の `rows` 発想）に近い |
| 「要確認」チップ | 高さ 18px、`px-1.5 rounded-sm`、10px/600、地 `--warning-bg`、枠 `--warning-border`、文字 `--warning` | Orca の status トークン3点セット（`--status-warning` / `-background` / `-border`）をそのまま使う |
| 行の操作ボタン | 20×20px、`rounded-sm`、アイコン 12px。**hover で現れる**（`can-hover` バリアントでガードし、タッチ端末では常時表示） | Orca は `@custom-variant can-hover (@media (hover: hover))` を定義して hover-reveal がタッチ端末で消えるのを防いでいる（`main.css:33`） |
| 仮想スクロール | **使わない** | 指摘は 90分録画でも数十件。Orca も結果リスト本体は非仮想化で、レンダーキャップで代替している（`palette-section-render-cap.ts:1-9`） |
| 下部アクションバー | 高さ 44px、`px-3 gap-2`、上に 1px 罫線。[送信]（primary、`h-8 px-3`）[コピー]（outline）[全体コメント…] | Orca の footer はピン留め（`styles.css` 相当の構成は FeedbackRecorder `index.html:13-231` の「ピン留め footer アクションバー」が近い） |

### 2.5 フィードバックモードのレイアウト

**最重要の制約**: このウィンドウはそのまま Zoom / Meet / Teams で共有される（MODE-2 / MODE-4）。開発側の情報を一切出さず、かつ再エンコードされた映像で読める大きさにする。

```
┌──────────────────────────────────────────────────────────────────┐
│ ● 12:34  [■ 停止] [⏸] │ [✎ ペン] [T テキスト] [消去] │ ← → ⟳ [URL  ] [▭] │ 44px
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│                 レビュー対象の画面（内蔵ブラウザ）                      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

| 部位 | 値 | 根拠・理由 |
|---|---|---|
| **ツールバー高さ** | **44px**（エディタモードの36pxより高い） | 画面共有時のクリック精度と可読性。FeedbackRecorder の録画バーも 344×44（`main.js:17`）。Orca の `min-h-[44px]` 系と同じ水準 |
| ツールバーの地 | `--surface`、下に 1px `--border` | |
| ボタン | **32×32px**（`rounded-md`）、アイコン **16px**。ラベル併記のものは `h-8 px-3 gap-1.5`、13px | Orca の Button `size="sm"` = `h-8 px-3 gap-1.5`（`ui/button.tsx`）。`h-9`(36px) は余白を食うので `h-8` にする |
| グループ区切り | `width: 1px; height: 20px`、色 `--border`、左右 `margin: 0 8px` | Orca のステータスバー内区切り（`width:1px; height:12px`）を 44px バーに合わせて拡大 |
| **録画インジケータ** | 8px 丸、地 `--rec`。`animation: rec-pulse 1.6s ease-in-out infinite`（`opacity: 1 → .35`）。経過時間は 15px / 600 / `tabular-nums`、色 `--fg` | 「録画中であることが常に分かる」（REC-5 / NF-11）。色は図形なので 3:1 で足り、`#e0574f` は card に対し実測 4.43（FeedbackRecorder `styles.css:24-28`） |
| ペン ON 中の表示 | ペンボタンを `bg-accent-active`＋枠 `--pen` にし、**ツールバー下端に 2px の `--pen` 帯**を出す | ペンON中はページ操作が行われない（PEN-2）ので、状態がモード的であることを面で示す |
| 「相手の声も録る」ON 中 | ツールバー右端に `Users` 14px ＋ 「相手の声も録音中」11px、色 `--rec-text` | NF-11（録音の明示）。初回ONで相手への告知が必要であることを出す |
| 停止ボタン | 32×32px、アイコン `Square` 16px、地 `--rec`、文字白。**ツールバー内で唯一の塗りボタン** | 誤操作を避けつつ一目で見つかる必要がある |
| ブラウザナビ | ← / → / ⟳ / URL欄 / 端末幅トグル のみ。**DevTools・外部ブラウザ・⋯ は出さない** | MODE-2「ターミナル、ファイルパス、指摘一覧は表示しない」の延長。DevTools が共有画面に出るのは開発側の情報 |
| URL欄 | 高さ 28px、13px、`max-width: 420px` | 共有画面で読めるサイズ。長いURLは `truncate`（パス末尾を残す） |
| コンテンツ領域 | ツールバー以外すべて。地 `--media-bg`、ブラウザは中央寄せ（スマホ幅のときレターボックス） | FeedbackRecorder が `--media-bg` をライトテーマでも暗く保つ理由「it is the letterbox around somebody's screen, not part of this window's surface」（`styles.css:85-87`） |
| ステータスバー・タブバー | **なし** | |
| ウィンドウ | `titleBarStyle` はエディタモードと共通（同一ウィンドウでモード切替）。フィードバックモードでは 36px のトップバーを 44px ツールバーに置き換える | ウィンドウを作り直すと Zoom のウィンドウ共有が切れる。同一 `BrowserWindow` 内で差し替える |

**ペン・テキストの描画レイヤー**（対象ページに注入する透明レイヤー）

| 項目 | 値 | 根拠 |
|---|---|---|
| ホスト要素 | `position: fixed; inset: 0; z-index: 2147483647; contain: layout style paint; overflow: hidden` | Orca の grab オーバーレイ / 注釈ブリッジと同じ（`grab-guest-overlay-script.ts:1-4`、`browser-annotation-viewport-bridge.ts:146-147`） |
| Shadow DOM | `attachShadow({ mode: 'closed' })` | Orca と同じ。**ページ本体のスクリプトから触れない**ことが要件（03_design.md 4章「ページ本体のスクリプトとは隔離」） |
| ペンOFF時 | `pointer-events: none` | 入力を素通しする（PEN-2） |
| ペンON時 | `pointer-events: all; cursor: crosshair` | Orca の grab と同じカーソル |
| ペン線 | `stroke: var(--pen)`、太さ **3px**、`stroke-linecap: round`。**外側に `--pen-halo` の 1.5px ストローク**を重ねる（計6px幅） | 対象ページが暗い場合も明るい場合も読める。Orca の grab ハイライトが「白2px枠＋暗い外側影で明暗どちらでも読める」ようにしているのと同じ対処（`grab-guest-overlay-script.ts:13-16`） |
| 置いたテキスト | 地 `rgb(10 10 10 / 0.92)`、文字 `#fafafa` 14px、`padding: 6px 10px`、`rounded-md`、`box-shadow: var(--shadow-floating)`、左上に `--pen` の 3px 縦線 | 共有画面で読める 14px。暗い pill にするのは Orca のホバーラベルと同じ |
| カーソル位置リング | 外径 28px、`border: 3px solid var(--cursor-ring)`、`opacity: .85` | ペンもテキストもない指摘の画像に合成する（EXT-3） |
| ヒットテスト | ホストを一瞬 `pointer-events: none` にして `document.elementFromPoint` → 戻す → `requestAnimationFrame` | Orca の grab と同じ手法（`grab-guest-overlay-script.ts:64-72`）。これで `elementFromPoint` がオーバーレイ自身を返すのを避ける |
| 注入タイミング | **`dom-ready` ごとに再注入**。`executeJavaScriptInIsolatedWorld` の専用 world を使う | Orca は `dom-ready` ごとに注釈ブリッジを再注入し、同時にズームと viewport override も再適用している（`browser-page-webview-guest-session.ts:244-277`）。`setDeviceMetricsOverride` は same-origin ナビゲーションを越えて残るので **null でも再適用する**（同 `:272`） |

### 2.6 ショートカット一覧

Orca の記法・衝突回避の設計をそのまま採用する。

**記法**: `Mod` = mac では ⌘、他では Ctrl。`Alt` と `Option` は同一トークン。`CommandOrControl` は `Mod` の別名。正規化順は `Mod → Cmd → Ctrl → Alt → Shift → key` に固定し、入力順は無視する。記号キーはコード名に正規化する（`[`→`BracketLeft`、`-`→`Minus`、`=`→`Equal`）。表示は mac が `⌘⌃⌥⇧` のグリフ連結（区切りなし）、他が `Ctrl+Alt+…`。（Orca `src/shared/keybindings/parser.ts:84-253`、`formatting.ts:31-124`）

**修飾子ゼロは原則禁止**。例外は3つだけ: `Shift+Insert`、`allowBareKeybindings` かつ「安全な素キー」（関数キー、`Backspace/Delete/Enter/Escape/Tab/矢印/PageUp/PageDown`。Shift付きなら関数キーのみ）、`allowShiftOnlyKeybindings`。（Orca `normalization.ts:9-44`、`parser.ts:256-280`）

| コマンド | scope | mac | win / linux | 備考 |
|---|---|---|---|---|
| **録画 開始／停止** | global | `Mod+Shift+Space` | 同 | Orca 未使用のチョード。エディタ／フィードバック両モードで同一 |
| 録画 一時停止／再開 | global | `Mod+Shift+P` | 同 | Orca 未使用 |
| **モード切替** | global | `Mod+Shift+M` | 同 | Orca はこれを `tab.newMarkdown` に使うが、本システムに markdown タブはない |
| 録画 停止（ADE非前面でも） | OSグローバル | `Mod+Alt+Shift+S` | 同 | FeedbackRecorder と同一値。3修飾キーなのは「レビュー対象アプリのショートカットを奪わないため」（`shared/shortcuts.js:3-14`）。フェーズ2・3の WIN-3 で必須 |
| ペン切替（ADE非前面でも） | OSグローバル | `Mod+Alt+Shift+P` | 同 | 同上 |
| ペン ON／OFF | feedback | `Mod+D` | `Mod+Shift+D` | Orca の `terminal.splitRight/Down` と同値だが、フィードバックモードにターミナルがないので scope で分離 |
| **ペン 一時的（押している間だけ）** | feedback | `Alt` 長押し | 同 | **素の修飾子は PTY にバイトを出さないため、readline 入力を奪わない**（herdr `client/shell/input.rs` のプレフィックス設計、Orca `main-window-shortcut-routing.ts:151` が共に明記）。PEN-2 の「押している間だけペン」の実装はこれ |
| テキスト配置 | feedback | `Mod+Shift+T` | 同 | Orca の `tab.reopenClosed` と同値だが scope で分離 |
| 描画の全消去 | feedback | `Mod+Backspace`, `Delete` | `Delete` | `allowBareKeybindings`。Orca `fileExplorer.delete` と同じ流儀 |
| URL欄にフォーカス | browser | `Mod+L` | 同 | **Orca と同一** |
| 戻る | browser | `Mod+BracketLeft` | `Alt+ArrowLeft` | **Orca と同一** |
| 進む | browser | `Mod+BracketRight` | `Alt+ArrowRight` | **Orca と同一** |
| 再読込 | browser | `Mod+R` | 同 | **Orca と同一** |
| 強制再読込 | browser | `Mod+Shift+R` | 同 | **Orca と同一** |
| ページ内検索 | browser | `Mod+F` | 同 | **Orca と同一** |
| PC／スマホ幅切替 | browser | **未割当** | 未割当 | Orca も Viewport Size を ⋯ メニューのラジオグループに置き、チョードを与えていない。踏襲する |
| **Agentへ送信** | list | `Mod+Enter` | `Ctrl+Enter` | Orca は「送信」だけはキーバインドレジストリに入れず**ハードコード**している。理由「screen submit はフォームローカルな挙動なのでプラットフォーム規約に固定」（`screen-submit-shortcut.ts:22-23`）。IME 合成中は発火させない |
| 指示をコピー | list | `Mod+Shift+C` | 同 | Orca は mac でこれを `browser.annotateElement` に使うが、本システムに該当機能はない |
| 指摘を削除 | list | `Mod+Backspace` | `Delete` | |
| 隣の指摘と結合 | list | `Mod+Shift+J` | 同 | Orca は `worktree.palette` に使うが、本システムに worktree はない |
| 該当時刻を再生 | list | `Space` | 同 | 素の印字キーだが、**一覧 scope には PTY もテキスト入力もない**ので Orca の禁止理由（readline を奪う）が当たらない。ファイルピッカーのプレビュー慣習に合わせる |
| 次／前の指摘 | list | `ArrowDown` / `ArrowUp` | 同 | `allowBareKeybindings` の安全キー |
| ターミナル: コピー | terminal | `Mod+C` | `Ctrl+Shift+C`, `Ctrl+C` | **Orca と同一**。`Ctrl+C` は**選択があるときだけ**コピー、なければ `\x03` としてシェルへ |
| ターミナル: 貼付 | terminal | `Mod+V` | `Ctrl+V`, `Ctrl+Shift+V`, `Shift+Insert` | **Orca と同一** |
| ターミナル: 全選択 | terminal | `Mod+A` | `Ctrl+Shift+A` | **Orca と同一** |
| ターミナル: 検索 | terminal | `Mod+F` | 同 | **Orca と同一** |
| ターミナル: クリア | terminal | `Mod+K` | 同 | **Orca と同一**。これが `Mod+K` を占有するので**コマンドパレットは `Mod+K` にしない** |
| 新規ターミナルタブ | tabs | `Mod+T` | 同 | **Orca と同一** |
| タブを閉じる | tabs | `Mod+W` | 同 | **Orca と同一** |
| タブ 次／前 | tabs | `Mod+Shift+BracketRight` / `Left` | 同 | **Orca と同一**（`tab.nextAllTypes`） |
| タブ 番号指定 1–9 | tabs | `Ctrl+1` … | `Alt+1` … | **Orca と同一**。定義は 1 行（代表チョード）で 1–9 全域をカバーし、保存時に key を `1` に正規化する |
| 一覧／サイドバーのトグル | global | `Mod+B` | 同 | **Orca と同一**（`sidebar.left.toggle`） |
| ズーム +／−／リセット | global | `Mod+Equal`,`Mod+Shift+Plus`,`Mod+NumpadAdd` / `Mod+Minus`,`Mod+NumpadSubtract` / `Mod+0` | 同 | **Orca と同一** |
| 過去セッション履歴 | global | `Mod+Shift+H` | 同 | Orca 未使用 |
| 設定を開く | global | **未割当** | 未割当 | **Orca の判断をそのまま採用**: 「`Cmd/Ctrl+,` は Codex 等の TUI に譲る」（`definitions-core-1.ts:15-24`） |
| アプリの強制リロード | global | `Mod+Shift+R` | 同 | Orca と同一。browser scope の強制再読込とは scope で分ける |
| 音声入力（dictation） | global | `Mod+E` | 同 | Orca と同一（将来 |

**ターミナルとの衝突回避**（Orca の設計をそのまま採る）

1. **2モードのポリシー**: `orca-first`（既定）＝アプリショートカットがターミナル内でも効く / `terminal-first`＝`scope === 'terminal'` か `allowInTerminal` のものだけ効く「脱出ハッチ」。設定に置く。（`effective.ts:70-96`）
2. **main プロセスが奪えるのは明示 allowlist だけ**。ここに無いものは renderer / PTY へ流し続ける。Orca のコメントが決定的: 「ターミナルが focus を持つ間に `Ctrl+R`, `Ctrl+U`, `Ctrl+E` のような readline チョードが誤って奪われてはならない」（`window-shortcut-policy.ts:293-297`）。本システムの allowlist は録画トグル / 一時停止 / モード切替 / ズーム / サイドバートグル / 強制リロード に限る。
3. **context 判定**: イベントのターゲットが `.xterm-helper-textarea` クラスを持つなら `'terminal'`、それ以外は `'app'`。（`terminal-workspace-model.ts:102-106`）
4. **`<webview>` guest 用に別の `before-input-event` を張る**。focus された guest は自前の Chromium プロセスで、そのキーイベントは renderer に一切届かない。（`browser-guest-shortcut-forwarding.ts:23`）
5. **main が renderer の focus 状態をミラーする**。本システムで必要なのは「ターミナル入力 focus 中か」「ショートカット録音中か」の2ビット。IPC は必ず `event.sender !== mainWindow.webContents` で送信元を検証し、**renderer 死亡時は default-deny でリセット**する。（`main-window-focus-lifecycle.ts:54-135`）
6. **xterm のバイパス**: CLI が kitty progressive enhancement（`CSI > N u`）を有効化すると、xterm の KittyKeyboard エンコーダが素の `Cmd+C` まで `cancel: true` 付き CSI-u に変え、その `preventDefault` が Chromium のネイティブ `copy` を抑制して選択がクリップボードに入らなくなる。`attachCustomKeyEventHandler` で横取りして `false` を返す（`false` を返すと xterm は kitty エンコーダの**前に** bail する）。（`xterm-bypass-policy.ts:9-19, 340-409`）
7. **カスタマイズ**: `~/.ade-movie/keybindings.json`（Orca は `~/.orca/keybindings.json`）。スキーマは `{ version: 1, keybindings: {...}, platforms: { darwin, linux, win32 } }`。値は `string | string[] | null | false`（`null`/`false` で無効化）。書き込みは `.tmp` → `renameSync` のアトミック置換。パース不能なファイルは**上書きせず throw**。キーマッププリセット（VS Code風など）は**作らない**（Orca にも存在しない）。

**コマンドパレット**: MVP では**作らない**。Orca でも `Mod+K` は `terminal.clear` が占有しており、パレットは `Mod+P`（ファイル検索）と `Mod+J`（worktree 切替）の2系統。本システムは画面が2モード＋一覧の3つだけなので、パレットの便益がない。将来入れるなら `Mod+P` を過去セッション検索に割り当てる。

### 2.7 アニメーション・グラデーション・アイコン

要望「おしゃれで、使っていてワクワクするものにする。アニメーション、グラデーション、アイコンを入れる」への回答。

#### 2.7.1 まず調査結果（重要な negative finding）

**Orca は装飾目的のグラデーションを一切使っていない。** `main.css` 全3209行の中で `gradient` が出るのは **7箇所だけ**で、すべて機能目的である。

| 用途 | 実装 | 根拠 |
|---|---|---|
| タブストリップの端フェード | `mask-image: linear-gradient(to right, transparent, #000 1.5rem, #000 calc(100% - 1.5rem), transparent)` | `orca/src/renderer/src/assets/main.css:708-733`。コメント「mask fades avoid painting card-colored overlays that mismatch active tabs」 |
| ステータスバーの溢れ処理 | 上の end フェードを再利用 | 同 `:730-734`。「a clipped cluster never cuts a glyph」 |
| オーバーレイカードの scrim | `background: linear-gradient(to top, color-mix(in srgb, var(--background) 92%, transparent), transparent)` | 同 `:1491-1498`。blur を使わない理由がコメントにある: 「without blurring the device preview, which read as a rendering glitch」 |

Tailwind の `bg-gradient-to-*` / `from-*` / `via-*` クラスは **コンポーネント全体で0件**（grep のヒットは `to-merge` `from-bottom-2` 等の別物）。

**この事実の扱い**: 「Orca に慣れた人が違和感なく使える」という要件の基準と、「おしゃれにする」という要望は、グラデーションについては**衝突する**。Orca のトーンは「密度が高く、面はフラット、境界は 7% の白」である。アクセントのグラデーションを面に敷くと Orca 系の ADE に見えなくなる。

**提案する折衷**: グラデーションは**3箇所に限定して効かせる**。面全体には敷かない。

```css
/* ① 録画中の表示 — フィードバックモードのツールバー下端に 2px の帯。
      録画中だけ出るので、ここに色を使うのが最も「状態が伝わる」 */
.rec-bar::after {
  content: '';
  position: absolute; inset-inline: 0; bottom: 0; height: 2px;
  background: linear-gradient(90deg,
    var(--rec) 0%,
    color-mix(in srgb, var(--rec) 55%, var(--accent-link)) 50%,
    var(--rec) 100%);
  background-size: 200% 100%;
  animation: rec-bar-flow 2.4s linear infinite;
}
@keyframes rec-bar-flow { to { background-position: -200% 0; } }

/* ② 指摘一覧のサムネイル下端 — 画像の上に時刻を重ねるための scrim（機能目的、Orca と同じ理屈） */
.feedback-thumb::after {
  background: linear-gradient(to top,
    color-mix(in srgb, #000 72%, transparent), transparent 60%);
}

/* ③ 送信ボタン（1画面に1つしかない主アクションなので、ここだけ特別扱いしてよい） */
.btn-send {
  background: linear-gradient(135deg, #60a5fa 0%, #818cf8 100%);
  color: #0a0a0a;
}
.btn-send:hover { background: linear-gradient(135deg, #7cb5fb 0%, #9099f6 100%); }
```

分割 divider、タブ、一覧行、ツールバー、カードの地には**グラデーションを使わない**。

#### 2.7.2 アニメーション（Orca の実値）

**Orca はアニメーション時間をトークン化していない**（CSS に直書き）。実測した頻出値と全 keyframes から、本システムの規約を作る。

Orca の実値の分布（`main.css` ＋ `agent-board-transitions.css`）:

| 用途 | Orca の値 | 根拠 |
|---|---|---|
| 背景色の hover（最頻） | `background 150ms` ×3、`background 120ms`、`background 100ms ease` | `main.css:798, 1019`（分割 divider は `100ms ease`、ツールバーボタンは `150ms`） |
| 幅の変化（サイドバー） | `width 200ms ease` | |
| 不透明度 | `opacity 280ms ease`、`opacity 320ms ease 80ms`（80ms の遅延つき） | |
| 高さの展開（grid） | `grid-template-rows 180ms cubic-bezier(0.16, 1, 0.3, 1)` | `main.css:1601` |
| Collapsible 開 / 閉 | `collapsible-down 200ms ease-out` / `collapsible-up 180ms ease-out` | `main.css:1867-1890` |
| パネルの出現 | `settings-shell-enter 180ms ease-out` | |
| カードの enter / exit | `update-card-enter 200ms ease-out both` / `update-card-exit 150ms ease-in both` | `main.css:2405-2442` |
| **View Transitions（カードの移動）** | `::view-transition-group(*) { animation-duration: 260ms; animation-timing-function: cubic-bezier(0.2, 0, 0, 1) }`。**root のクロスフェードは `0s` で無効化**（列の高さが二重像になるため） | `agent-board-transitions.css:11-20` |
| 同 enter / exit | `240ms cubic-bezier(0.2, 0, 0, 1)` で `opacity 0 → 1` ＋ `scale(0.96) → 1` / `180ms cubic-bezier(0.4, 0, 1, 1)` で逆 | 同 `:27-45` |
| 注意を引くリング（無限） | `contextual-tour-target-ring 1.8s ease-out infinite`（`opacity .72 → 0`、`scale(0.68) → 2.4`、72%で消える） | `main.css:2814-2824` |
| クリックのリング（単発） | `feature-wall-click-ring 460ms ease-out forwards`（`scale(0.4) → 1.4`、`opacity .9 → 0`） | `main.css:2605-2618` |
| 波形（装飾） | `waveform 1.4s ease-in-out infinite`（`scaleY(0.4) ↔ 1`、`opacity .6 ↔ 1`） | `main.css:2445-2460` |
| キャレット点滅 | `cli-tip-caret 0.9s steps(1, end) infinite` / `cmd-j-tip-caret 1s step-end infinite` | `main.css:2463, 2542` |
| **Agent のスピナー** | `agent-spinner-rotate 86400s steps(1036800, end) infinite`（1日1回転、見た目 12 steps/s） | `main.css:1610-1618`。「Keep rotation on the compositor: JS style writes caused typing stalls (#12359)」 |
| グロウ（単発） | `scroll-to-current-workspace-reveal-glow 1.5s ease-out forwards` | `main.css:1778` |

Tailwind ユーティリティの実使用（`src/renderer/src/components/**/*.tsx`）: `animate-spin` **482**、`transition-colors` **280**、`animate-pulse` **100**、`transition-transform` 79、`transition-opacity` 64、`ease-out` 57、`duration-150` **36**、`duration-200` 31、`transition-all` 24、`duration-300` 22、`animate-in` 22、`fade-in-0` 17、`animate-out` 14、`zoom-out-95` 10、`slide-in-from-bottom-2` 9、`zoom-in-95` 8。使用ライブラリは **`tw-animate-css` ^1.4.0**（旧 tailwindcss-animate）。

**本システムのアニメーション規約（トークン化する — Orca がしていない改善点）**

```css
:root {
  /* 時間 */
  --dur-instant: 100ms;  /* hover の地色。divider と同じ速さ */
  --dur-fast:    150ms;  /* ボタン・行の色変化（既定）。Orca の最頻値 */
  --dur-base:    200ms;  /* 開く・幅が変わる */
  --dur-slow:    260ms;  /* 位置が動く（モード切替・ペインの入替） */
  --dur-exit:    180ms;  /* 消える方は入るより速く */

  /* イージング */
  --ease-out:    cubic-bezier(0.2, 0, 0, 1);      /* 入る・動く。Orca の View Transition と同値 */
  --ease-in:     cubic-bezier(0.4, 0, 1, 1);      /* 消える。Orca の card-exit と同値 */
  --ease-spring: cubic-bezier(0.16, 1, 0.3, 1);   /* 高さの展開。Orca の grid-template-rows と同値 */
  --ease-linear: linear;                           /* 無限ループ（流れる帯・マーキー） */
}
```

| 対象 | 値 | 備考 |
|---|---|---|
| ボタン・一覧行の hover | `transition: background var(--dur-fast) var(--ease-out)` | `transition-all` は使わない（Orca でも 24回しかない） |
| 分割 divider の hover | `transition: background var(--dur-instant) var(--ease-out)` | Orca と同値（100ms） |
| **モード切替** | ツールバーを `opacity` ＋ `translateY(-4px)` で `--dur-exit`／`--dur-slow` でクロス。**コンテンツ（`<webview>`）は動かさない** | `<webview>` に transform をかけると guest が再合成されて録画にコマ落ちが出る。Orca が View Transition の root クロスフェードを `0s` で切っているのと同じ判断 |
| 指摘一覧の出現 | 各行を `opacity 0 → 1` ＋ `translateY(4px) → 0`、`--dur-base var(--ease-out) both`、**行ごとに 24ms stagger（最大12行ぶん＝288msで打ち切り）** | Orca の `tasks-workspace-in`（`translateY(4px)`）と同形。stagger は Orca にない追加 |
| 指摘行の削除 | `opacity 1 → 0` ＋ `scale(0.98)`、`--dur-exit var(--ease-in) both` → 高さを `--dur-base var(--ease-spring)` で畳む | Orca の `agent-card-exit` と同形 |
| 録画開始の確認 | 録画ボタン位置から `rec-start-ring 460ms ease-out forwards`（`scale(0.4) → 1.4`、`opacity .9 → 0`） | Orca `feature-wall-click-ring` と同値 |
| 録画中のドット | `rec-pulse 1.6s ease-in-out infinite`（`opacity 1 ↔ .35`） | |
| 録画中のレベルメーター | バー5本を `waveform 1.4s ease-in-out infinite`、`animation-delay` を `0 / 120 / 240 / 120 / 0 ms` | Orca `waveform` と同値。マイク入力がある時だけ再生し、無音では止める |
| Agent のスピナー | **Orca の実装をそのまま採る**: `@keyframes { to { transform: rotate(86400turn) } }` ＋ `animation: … 86400s steps(1036800, end) infinite` | **JS で毎フレーム書くとターミナルのタイピングが stall する（Orca が #12359 で実測）** |
| ペンの線 | **アニメーションしない** | 録画映像に写るので、再生時に不自然になる |
| トースト | `sonner`。`gap: 10px`、`padding: 14px 16px`、`box-shadow: var(--shadow-floating)`、本文 `line-height 1.45` / タイトル `1.35` | Orca `main.css:422-462` と同値 |
| **`prefers-reduced-motion: reduce`** | **無限ループは全て `animation: none`、トランジションは `transition-duration: 0ms`。単発の enter/exit は残す** | Orca は keyframes 定義の**直後ごとに** `@media (prefers-reduced-motion: reduce)` ブロックを置いており、CSS 全体で11箇所ある（`main.css:1620, 1737, 1800, 1860, 1949, 2493, 2573, 2826` 他）。**同じ規律を最初から守る** |
| テーマ切替中 | `.theme-transition-disabled * { transition: none !important }` | Orca と同値。変数一括差し替え時のバラバラなフェードを防ぐ |

**View Transitions API について**: Orca はダッシュボードのポップアウトでだけ使い、`agent-board-transitions.css` を**そのウィンドウからのみ import している**（理由がファイル冒頭に明記: 「these document-global pseudo rules never affect the main window」）。本システムのモード切替は同一ウィンドウで `<webview>` を保持したまま行うため、**View Transitions は使わない**（root のスナップショットに `<webview>` が入ると挙動が読めない）。

#### 2.7.3 アイコン

| 項目 | 値 | 根拠 |
|---|---|---|
| **ライブラリ** | **`lucide-react` ^0.577.0** | `orca/package.json:276`。Orca はこれ一本で**345種**をインポートしている（他のアイコンライブラリは使っていない） |
| UIプリミティブ | `radix-ui` ^1.6.2、`tw-animate-css` ^1.4.0、`sonner` ^2.0.7（トースト）、`cmdk`、`class-variance-authority`、`clsx`、`tailwind-merge` | `orca/package.json:287, 310, 306` |
| **既定サイズ** | **14px**（`size-3.5` 1333回 ＋ `size={14}` 98回）。密な場所 12px、ボタン内の既定 16px | 2.2 節参照 |
| 系統 | lucide の既定（`stroke-width: 2`、丸いキャップ、24×24 グリッド）をそのまま。**塗りアイコンは使わない** | Orca も変更していない |
| 色 | 既定は `currentColor`（親の文字色を継承）。状態色は状態トークンから直接当てる | |
| ローディング | **`Loader2` に統一**（Orca は `Loader2` 150回と `LoaderCircle` 108回が併存している。これは真似しない） | |
| 使うアイコン一覧 | 2.2 節の表（録画 `Circle`/`Disc`、停止 `Square`、一時停止 `Pause`、ペン `PenTool`、テキスト `Type`、消去 `Eraser`、ナビ `ArrowLeft`/`ArrowRight`/`RefreshCw`、端末幅 `Monitor`/`Smartphone`、閉じる `X`、削除 `Trash2`、編集 `Pencil`、要確認 `TriangleAlert`、送信 `ArrowUp`、コピー `Copy`、履歴 `History`、設定 `Settings`、ターミナル `SquareTerminal`） | |

**「ワクワクする」に効く具体策（Orca にない追加）**

1. **録画開始の瞬間に1回だけリングを出す**（`feature-wall-click-ring` の値を流用）。押した感触が最も効く場所。
2. **フィードバックモードへの切替をツールバーのクロスフェードで見せる**。コンテンツは動かさないので安全かつ「モードが変わった」が伝わる。
3. **指摘一覧の行を 24ms stagger で入れる**。「録画が12件の指摘になった」ことが視覚的に伝わる唯一の瞬間。
4. **送信ボタンだけグラデーション＋hover で明るくする**。1画面に1つの主アクションなので密度を壊さない。
5. **録画中の 2px の流れる帯**。共有画面でも「録画中」が分かり、かつ `linear` の無限ループなので CPU に乗らない（`background-position` のみ）。
6. **レベルメーターを波形5本にする**（FeedbackRecorder は単色バー1本＋`METER_GAIN = 6`）。マイクが生きていることが一目で分かる。

**やらないこと**: 面へのグラデーション、blur / backdrop-filter（Orca が「rendering glitch に見えた」として scrim に置き換えている）、`backgroundMaterial: 'acrylic'`（Orca は Windows のみ・設定で明示 ON のときだけ。macOS の `vibrancy` は「不透明背景の裏に隠れたうえで WindowServer のフレーム毎 alpha コンポジットを強制していた」として指定していない）、パーティクル・イージングの効いた視差、ページ遷移のスライド。**録画中のコマ落ち（NF-4）とターミナルのタイピング遅延（NF-6）が最優先の要件なので、GPU合成に乗らない演出は入れない。**

---

## 3. 採用する実装上の学び

### 3.1 内蔵ブラウザ

| 何を | なぜ | 参照元 |
|---|---|---|
| **`<webview>` タグを使う。`WebContentsView` は使わない** | Orca は内蔵ブラウザ本体を `<webview>` で実装し、`WebContentsView` はポップアップ窓のオリジンバーだけに使っている。`BrowserView` は未使用 | `orca/src/renderer/src/components/browser-pane/host-guest/browser-page-webview.ts:58-67`、`orca/src/main/browser/popup-origin-bar-window.ts:1,132-137` |
| **配置は CSS Anchor Positioning。main に矩形を送って `setBounds` しない** | `positionAnchor` ＋ `anchor()` / `anchor-size()` で DOM 要素に貼り付ける。計測も state も不要になる。`src/main` 全体で `setBounds` を呼ぶのは1箇所だけ | `orca/src/renderer/src/components/browser-pane/assemble-chrome/BrowserPaneOverlayLayer.tsx:70-82` |
| **`<webview>` を DOM reparent してはいけない。アンカーを差し替える** | reparent すると guest が破棄される。Orca は BrowserPane をワークツリーレベルでレンダリングし、タブ移動はアンカーの差し替えだけにしている。**本システムは2モードでブラウザを共有するので、これが必須**（モード切替で guest を破棄したらページがリロードされ、ログイン状態と録画が壊れる） | 同 `:20` |
| **非アクティブ時は破棄せず `display:flex; opacity:0; pointer-events:none`** | `display:none` のサブツリー内では Chromium が決して paint しないので、**祖先が1つでも隠されると `<webview>` が screencast フレームを出さなくなる** = 録画が止まる | `orca/src/renderer/src/components/browser-pane/host-guest/browser-guest-paint-retention.ts:20-24`、`browser-page-viewport.ts:239-263` |
| **キャプチャ時だけ強制描画する（参照カウント式の `holdPaintForCapture()`）。one-way にしてキャプチャ側がページのフレームを待ってリトライする** | throttled な renderer がキャプチャを stall させないため | `orca/src/main/browser/browser-manager-visibility.ts:10-39` |
| **新タブの白フラッシュ抑止**: `load-commit` で blank URL なら `visibility:hidden` | 画面共有中の白フラッシュは目立つ | `orca/src/renderer/src/components/browser-pane/host-guest/browser-page-webview.ts:77-85` |
| **端末幅の切替は CDP `Emulation.setDeviceMetricsOverride` ＋ `setVisibleSize` ＋ `setTouchEmulationEnabled`。Electron の `webContents.setDeviceEmulation` は使わない**（Orca でも未使用） | プリセットは Chrome DevTools に一致させる: `320×568`/`375×667`/`425×812`/`768×1024`（dSF 2, mobile true）、`1024×768`/`1440×900`/`1920×1080`（dSF 1, mobile false）＋「既定」= null | `orca/src/main/browser/browser-manager-viewport.ts:154-185`、`orca/src/shared/browser-viewport-presets.ts:15-72` |
| touch emulation の無効化は `{enabled:false}` のみを送る | Chromium は無効化時でも `maxTouchPoints` が 1..16 外だと拒否するので、mobile を抜けた後も touch emulation が残る（Chromium #22749） | `browser-manager-viewport.ts:11-13` |
| CSS ボックス幅は `${width}px` を**そのまま使わない**。UI zoom で CSS px が再定義されるため変換する | 変換しないとエミュレート幅より大きくなり横に未描画帯が残る | `browser-page-viewport.ts:140-165` |
| **Cookie partition は `persist:ade-movie-browser`。main 側で allowlist 検証して fail-closed にする** | `will-attach-webview` で非許可 partition は `event.preventDefault()`。さらに `delete params.preload` / `delete params.preloadURL` でレンダラ指定の preload を**破棄**し、`sandbox` / `contextIsolation` を強制する。レンダラのバグが Node を非特権 guest に密輸できないようにする | `orca/src/main/window/main-window-webview-security.ts:61-110` |
| **デバッガを detach してはいけない** | per-guest state が消える | `browser-manager-viewport.ts:37` |

### 3.2 要素情報の取得（EXT-4）

Orca の Grab 実装をほぼそのまま採る。

| 何を | なぜ | 参照元 |
|---|---|---|
| **セレクタ生成**: 子孫方向に `' > '` で積み上げ、各段で `querySelectorAll(sel).length === 1` を確認して**一意になった時点で打ち切る**。一意でなければ `:nth-of-type(n)` を付加。最大10段、`body` で停止、700文字クランプ | 短く、かつ再現性のあるセレクタになる | `orca/src/main/browser/grab-guest-element-context-script.ts:76-93` |
| **クラスの安定性判定**: 60文字超を除外、`/^css-[a-z0-9]+$/i`（emotion）を除外、「12文字以上＋数字＋大文字を含む」ハッシュ風を除外。残りから最大2個 | ビルドごとに変わるハッシュクラスをセレクタに入れない | 同 `:21-35` |
| **人間可読パスも別に持つ**（`aria-label`/`role`/クラスを優先、最大6段） | Agent が「どこの何か」を把握しやすい。`feedback.md` の「要素」行に使う | 同 `:95-118` |
| **HTML は `cloneNode(true)` → `<script>` を全削除 → `outerHTML` → 4096文字でクランプ**（超過時は末尾に `' (truncated)'`） | コンテキストを圧迫しない | `orca/src/main/browser/grab-guest-content-script.ts:60-69` |
| **computed CSS は固定16プロパティだけ**: `display, position, width, height, margin, padding, color, backgroundColor, border, borderRadius, fontFamily, fontSize, fontWeight, lineHeight, textAlign, zIndex`。出力時に `auto` / `normal` / `position:static` / `display:inline` / `rgba(0, 0, 0, 0)` を**ノイズとして捨てる** | これで出力ノイズが激減する | `orca/src/main/browser/grab-guest-foundation-script.ts:50-54`、`browser-annotation-output.ts:104-118` |
| **秘密情報の遮断**: `access_token, auth_token, api_key, apikey, client_secret, oauth_state, x-amz-, session_id, sessionid, csrf, secret, password, passwd` を含むキー／値は `[redacted]`。URL は `http:`/`https:`/`file:` のみ許可し、**query と hash を必ず削除**。パース失敗時は空文字（`javascript:` を温存しないため） | `feedback.md` は Agent に渡るファイルなので、トークンが混入すると漏洩になる。**NF-2 の延長として必須** | `grab-guest-foundation-script.ts:42-46, 72-89` |
| **React メタデータを取る**: `__reactFiber$` / `__reactInternalInstance$` から fiber を取り、最大35段遡ってノイズ名を除いた最大6個のコンポーネント名を `<Outer> <Inner>` 形式に。`_debugSource` から `file:line:col` を抽出し `webpack-internal://` / `turbopack://` 等のプレフィクスを剥がす | **Agent が該当コードを一発で特定できる**。本システムの差別化（概念書 4「Web固有の情報を同梱」）を最も強化する | `orca/src/main/browser/grab-guest-react-script.ts:11-93` |
| **切り抜き画像は `webContents.capturePage()` → `NativeImage.crop()`**。`html-to-image` は使わない | ネイティブ依存なし。描画どおりに撮れる | `orca/src/main/browser/browser-grab-screenshot.ts:26-106` |
| **スケール係数はゲストに聞いて導出する**: `scaleFactor = bitmapWidth / await guest.executeJavaScript('window.innerWidth')` | `capturePage` は物理ピクセル、矩形は CSS ピクセル。primary display の `scaleFactor` を使うと**混合DPIのマルチモニタで間違える** | 同 `:61-70` |
| キャプチャ前にペン・注釈レイヤーを `display:none` に退避し、`try/finally` で復元 | ただし**本システムではペン線は画像に写ってよい**（03_design.md「画像への後合成は不要」）。退避するのは UI クローム（連番バッジ・ツールバー）だけにする | 同 `:4-20, 47-53` |
| **予算値**: textSnippet 200 / nearbyText 200×10件 / htmlSnippet 4096 / ancestorPath 10 / nearbyElements 160×6件 / selector 700 / path 900 / selectedText 500 / sourceFile 500 / reactComponents 500 / コメント 2000 / 1ページ20件 / スクショ 2MB | クランプ値を1ファイルに集約する（型と一緒に置く） | `orca/src/shared/browser-grab-types.ts:178-196` |
| **注釈を永続化するときスクショは捨てる**（`screenshot: null`） | 「annotations are persisted; screenshot data is a transient copy payload that can be megabytes per selection」。**本システムは逆に画像をファイルとして持つが、`session.json` に base64 を入れないという教訓は同じ** | `orca/src/renderer/src/components/browser-pane/describe-page/browser-annotation-geometry.ts` |

### 3.3 Agent の PTY へプロンプトを送る（OUT-2）

**これが最も実装を間違えやすい箇所で、Orca は3系統・多数の実測コメントを持っている。**

| 何を | なぜ | 参照元 |
|---|---|---|
| **送信シーケンス（これを採用する）**:<br>① 送信前に readiness を確認し `'sendable'` でなければ送らない<br>② `\x1b[200~` ＋ sanitize した本文 ＋ `\x1b[201~` を**1回の write で**送る（Enter は付けない）<br>③ **50ms 待つ**<br>④ **readiness を再確認**（失うと partial-submit 扱い）<br>⑤ `\r` を**別の write で**送る | Claude 系は本文と Enter を同一 write にすると編集可能テキストのまま残ることがあり、また大きなフレームが独立チャンクに分割されると先頭を落とすことがある | `orca/src/renderer/src/lib/active-agent-note-send-delivery.ts:48-141`、`agent-paste-draft.ts:37, 240-243`、`orca/src/main/runtime/orca-runtime-write-terminal-agent-prompt.ts:61-67` |
| **改行の扱いは経路で違う。本システムは renderer 経路なので `/\r?\n/g → '\r'` に正規化する** | xterm のネイティブ paste はクリップボードの改行を全て CR に変換するので、直接フレームもそれに合わせないと ConPTY の TUI が生の LF を submit と解釈しうる | `orca/src/renderer/src/components/terminal-pane/terminal-bracketed-paste.ts:71-80` |
| **ESC は無害化する**: renderer 経路は `␛`（可視 ESC）に置換 | ブラケットペースト内の ESC が枠を壊す | 同 `:48-65` |
| **64KiB 超は分割送信**。開始マーカー → 本文チャンク → 終了マーカーを個別 write し、**失敗時も `201~` を必ず流して枠を閉じる**。正規化は分割**前**に全体へ（CRLF が境界をまたがないため） | `feedback.md` の指示文は1行なので通常は該当しないが、「コピー」ではなく本文を直接流す将来の実装で必要 | `orca/src/renderer/src/lib/agent-draft-paste-content.ts:19-21, 74-146, 212-225` |
| **起動直後はコンポーザ準備完了を待つ**: 静止 **1500ms**、タイムアウト **8000ms**。シグナルは `\x1b[?2004h`（ブラケットペースト有効化）、codex の `›`、`\x1b[?25h` | `claude` を起動した直後に送ると落ちる | `orca/src/renderer/src/lib/agent-draft-readiness.ts:9`、`orca/src/shared/draft-paste-ready-scanner.ts:6-93`、`draft-paste-ready-timeout.ts:4-12` |
| **busy のときの扱い**: `working` は**通す**（Agent のコンポーザにキューさせる）。`permission` ダイアログ中は**拒否**して理由を返す（`terminal_guard_permission`）。割り込み（`\x03`）は明示指定時のみ | 「処理中だから送らない」ではなく「権限待ちだから送らない」が正しい境界 | `orca/src/main/runtime/rpc/terminal-agent-send-guard.ts:15-43` |
| **画像・ファイルの渡し方**: 画像対応 Agent（claude, codex, gemini, cursor, copilot, droid, grok）には**生の絶対パスをブラケットペーストで包んで**送る（端末への画像ドロップに見せる）。非対応は `@パス` メンション記法（空白や `@` を含めば `@"..."`） | 「A plain typed path (or @file mention) is treated as text/file-read」。**本システムは `feedback.md` のパスを渡すので `@` ではなく素のパスを本文に書く形**になるが、将来「画像だけ直接渡す」経路を作るならこの分岐が要る | `orca/src/shared/agent-image-paste.ts:10-51`、`orca/src/renderer/src/components/native-chat/native-chat-send.ts:43-47` |
| 画像パスは**一時ファイルに書いてパスを渡す**。ファイル名は `ade-movie-paste-${Date.now()}-${randomUUID()}.png` | Orca の設計意図が明快: 「既存の、実証済みで環境非依存の機構を再利用する。直接送信を再配管しない」 | `orca/src/main/window/clipboard-image-temp-file.ts:30`、`markup-clipboard-delivery.ts:1-9` |
| **PTY への write は 16KiB ごとにチャンクし、間に `setImmediate` を挟む** | abort / data コールバックを間で走らせる。`setTimeout(0)` は Chromium に 4ms クランプされ純粋なレイテンシになる | `orca/src/main/ipc/pty/ipc/write-input.ts:103-128` |
| **ブラケットペースト定数は1ファイルに置く** | `AGENT_PROMPT_BRACKETED_PASTE_START = '\x1b[200~'` / `_END = '\x1b[201~'` / `_SUBMIT = '\r'` | `orca/src/shared/agent-prompt-injection.ts:6-8` |

### 3.4 ターミナル（NF-6: 入力から描画まで33ms以内）

| 何を | なぜ | 参照元 |
|---|---|---|
| **xterm.js の初期化オプション（本システムの確定値）**:<br>`allowProposedApi: true`、`cursorBlink: true`、`cursorStyle: 'block'`、`cursorInactiveStyle: 'outline'`、`fontSize: 14`、`fontWeight: '300'` / `fontWeightBold: '500'`、`lineHeight: 1`、`scrollback: 5000`、`scrollSensitivity: 1.15`、`fastScrollSensitivity: 5`、`allowTransparency: false`、`macOptionIsMeta: false`、`macOptionClickForcesSelection: true`、`drawBoldTextInBrightColors: true`、`scrollbar: { width: 7 }`、`vtExtensions: { kittyKeyboard: true }` | Orca の実値。`macOptionIsMeta: false` の理由は「非US配列は Option で `@` / `€` を合成する」 | `orca/src/renderer/src/lib/pane-manager/pane-terminal-options.ts:31-76` |
| フォントスタック | `"SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace` | 同 `:41-42` |
| `minimumContrastRatio` | **背景輝度で決める**: ライト背景 4.5 / ダーク背景 3。アプリのテーマではなく**合成後の背景**で判定する | `orca/src/renderer/src/lib/terminal-contrast-correction.ts:18-37` |
| **アドオンのロード順（`terminal.open()` の後）**: `fit` → `search` → `serialize` → `unicode11` → `webLinks`。**WebGL は `open()` の後**。unicode provider は**いかなる write より前**に register する（CJK/ZWJ 幅がバッファに焼き込まれるため） | 日本語を扱う本システムでは unicode provider の順序が致命的 | `orca/src/renderer/src/lib/pane-manager/pane-lifecycle.ts:51-100` |
| **WebGL addon（243KB）は first paint の後に動的 import する** | boot graph から外しつつ、どのペインが attach するよりずっと前に解決される。Orca は「9つの boot-path モジュールが `pane-webgl-renderer` を import していたため毎回引き込まれていた」と実測 | `orca/src/renderer/src/main.tsx:81-85`、`terminal-webgl-addon-loader.ts:4-14` |
| **WebGL のフォールバックはペイン単位でラッチする**（モジュール global にしない） | Orca は「以前はモジュール global ラッチだったため1ペインの失敗が全ペインを DOM に固定していた」と明記 | `orca/src/renderer/src/lib/pane-manager/pane-webgl-renderer.ts:30-36, 318-333` |
| コンテキストロスト時は `WEBGL_lose_context.loseContext()` を明示呼び出し＋canvas を 0×0 に縮小 | dispose だけでは Windows/ANGLE がドライバコンテキストを残し Chromium の WebGL コンテキスト予算に当たる | 同 `:162-176` |
| Chromium に `--max-active-webgl-contexts=128` を渡す | 既定 16 を超えると最古のコンテキストが**黙って**退避され DOM に格下げされる | `orca/src/main/startup/configure-process.ts:322-324` |
| Linux で WebGL を使わない条件 | Wayland（入力が wedge する）、WebGL2 なし、`WEBGL_debug_renderer_info` 取得不能、`swiftshader|llvmpipe|softpipe|software rasterizer|software adapter|basic render|virgl|svga3d` に一致 | `terminal-webgl-auto-policy.ts:16-17, 74-142` |
| **PTY → xterm のバッチング（main 側）**: バッチ間隔 **2ms**、flush チャンク **16KiB**、1回の flush で最大 **2 write**、in-flight 上限は PTY 単位 **512KiB** / 全体 **8MiB** | | `orca/src/main/ipc/pty/delivery/constants.ts:1-17` |
| **interactive 判定（レイテンシの核）**: 1024文字以下は無条件 interactive、超える場合は 16KiB 以下かつ `\x1b[` を含むときのみ。最終入力から **100ms** 以内かつ **32KiB** 予算内なら 2ms バッチを待たず即送信 | 「Codex 系 TUI は1打鍵で 1KB 超を再描画する」 | `orca/src/main/ipc/pty/delivery/interactive.ts:9-33` |
| **renderer のドレインは `requestAnimationFrame` ではなく `MessageChannel`** | 「Chromium は nested `setTimeout(0)` を約4msにクランプする。post したマクロタスクはクランプされず、しかも input/paint には譲る」 | `orca/src/renderer/src/lib/pane-manager/pane-terminal-output-queue-registry.ts:129, 202-206` |
| **renderer のドレイン定数**: 背景 flush 遅延 **50ms**、背景ドレイン間隔 **16ms**、高優先度 **4ms**、チャンク **16KiB**、1ドレインの write 数 2（高優先度 **8**）、時間予算 **8ms**、大バックログ判定 **512KiB**、バックログ上限 `max(2MiB, scrollback行数 × 120)` | 高優先度を 8 にした根拠が実測で書かれている: 「8 × 16KB = 128KB ≈ 1.3ms パース → 8ms 予算内で持続上限約 **30MB/s**。2 のときは 100MB/s のパーサに対して 8MB/s しか出ていなかった」 | 同 `:90-101` |
| **ACK は TCP 風の累積 ACK にし、ドレイン（parse）の時点まで遅延させる** | enqueue 時点で ACK すると in-flight ウィンドウが「受信済みバイト」になり、洪水時に renderer のキューが無制限に伸びて main がバックプレッシャを見ずに出力を捨てる。**破棄した chunk も必ずクレジットする**（しないと in-flight ウィンドウが恒久的に縮んで PTY が wedge する） | `orca/src/renderer/src/components/terminal-pane/terminal-pty-ack-gate.ts:25-107`、`pane-terminal-output-queue-registry.ts:211-251` |
| **真のバックプレッシャは node-pty の `pause()`** | 「pause() stops reading the master fd, so a flooding child blocks on write」。全体 4MiB 超で pressured、個別セッション 64KiB 超で pause | `orca/src/main/providers/local-pty-session-operations.ts:45-48`、`orca/src/main/daemon/daemon-stream-backpressure.ts:4-7` |
| **バックログ破棄時は警告文の先頭に `\x18`(CAN) ＋ `\x1b[?2026l` を置く** | 捨てた末尾が DEC 2026（同期出力）の終了を持っていた可能性があり、xterm が 1000ms タイムアウトまで再描画を止める | `pane-terminal-output-queue-registry.ts:110-118` |
| **リサイズは時間デバウンスではなく「グリッド安定待ち」** | `requestAnimationFrame` を繰り返し `proposeDimensions()` が2フレーム連続同値になるまで待ち、最大 **8フレーム**で打ち切る。提案グリッドが現在値と同じなら `fit()` を呼ばない。理由: 「Windows は右サイドバーを開くと1列ぶれが起き、Codex に SIGWINCH ループを送って可視的に振動する」 | `orca/src/renderer/src/lib/pane-manager/pane-fit-resize-observer.ts:12, 93-153`、`pane-fit.ts:127-131` |
| **入力の出自を xterm の内部 API で分離**: `terminal._core.coreService.onUserInput` | 公開 `onData` は focus report / DA / DSR / CPR が混ざる。内部 API 不在時は null でフォールバック | `orca/src/renderer/src/components/terminal-pane/terminal-user-input-signal.ts:3-29` |
| **クエリ応答はデバウンスをスキップして即送信** | querying program は短タイムアウトの raw mode で読む | `orca/src/renderer/src/components/terminal-pane/pty-connection/pty-input-forward.ts:90-92` |
| **refresh は WebGL があるとき非同期、DOM のときだけ同期** | WebGL があるときは xterm が既にキューしたフレームにマージされる。dirty row span に `0..rows-1` を要求しない（render debouncer が範囲を union して全ビューポート走査になる） | `orca/src/renderer/src/components/terminal-pane/pty-connection/connect-pane-pty.ts:49-50`、`pane-terminal-foreground-render-settle.ts:65-75` |
| **ローカルエコー・予測入力は実装しない** | Orca も実装していない。PTY からのエコーを待ち、それを最優先で素早く塗る方式 | リポジトリ全体に `predictive|local.echo|speculative.echo` の実装なし |
| **性能ゲートの数値（本システムの目標値に採る）**: 打鍵→エコーの median **25ms**、worst **300ms**、scroll 150ms、restore 1000ms、renderer のキュー文字数 2MiB、**破棄バックログ 0** | Orca は median を 75ms → 25ms に厳格化し、観測最大 median 13.8ms と記録している。NF-6 の「2フレーム・約33ms以内」はこの水準で達成可能 | `orca/config/scripts/terminal-perf-report-budgets.mjs:4-14`、`orca/docs/reference/terminal-perf-report-budgets.md` |
| ターミナルテーマ（既定ダーク） | `background #282c34` / `foreground #ffffff` / `cursor #ffffff` / `selectionBackground #5a7898` / 16色は Tomorrow Night 系（`#1d1f21 #cc6666 #b5bd68 #f0c674 #81a2be #b294bb #8abeb7 #c5c8c6` ＋ bright `#666666 #d54e53 #b9ca4a #e7c547 #7aa6da #c397d8 #70c0b1 #eaeaea`） | `orca/src/shared/terminal-themes/defaults.ts:6-29`。selection は Orca が Ghostty 原典 `#3e4451` から引き上げた値（Codex 系グレーブロックに溶けるため） |
| `terminal.options.theme` への書き込みは**値ゲートする** | theme 書き込みはパレットを再構築し、**TUI の OSC 4/10/11/12 変更を破棄する** | `orca/src/renderer/src/components/terminal-pane/terminal-appearance.ts:113-168` |
| **`scrollback: 0` を TUI 中に強制してはいけない** | normal → alt の順に出力するため、alt 画面中の 0 は TUI バイトでなく直前のシェル出力を落とす | `orca/src/renderer/src/components/terminal-pane/pty-connection/pane-serializer-register.ts:41-47` |
| 非アクティブタブは **30秒後に park**（React サブツリーごとアンマウント＝xterm 破棄）。直近 **6件**・**5分**は保持。最後にアクティブだった1件は免除 | 保持する hidden pane 1枚あたり 5000行で約 2.5MB、50000行で約 19MB の V8 heap（Orca のコード内実測） | `orca/src/renderer/src/components/terminal-pane/terminal-hidden-view-parking.ts:15-21`、`terminal-hidden-worktree-retention.ts:14-32`。**本システムはタブ数が少ないので park は MVP で実装しない。ただし scrollback 5000 の既定は守る** |

### 3.5 Agent の状態検知（ターミナルタブの状態表示）

herdr が最も作り込まれている。**本システムは並列管理をしないので、herdr の設計のうち「状態の定義」「確定遅延」「`done` の意味」だけを採り、マニフェスト駆動のルールエンジンは作らない。**

| 何を | なぜ | 参照元 |
|---|---|---|
| **状態は検知層で4値**: `Idle` / `Working` / `Blocked` / `Unknown`。`Done` は**検知層に存在せず表示層の派生値** | herdr の派生規則: `(Idle, seen=false) → Done` / `(Idle, seen=true) → Idle`。これが `done → idle` に戻る唯一の条件 | `herdr/src/detect/mod.rs:10-20`、`herdr/src/app/api_helpers.rs:96-107` |
| **`seen` の更新規則**: Idle 以外の状態になれば常に `seen = true`。`Working|Blocked → Idle` の完了遷移では、**見ているタブなら即 seen（Idle 表示）、見ていないタブなら unseen（Done 表示）** | 「終わったのに気づいていない」を UI で表せる。**本システムではフィードバックモード中に Agent が完了したことを、モードを戻したときに示せる** | `herdr/src/app/actions.rs:22-43, 1813-1843` |
| **判定の入力は3つ**: 画面末尾テキスト、OSC 0/2 タイトル、OSC 9 プログレス。**プロセス名は「どの Agent か」の同定だけに使い、状態判定には使わない** | | `herdr/src/detect/manifest.rs:20-25`、`herdr/src/detect/mod.rs:81, 249-282` |
| **OSC 由来のルールを最優先にする**（herdr では priority 1000〜1100） | OSC は画面テキストより信頼度が高い。**本システムは MVP で OSC タイトルだけを見る簡易版にする**（claude: `✳ ` 始まり = idle / Braille または `◐◑◒◓` 始まり = working、codex: `Action Required` = blocked / Braille = working） | `herdr/src/detect/manifests/claude.toml:13-14, 217-230`、`codex.toml:6-20` |
| **`working → idle` はチャタリング防止のため保留する**: 100ms おきに再チェックして **3回確定で publish**、または **700ms で強制 publish**。ただし画面に明示的な idle クロームが見えていれば即 publish | 無保留だと状態表示が点滅する | `herdr/src/pane/agent_detection.rs:5-77` |
| **Agent 起動直後 3秒は状態を publish しない** | 起動中の過渡状態を拾わない | 同 `:12-13`、`herdr/src/pane.rs:2994-3008` |
| **blocked の間は 800ms おきに再 publish** | 通知を取りこぼさない | 同 `:158-170` |
| **プロセス終了は必ず `visible_idle` 付きの Idle**（保留をバイパスして即確定） | 同 `:307-315` |
| **ポーリング間隔**: Agent 未同定 500ms / 同定済み 300ms。**Idle かつ PTY にバイト到着がなければ画面を読まない** | 無駄読みを避ける | `herdr/src/pane.rs:2706-2764`、`herdr/src/pane/agent_detection.rs:91-105, 338-341` |
| **「出力の静止時間」で working を判定してはいけない** | herdr はドキュメントコメントが示唆するのに**実コードに静止タイマーによる working 判定を持たない**。出力変化はプロセス取得ウィンドウと画面スキャンのスキップ判定にだけ使っている。これは意図的な設計 | `herdr/src/detect/mod.rs:35-37` vs `manifest.rs:229` |
| **トランスクリプトビューア・モデルピッカーを開いている間は状態を凍結する**（`skip_state_update`） | 履歴を眺めているのを idle と誤認しない | `herdr/src/detect/mod.rs:23-39`、`herdr/src/pane/agent_detection.rs:300-319` |
| **タイトルのスピナー文字を剥がす**: 先頭1文字が Braille（`U+2800`–`U+28FF`）または `·✢✳✶✻✽◐◓◑◒` で直後が空白なら除去。スピナーだけの差分では再描画を抑制する | タブのタイトルが1秒に何回も書き換わるのを防ぐ | `herdr/src/terminal/title.rs:1-20`、`herdr/src/app/terminal_titles.rs:219-233` |
| **状態の記号は「色だけ」で区別する既定を持つ** | herdr の既定 `dots` は Working/Blocked/Done が同じ `●` で色だけ違う。記号版（`◐` / `×` / `✓` / `○`）は設定で選べる。**本システムはタブ内の 8px ドットで色のみ**にする | `herdr/src/client/shell.rs:178-201` |
| **並び順の優先度**: Blocked=4, Done=3, Working=2, Idle=1, Unknown=0 | 複数タブがあるときの表示順 | 同 `:203-212` |
| **スピナーアニメーションは「1日1イテレーション」の CSS keyframes にする** | Orca: `@keyframes agent-spinner-rotate { to { transform: rotate(86400turn) } }` ＋ `animation: … 86400s steps(1036800, end) infinite`（見た目 12 steps/s）。**毎秒の JS style 書き込みがタイピングの stall を起こした経緯（#12359）がコメントに残っている**。`prefers-reduced-motion` で `animation-duration: 0ms` | `orca/src/renderer/src/assets/main.css:1608-1618, 1743` |
| デスクトップ通知 | mac は `terminal-notifier -title .. -message ..`、失敗時 `osascript display notification`。Linux は `notify-send --app-name ... --`。Windows は WinRT トースト | `herdr/src/platform/macos.rs:739-830`、`linux.rs:898-916` |
| **hidden ページのタイマークランプを無効化する**: Chromium に `--disable-features=IntensiveWakeUpThrottling` | Chromium は全デスクトッププラットフォームで5分後に hidden ページのタイマーを 1/分にクランプし、**agent-done / bell 通知を約60秒遅らせる** | `orca/src/main/startup/configure-process.ts:81-85` |

### 3.6 録画・音声（REC / AUD）

FeedbackRecorder からそのまま採る。

| 何を | なぜ | 参照元 |
|---|---|---|
| **MediaRecorder の設定**: mimeType は `video/webm;codecs=vp9,opus` → `vp8,opus` → `video/webm` の順で `isTypeSupported` を試す。`videoBitsPerSecond = clamp(pixels × 30 × 0.08, 4e6, 16e6)`、`audioBitsPerSecond = 128000`、**`start(2000)`（timeslice 2秒）** | 1080p で約 5.0Mbps、4K で 16Mbps 上限。チャンクは配列に溜め、停止時に `new Blob(chunks)` で結合 | `feedbackrecorder/app/src/renderer/app.js:1144-1151, 1259-1284` |
| **WebM のまま remux しない** | 「FFmpeg は読めるし、エージェントは動画を開かない」 | `feedbackrecorder/docs/APP_DESIGN.md:378-379` |
| **録画中に画面が消えたら `videoTrack` の `ended` で早期停止し、劣化として記録する** | NF-12（耐障害）の一部 | `app.js:1277-1281` |
| **WAV 変換は ffmpeg を使わず `AudioContext({ sampleRate: 16000 })` でデコード → 自前で 44バイト RIFF ヘッダ＋16bit PCM を書く** | `sampleRate: 16000` を指定するとデコード時点でリサンプルされるのでリサンプリングコードが不要。**16kHz / 1ch / 16bit が whisper.cpp の要求** | `app.js:1409-1420`、`app/src/shared/wav.js:3-5, 31-65` |
| **マイク取得に 12秒のタイムアウトを置き、600ms 超えたら「待っています」を出す。タイムアウト後に遅れて解決したストリームは自動で stop する** | macOS の権限プロンプトが未応答だと `getUserMedia` の promise が**永久に解決しない** | `app.js:924-957` |
| マイク制約 | `{ deviceId: { exact }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }` | 同 `:969-979` |
| **ナレーション音量を dBFS で実測して分類する**: `TOO_QUIET_DBFS = -45`、`SILENCE_PEAK = 1e-4`。**-45 dBFS 以下なら whisper を走らせない** | 根拠が原文で書かれている: 「speech averages about -27 dBFS, and the one run that produced an empty transcript averaged -48.9 dBFS」「Silence is where Whisper invents text: two runs over the same quiet file once produced entirely different transcripts」 | `app/src/shared/narration.js:5-13`、`app.js:1423-1437` |
| レベルメーターは `METER_GAIN = 6` で増幅して表示 | 生のレベルだと通常会話が 5% しか振れない | `narration.js:49-67` |
| 録画バー | 344×44 の frameless / transparent / `alwaysOnTop('screen-saver')` ウィンドウ。**`setContentProtection(true)` で録画映像から自分を除外**。`backgroundThrottling: false`（メーターと時計を止めない） | `feedbackrecorder/app/src/main/main.js:17, 76-101, 138`。**本システムのフェーズ2・3の「小さな常時表示バー」がこれ** |
| 画面ソースのサムネイル | `desktopCapturer.getSources({ thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons })` を **2秒ごとに更新**。カードを再構築せず `img.src` だけ差し替える（フォーカス/hover を壊さない） | `app/src/main/displays.js:9, 22-35`、`app.js:784-905` |
| **真っ暗なサムネイルは「権限未許可のシグナル」として扱う**（RGB 各 8 以下を黒判定） | NF-10（権限）の UX | `displays.js:40-47`、`app.js:760-772` |
| Retina 対応で**ネイティブピクセル**を要求し、要求解像度の 95% 未満なら劣化として記録 | `displays.js:53-55`、`app.js:1237-1245` |
| ドロップゾーンは `document` 全体で `drop` を `preventDefault` する | Chromium がファイルへナビゲートしてアプリが消える | `app.js:2241-2264` |

**FeedbackRecorder にない／逆にする判断**

- **一時停止・再開が未実装**（`pause`/`resume` の grep ヒットは `child.stderr.resume()` のみ）。本システムは REC-1 で必須なので自前実装する。`MediaRecorder.pause()/resume()` ＋ 操作ログのタイムベース補正が必要。
- **システム音声を意図的に録らない**。理由は明快: 「It keeps the audio track clean for Whisper. Music, a Teams call, notification sounds — non-speech audio is exactly what makes Whisper invent segments, and this project has already measured that happening」（`docs/APP_DESIGN.md:444-453`）。**本システムは AUD-1 で PC 音声を録るので、この警告が直接のリスクになる**。対策として PC 音声系統にも `-45 dBFS` 以下スキップと VAD を必ず適用し、音楽・通知音が混ざる前提で後段 LLM に「指摘でない発話を除外」させる（EXT-6）。

### 3.7 whisper.cpp の組み込み（EXT-1 / NF-7）

| 何を | なぜ | 参照元 |
|---|---|---|
| **バイナリはビルド時に取得する**。Windows / Linux は GitHub Releases のプリビルトアーカイブ、**macOS はプリビルト CLI が公開されていないのでソースから cmake ビルド** | `feedbackrecorder/app/scripts/fetch-vendor.js:55-66, 105-178, 391-408` |
| macOS の cmake フラグ | `-DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DWHISPER_BUILD_TESTS=OFF -DCMAKE_OSX_ARCHITECTURES='arm64;x86_64' -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0`。`GGML_NATIVE=OFF` は `-march=native` が2アーキ同時ビルドできないため、`GGML_OPENMP=OFF` は libomp がビルド機にしかないため、`GGML_METAL_EMBED_LIBRARY=ON` は Metal シェーダをバイナリに内包するため | 同 `:105-178` |
| **バージョンを commit でピン止めし、clone 後に `git rev-parse HEAD` で検証する** | 再現性 | 同 `:29-32, 126-133` |
| **ダウンロードは `.part` に書いて完了後に rename し、サイズ＋SHA-256 を照合する** | 「A half-downloaded model still loads far enough for whisper.cpp to fail deep inside itself with a message about tensor counts」 | 同 `:17-18, 307-354` |
| **モデル**: 出荷デフォルトは **`ggml-small.bin`（約488MB、非量子化、多言語）**。`.en` 版も量子化（q5_1 等）も使っていない。実行時の優先順は `small → base → medium → tiny` | 本システムは NF-7（日本語精度）と NF-3（速度）の両立が要件。**`small` を既定、技術検証で `medium` / 量子化版も実測する**（未決事項6） | `app/scripts/fetch-vendor.js:34-53`、`app/src/main/whisper.js:19` |
| **Silero VAD モデル（`ggml-silero-v5.1.2.bin`、885KB）を常用する** | 無音に whisper をかけると毎回違うデタラメが出る（実測済み） | `fetch-vendor.js:291-297`、`whisper.js:329-332` |
| **呼び出しコマンドライン**: `-m <model> -f <wav> -oj -of <stem> -t clamp(cpus-1, 1, 8) -l <lang> [--vad --vad-model <vad>]` | `-oj` だけ使い、SRT/VTT/txt は whisper に出させず自前で整形する | `app/src/main/whisper.js:126-148` |
| **`-l` は `auto` でも必ず渡す（最重要の罠）** | 原文: 「whisper.cpp documents `-l LANG [en]`, so leaving it out does not mean "detect" — it means English. Omitting it for auto is what this used to do, which quietly transcribed every other language as if it were English」。**日本語がこれで全部英語扱いになる** | 同 `:120-125` |
| 言語は**録画前に**設定する | 「The language has to be settled before recording, not after: it is what the transcriber is told, and getting it wrong produces confident nonsense rather than an error」 | `app.js:648-650` |
| 言語リストは 35個に絞る。未知コードは `en` にフォールバック | 「a dropdown with a hundred entries is worse to use, and nobody is shut out by the shortening, because "auto" detects the rest」 | `app/src/shared/languages.js:5-9, 61-67` |
| **子プロセスは `execFile`、タイムアウト 30分、`maxBuffer: 32MB`。エラーは reject せず必ず resolve して呼び出し側で判定する** | `whisper.js:112-118, 176` |
| **出力パース**: `-oj` は `{ transcription: [{ offsets: { from, to }, text }] }`（オフセットは**ミリ秒**）。秒に変換し、空テキストのセグメントは捨てる。言語は `parsed.result.language ?? parsed.params.language` | **タイムスタンプはセグメント単位**。単語単位（`--max-len 1`）は使っていない | `whisper.js:84-110` |
| **モデル破損のエラーを言い換える**: stderr/stdout が `not all tensors loaded|failed to load model` にマッチしたら「モデルが壊れている。再ダウンロードを」と出す | 「Met for real while a model was still downloading. The raw error talks about tensor counts, which tells the user nothing about what to do」 | 同 `:179-198` |
| **検出結果を出力に書く**: 「`in Japanese, detected automatically`」のように、選んだのか検出したのかを区別する | `app/src/shared/brief.js:87-92` |
| **文字起こしを「人間が待っている時間」と並行実行する** | FeedbackRecorder は音声抽出直後に promise を投げ、ユーザーがクロップ矩形を選んでいる間に走らせる。**本システムは録画中に無音区切りで逐次実行する（03_design.md 1.3）のでさらに有利。NF-3（停止から10秒以内）はこれで達成する** | `app.js:1402-1404, 1424-1430` |
| 進捗は whisper 側から取らない | `--print-progress` を使っていない。代わりにキーフレーム走査をパーセント表示している。**本システムは `--print-progress` を試す価値がある**（改善点） | — |
| パッケージングでは `extraResources` で asar 外に出し、macOS 署名時は `binaries:` にバイナリパスを明記する | `app/electron-builder.yml:24-42, 97-99` |

### 3.8 キーフレーム抽出（EXT-3 / EXT-5）

**FeedbackRecorder で最も独自性が高く、本システムが最も活用すべき部分。ffmpeg を一切使わず、renderer で `<video>` をシークして canvas にデコードする。**

| 何を | なぜ | 参照元 |
|---|---|---|
| **2パス構成**。パス1: 低解像度の署名を全尺からサンプリング。パス2: 選ばれた時刻だけフル解像度でレンダリング＋クロップ | 「Cropping a frame is free; cropping the video would mean re-encoding all of it for a file no agent opens」 | `feedbackrecorder/app/src/renderer/app.js:1767-1852, 1806-1808` |
| **署名は 96×54 のグレースケール `Uint8Array`（5184バイト）**。輝度は ITU-R BT.601（`R×299 + G×587 + B×114) / 1000`）。**署名は選択リージョンから取る** | 枠外の変化で同じ見た目の2枚が出るのを防ぐ | 同 `:1740-1759, 1736-1739` |
| **サンプリング間隔 = `clamp(duration / 900, 0.25, 2.0)` 秒**（目標 900 サンプル） | 実測コスト: 「a seek plus a decode plus a downsample is about 40 ms, so 900 samples is a little under 40 seconds」。実測表: 1分=240サンプル≈10秒 / 5〜30分=900≈38秒 / 1時間=1800≈75秒 / 2時間=3600≈150秒 | `app/src/shared/keyframes.js:348-363`、`docs/APP_DESIGN.md:343-348` |
| シークは `seeked` 待ちで **4秒タイムアウト**。MediaRecorder の WebM はヘッダに duration がないので **`1e6` 秒へシークして `video.duration` を確定させる** | `app.js:1575-1602` |
| **2スケールのスコアリング（核心）**: `mean` = 全画素の平均絶対差 / 255。`focus` = 12×9=108タイルごとの平均差を降順ソートし上位 `ceil(108 × 0.03) = 4` タイルの平均。**`severity = max(mean, focus × 0.3)`** を閾値と比較 | 原文: 「Averaging the difference across the whole picture hides anything that is not full-screen: a dialog covering an eighth of the screen moves the average by an eighth of its own contrast, which lands under any threshold loose enough to ignore video noise」 | `keyframes.js:16-22, 40-141` |
| **閾値（本システムの初期値に採用）**: `threshold 0.04` / `focusWeight 0.3` / `focusShare 0.03` / `settleThreshold 0.02` / `maxSettleSeconds 2.5` / `revisitMean 0.02` / `revisitFocus 0.09` / `minGapSeconds 0.6` / `minCount 4` | `keyframes.js:40-67`（各値にコメントで意図が書かれている） |
| **変化を検知したら「静止するまで待ってから」撮る（settle）** | 「A page load, a fade or a scroll spans several samples, so the first sample over the threshold is the middle of it and the frame that gets kept is half-drawn」。前方へ歩いて `severity < 0.02` になる最初のサンプルを採り、**2.5秒で打ち切る** | 同 `:22-27, 165-174` |
| **重複は revisit として参照だけ記録し、PNG を増やさない**。判定は **`mean ≤ 0.02` かつ `focus ≤ 0.09`** を満たすものの中で `mean` 最小。**既出の保存済みフレーム全部と比較する（直前だけではない）** | 「Clicking away and coming back is normal in a walkthrough」。**本システムでは、ペン・テキストのない発話だけの指摘が同じ画面を指すときに効く** | 同 `:27-32, 181-193` |
| **revisit されたフレームは、バジェット超過時の間引き対象から外す** | 「Coming back to a screen is also evidence it matters」「Going over is the better failure: the alternative is deleting a picture the brief still points at」 | 同 `:245-261` |
| **revisit は位置（index）ではなくレコード参照で保持し、序数は最後に一度だけ計算する** | 「positions move when frames are dropped or inserted later on, and every renumbering is a chance to point a revisit at the wrong picture」 | 同 `:176-180, 310-322` |
| **枚数は尺に比例**: `clamp(round(duration / 5), 12, 80)` | 「twelve frames over ten minutes is one picture per fifty seconds, and everything in between is lost」。**本システムは指摘単位で画像を決める（EXT-3）ので、この式は「指摘に紐づかない補助画像の上限」に使う** | 同 `:144-150` |
| **最小枚数に足りないときは等間隔でサンプルを追加するが、既存と同じ画面なら revisit として追加し PNG は増やさない** | 同 `:274-306` |
| パイプラインは `walk → trimPictures → trimRevisits → addFloor → numberRevisits` の5段。返り値は `[{ index, time, score, revisitOf }]` | 同 `:329-343` |
| **画像は PNG（`canvas.toBlob(..., 'image/png')`、quality 引数なし = ロスレス）、クロップ後のフル解像度のまま**。縮小しない | **本システムは EXT-5 で「長辺1568px」に縮小すると決めているので、ここは変える**（Agent のコンテキストを圧迫しないため） | `app.js:1761-1765, 1810-1812` |
| **`frames/` の書き込みはアトミックに**: 一時ディレクトリにステージング → 既存 `frames/` を `-previous` に rename → ステージングを `frames/` に rename → 失敗時はロールバック | 再フレーミング（本システムでは画像差し替え REV-3）が途中で死んでも壊れない | `app/src/main/package-writer.js:60-101` |
| **再フレーミング時のコメント追従**: フレーム番号は変わるので、**時刻 ±0.05秒** で同じ瞬間が残っていればコメントを新しいファイル名に付け替え、無ければ捨てる | REV-3（画像差し替え）で指摘テキストを失わない | 同 `:195-212` |
| **閾値と署名の形を `shared/` の1ファイルに置き、main / preload / renderer / テストが同じ実装を使う** | 「The renderer builds signatures to this shape; both ends read it from here so they cannot drift apart」。**閾値の二重定義が起きない** | `keyframes.js:40-44`、`app/src/preload/preload.js:104-135` |

### 3.9 出力形式（OUT-1 / 6章）

#### Orca の注釈 Markdown（本システムの `feedback.md` の直接の先行例）

`orca/src/renderer/src/components/browser-pane/annotate/browser-annotation-output.ts:155-228` の構造（原文のラベルのまま）:

```markdown
## Design Feedback: {path + search}

**URL:** {sanitizedUrl}
**Browser tab id:** {browserPageId}
**Viewport:** {w}x{h}

### 1. {<Component> tag "accessibleName"}
**Intent:** change | question
**Selector:** `{selector}`
**Location:** `{elementPath}`
**Source:** {file:line:col}
**React:** {<Outer> <Inner>}
**Bounds:** x={x}, y={y}, {w}x{h}
**Classes:** `{cssClasses}`
**Selected text:** "{...}"   /   **Text:** "{...}"
**Nearby text:**
- {...}
**Nearby elements:**
- {...}
**Computed styles:**
- {name}: {value}
**Full DOM path:** `{fullPath}`
**HTML:**
```html
{htmlSnippet}
```
**Feedback:** {comment}
```

採るべき点:

- **ページ単位ヘッダ（URL / viewport）＋ `### N. 要素ラベル` の連番セクション**。要素ラベルは `<Component> tag "accessibleName"` が最も情報密度が高い（accessibleName → textSnippet(60字) → tagName の優先順）。
- **バッククォートの最長走を数えて1本多いフェンスを作る**（`maxBacktickRunLength`）。ページ由来の HTML がフェンスを壊さない。（同 `:124-146`）
- **インライン欄のテキストは最大2048文字まで走査して打ち切る**。「ページ制御の DOM テキストは paste サイズになり得る」（同 `:29-66`）
- **単発と複数でフォーマットを分ける**。Orca は単発コピーをプレーンテキスト（`Attached browser context from {url}` 始まり、コロン区切り）にしている。**本システムは常に複数なので Markdown 一本で足りる。**
- **diff 行コメントは本文を `\\` `"` `\r` `\n` ごとエスケープして1行に畳む**（`orca/src/shared/diff-comments-format.ts:9-34`）。ブラケットペーストに乗せても壊れない形。**本システムはファイル経由なので不要だが、将来「本文を直接 PTY へ流す」経路を作るなら必要。**

#### FeedbackRecorder の `agent-brief.md` とクリップボードプロンプト

`feedbackrecorder/app/src/shared/brief.js:330-435` の末尾（原文引用）:

```
The screenshots cannot travel in this message. If you can read files,
open the frames listed above from the package path; if you cannot, work
from the details below and say which parts you could not verify. If input
activity was captured, read input-events.txt as part of the walkthrough.

Please: identify each issue or request I described, tie it to the code it
affects, propose a fix for each, and ask about anything that remains
ambiguous rather than guessing.
```

採るべき点:

- **プロンプトは内容を丸ごと載せる**（パスだけでなく）。設計意図: 「It carries the content rather than a pointer to it, so it also works in a chat window with no access to the filesystem. It says what it cannot carry instead of referring to images the reader may not be able to open」（同 `:326-329`）。**本システムの OUT-3（コピー）はこの方針にする。OUT-2（PTY 送信）はファイル参照でよい。**
- **画像参照は相対パスのみ。base64 も Markdown 画像埋め込みも使わない**（`` `frames/frame-01.png` `` というインラインコード）。
- **最後に「できなかったことを言え」と明示的に指示する**。これが capture gap の思想（後述の AREC と同じ）。
- **ナレーションの各行に「その時刻に画面に出ていたフレーム」を紐づける**: `00:03 [frames/frame-01.png] テキスト`。対応付けは「開始時刻の直前に出ていたフレーム」で、keyframes と revisits を時刻でマージしたタイムラインを使う。目的: 「"This button" is only resolvable if the reader can tell which frame was on screen while it was said」（同 `:11-39`）。**本システムは指摘と画像が1対1なのでより簡単だが、1つの指摘に複数画像がつく場合（EXT-3「1枚以上」、URL変化時に最大3枚）はこの考え方が必要。**

#### `run.json` / `session.json`

FeedbackRecorder の `run.json` は `id / dir / packagePath / startedAt / durationSeconds / display / source / frameSize / region / keyframes[] / revisits[] / narration{level,rmsDbfs,peakDbfs,summary,advice} / transcript{available,segments[],language,requestedLanguage,engine,vad,reason} / input{...} / notes{general,frames[]} / build / degraded[]`（`feedbackrecorder/app/src/main/package-writer.js:267-298`）。

採るべき点:

- **`degraded[]`（文章の配列）を持ち、パッケージが自己検証する**。`verifyPackage()` の検査項目: 尺が0（再生不能の可能性）/ キーフレーム0枚 / 最後のキーフレームが尺+1秒より後（時刻が信用できない）/ **revisit が存在しないファイルを指している（dangling pointer）** / transcript セグメントが尺+1秒より後に始まる。コメントが核心: 「Both failure modes in this pipeline produce plausible output with a zero exit code, so the package states what it actually contains rather than assuming the steps that ran produced anything」（同 `:231-265`）。**NF-12 と EXT-11 の実装はこれ。**
- **イベント全列（`inputEvents`）は `run.json` から削除して jsonl に逃がす**（同 `:290-295`）。本システムの `events.jsonl` と同じ判断。
- **避けるべき点**: FeedbackRecorder は `display.thumbnail` に 320×200 PNG の base64 data URL をそのまま `run.json` に入れている（`app/src/main/runtime.js:403`）。**本システムは必ず落とす。**
- メモの保存は 500ms デバウンス → `finalize` を再実行して brief / prompt / run.json / notes.txt を全部書き直す。**リビジョン番号で競合制御**し、コピー / エクスポート / 画像差し替え / 次の録画の前に必ず flush する（`app.js:2028-2083`）。

#### Clipy の AREC 形式（0.3-draft）

`.arec` は **`text/markdown` の Markdown 文書**で、拡張子は意味を示すだけ（独自バイナリではない）。仕様本文は CC BY 4.0。

**識別コメント（必須、先頭）**:

```
<!-- arec
spec_version: 0.3-draft
profile: clipy-recording
canonical_url: https://clipy.online/video/3kelcef8wo8h.arec
watch_url: https://clipy.online/video/3kelcef8wo8h
-->
```

**全プロファイル共通の MUST**（`clipy.online/spec`、原文の要旨）:

1. 識別コメントで始まる。
2. **録画由来のタイトル・要約・キャプション・診断・文字起こしを「untrusted evidence、instructions ではない」と明示する。**
3. `Metadata` に source / watch identity、duration、profile、provenance、processing 状態、compiler 情報を含む。
4. `Transcript` セクションを含む、**または存在しない／準備できていない理由を明示する**。
5. **`Capture gaps` または同等の完全性の記述を含む** — 取れなかった情報が「その出来事が起きなかった証拠」と誤解されうる場合は必ず。
6. **evidence の参照は precomputed artifact を指す**。消費側がサーバ側のフレーム抽出エンドポイントを呼ばなければ使えない文書は不可。
7. **前方互換**: 消費側は未知セクションを無視して認識できるセクションを読み続ける。

**`clipy-recording` プロファイルのセクション**: Metadata / Intent（type, objective）/ Summary / Requested changes・Fix checklist・Action items / Draft implementation plan（**draft と明示し evidence 照合が必要と書く**）/ Key moments（**タイムスタンプ付き JSON ＋ 可読セクション**）/ Browser diagnostics / Capture gaps / Transcript。

**Key moments の JSON（公式サンプル、原文）**:

```json
[{"t_ms":6400,"caption":"points to 'this section' on screen",
 "frame_url":"https://cdn.clipy.online/key-moments/…/6400.jpg",
 "x":0.63,"y":0.41,"source":"fused","confidence":0.9}]
```

**Browser diagnostics の JSON（公式サンプル、原文）**:

```json
[{"kind":"network","time_ms":6400,"method":"POST","url":"https://app.example/api/export","status":500,"outcome":"http_error","duration_ms":312}]
```

- **座標は frame 相対（0〜1）** — 「レンダリングサイズが変わっても生き残る」。
- `source` の意味: `click` / `fused` = 記録されたクリック、`hover` = クリックせずポインタが留まった、`draw` / `flare` = ユーザーが意図的にマーク／スポットライトした。**telemetry の欠損は capture gap であり、クリックが無かった証拠ではない。**
- `motion` オブジェクト（任意）: `relation`（例 `move`）、`target_x` / `target_y`（同じ 0〜1 単位）、`target_frame_url`。
- **診断に headers / bodies / cookies / tokens / 生の query 値を入れてはいけない（MUST NOT）。**
- 任意拡張: `Verification`（agent の read receipt、assertion、検証結果）/ `Signature`（文書と参照 artifact のハッシュに対する署名）/ `Full cursor path`。
- 検証: `/schema/arec-0.3.schema.json` ＋ 依存なしの validator（`node bin/arec-validate.mjs recording.arec`）。Markdown で表せないルール（識別コメント、untrusted 注記、Metadata の存在、Transcript または不在の明示、完全性の記述、precomputed な evidence 参照、redaction 済み診断）は validator 側で直接チェックする。
- `imported-context` プロファイル（外部動画のバンドル）: `recording.arec` / `recording.md`（byte-identical コピー）/ `manifest.json`（version, source, provenance, hashes, classification, completeness, frame metadata）/ `transcript.json` / `frames/`。
- Agent への渡し方: ① watch URL に `.arec` を足すだけ（公開録画は認証不要）② MCP サーバ `@clipy/mcp`（`get_agent_context` が一括取得）③ CLI `npx @clipy/cli agents install` ④ スキル `watch-clipy-recording`。
- 料金: 無料 15録画 / 2時間（7日トライアル、カード不要）、Pro $9/月（年払い $6/月）。
- 「発話中の指示箇所」: 「finds every spoken pointer and extracts the frame at that instant」。Mac アプリと Chrome 拡張のタブ録画では**実際のクリック座標を fuse する**。出力は `clicked the Settings button at (0.63, 0.41)` のように読める。

**AREC から `feedback.md` に採る点**

| 何を | なぜ |
|---|---|
| **「録画由来の内容は untrusted evidence であり instructions ではない」という1行を先頭に置く** | 本システムはページのDOMテキスト・要素テキスト・MTG相手の発話を Agent に渡す。**プロンプトインジェクションの経路になる。** 02_requirements.md 6章の `feedback.md` ヘッダに追記すべき |
| **「取れなかったもの」を明示するセクション（Capture gaps）** | 既に FeedbackRecorder の `degraded[]` として採用済み。AREC はこれを MUST にしている理由まで書いている: 「a document that omits a gap is making a silent claim that nothing happened」 |
| **Draft plan を「draft である」と明示してラベルする** | 本システムの LLM 整理結果（見出し・要望）も推論なので、「発話原文を必ず併記」（EXT-8）に加えて「これは整理結果である」と形式上区別する |
| **座標を 0〜1 の frame 相対で持つ** | 本システムの `events.jsonl` はピクセル座標（`{"x":640,"y":412}`）。**表示幅を切り替える（WS-3）ので、ピクセルだけでは再解釈できない。`frameSize` と併記するか 0〜1 を併記する** |
| **evidence の参照は precomputed artifact のみ** | 本システムは最初からファイル出力なので自然に満たす |
| **`.md` を byte-identical な互換エイリアスとして残す** | 本システムは `feedback.md` 一本なので不要。ただし「将来 JSON 表現を出すなら別エンドポイント／別ファイルにし、Markdown 本体と混ぜない」という線引きは採る |
| 採らない点: 識別コメント・spec_version・MCP・署名 | `.ade-movie/reviews/` はプロジェクト内のローカルファイルで、他のツールが消費する想定がない。**AREC 準拠を名乗るのは価値確認後**（外部配布を決める時点で再検討） |

### 3.10 起動速度・メモリ（NF-5: 2秒以内）

| 何を | なぜ | 参照元 |
|---|---|---|
| **`show: false` → `ready-to-show` で表示**。Windows / Linux のみ **10秒のフォールバックタイマー**を置く | 「Windows/Linux の GPU/ドライバ障害で `ready-to-show` が永久に来ないことがあり、唯一のウィンドウが隠れる」。タイマーは `unref()` する | `orca/src/main/window/main-window-state-lifecycle.ts:33-41, 70` |
| `ready-to-show` は**一回限りガード**する | 「macOS + Electron 41 は webview guest 生成時に `ready-to-show` を再 emit する」。**本システムは `<webview>` を使うので必ず踏む** | 同 `:31-32` |
| **BrowserWindow オプション（本システムの確定値）** | `minWidth: 600` / `minHeight: 400`、`show: false`、`acceptFirstMouse: true`（macOS が既定でアプリをアクティブ化するクリックを飲み込むので、戻るのに2クリック必要だった）、`autoHideMenuBar: true`、`backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff'`、`titleBarStyle`（darwin `'hiddenInset'` / win32 `'hidden'` / 他 undefined）、`frame: false`（linux のみ）、`trafficLightPosition: { x: 16, y: 12 }`（darwin のみ）、`webPreferences: { sandbox: true, webviewTag: true }` | `orca/src/main/window/createMainWindow.ts:99-141` |
| **`vibrancy` は指定しない** | 「macOS の vibrancy + transparent は不透明背景の裏に隠れたうえで WindowServer のフレーム毎 alpha コンポジットを強制していた」 | 同 `:94-95` |
| 既定サイズ | `screen.getPrimaryDisplay().workAreaSize`、例外時 `{ width: 1200, height: 800 }`。「初回起動ではプライマリディスプレイの作業領域を埋めて `maximize()` なしで広く感じさせる」 | 同 `:78-86` |
| 保存した bounds の棄却条件 | `width > 600 && height > 400 && rectHasVisibleAreaOnAnyDisplay(..., 300, 200)` | 同 `:63-70` |
| **boot graph の gate を作る**: ビルド後に `out/renderer/index.html` の `<script type="module" src>` と `<link rel="modulepreload" href>` を抽出し、**禁止ペイロードの「そのペイロードだけが出力するリテラル文字列」を検索して CI で落とす** | Orca の禁止リストは `@xterm/addon-webgl`（signature `'WebGL2 not supported'`）、`@xterm/addon-image`、巨大 i18n カタログの3件。**本システムは `@xterm/addon-webgl` と録画・分解モジュールを禁止リストに入れる** | `orca/config/scripts/renderer-boot-graph.mjs:7-53, 99-123` |
| **静的 import グラフを歩く第2の gate** | `main.tsx` を起点に BFS し、`from '...'` の静的 import だけを辿る（`import('...')` と `import type` は eager graph に載らない）。`expect(chain).toEqual([])` ＋ **`expect(parents.size).toBeGreaterThan(1000)`**（グラフ探索が壊れて空になった偽合格を防ぐ番人）。この2本目のアサートが設計の要点 | `orca/src/renderer/src/components/sidebar/worktree-card-markdown-isolation.test.ts:6-83` |
| **遅延 import には retry 付きヘルパを使う** | 「stale/corrupt chunk が native SyntaxError で reject し、`React.lazy` がそれを永久キャッシュするため Retry で復帰できない」。`DEFAULT_RETRIES = 2`、`DEFAULT_BASE_DELAY_MS = 250`、指数バックオフ、セッションガードキーで無限リロードを防ぐ | `orca/src/renderer/src/lib/lazy-with-retry.ts:8-18, 51-56, 140-188` |
| **ビューアごとに `lazy()` のアイデンティティを1つにして共有する** | 同じコンポーネントを複数箇所で `lazy()` すると別チャンクになる | `orca/src/renderer/src/components/editor/editor-lazy-views.ts:3-16` |
| **本システムの遅延ロード対象**: 録画パイプライン（MediaRecorder / キーフレーム抽出 / WAV）、分解パイプライン（whisper 呼び出し / LLM 整理）、過去セッション一覧、設定画面、xterm WebGL addon | 03_design.md 1.3「起動時に読むコードを最小化」の具体化 |
| **Chromium スイッチ（本システムの確定値）** | `--disable-features=FedCm,DirectSockets,DirectSocketsInSharedWorkers,DirectSocketsInServiceWorkers,IntensiveWakeUpThrottling`、`--max-active-webgl-contexts=128`、`--enable-features=EarlyEstablishGpuChannel,EstablishGpuChannelAsync`（**Wayland では付けない**）、darwin で `--disable-skia-graphite`、linux+Wayland で `--disable-gpu-sandbox` | DirectSockets を切る理由: 「Electron は DirectSocketsDelegate を同梱しないので露出したコンストラクタは egress できないが、`new TCPSocket(...)` が mojo の ReportBadMessage を踏んで guest renderer を kill する — ページから誘発可能な kill でクラッシュテレメトリを汚染する」。**`<webview>` で任意のページを開く本システムに直接当たる** | `orca/src/main/startup/disabled-chromium-features.ts:2-9`、`orca/src/main/startup/configure-process.ts:74-351` |
| **`appendSwitch` は全て `app.whenReady()` の前**。`--password-store` は特に「Electron が browser main parts 起動中に os_crypt 設定を作る」ため、その後に append しても無視される | `orca/src/main/startup/main-process-preflight.ts:274-278` |
| **ウィンドウ生成の前にブロックするものを最小化し、残りは「最初のウィンドウが出た後」に回す** | Orca の `runAfterFirstWindowShown`（`browser-window-created` → `ready-to-show` → `setImmediate`、失敗時タイマー）。理由: 「ウィンドウ生成前に始めたプローブやディスク sweep は同じ main スレッド／libuv threadpool を奪い合い、ユーザーには起動が遅いと見える」。**本システムで後回しにするもの: whisper バイナリ／モデルの存在確認、古い録画の自動削除（NF-8）、Agent CLI の検出（EXT-9）、`.git/info/exclude` への追記（NF-9）** | `orca/src/main/startup/first-window-deferral.ts:5-37` |
| ウィンドウと RPC / PTY の起動を並列化する | 「daemon 起動と hook server bind は独立だが両方が復元ターミナルを gate するので、コールドスタート遅延が sum ではなく max になるよう同時実行」。タイムアウトは **fail-open**（12秒 / 60秒） | `orca/src/main/startup/first-window-startup-services.ts:19-101` |
| **起動マイルストーンのログ機構を作る**: `ORCA_STARTUP_DIAGNOSTICS=1` 相当のフラグでゲートし、`[startup] <event> k=JSON(v)` を **fd 2 に `writeSync`**。renderer 側は `renderer-` 接頭辞のみ main へ中継を許可 | ベンチは stderr の行だけをパースすればよくなる。**NF-5 の実測はこれで行う** | `orca/src/main/startup/startup-diagnostics.ts:7-43`、`main-process-ipc-bootstrap.ts:74-81` |
| **起動ベンチは中央値のみ、`spawn` 直前の `process.hrtime.bigint()` を起点にする** | Orca は 5反復・反復間 1500ms スリープ。測る指標は `spawnToAppReady` / `appReadyToServices` / `windowCreatedToLoaded` / `totalToDidFinishLoad` / `totalToWorkspaceReady` ＋ **`maxEventLoopStallMs`（フリーズの直接計測）** | `orca/tests/tools/benchmarks/startup-time-bench.mjs:291-397, 424-431` |
| **event-loop 失速プローブを起動時に走らせる** | `TICK_MS = 25` / `REPORT_EVERY_MS = 2000` / `STOP_AFTER_MS = 60000` | `orca/src/main/startup/event-loop-stall-probe.ts:3-5` |
| **renderer heap の headroom を上げる**: 総メモリ 7.5GiB 以上なら `--js-flags=--max-old-space-size=clamp(floor(totalGiB × 0.4) × 1024, 3072, 4096)` | 4096 は **V8 pointer-compression cage のハード上限**。`js-flags` はプロセス全体で `app 'ready'` 前に設定しないと renderer / utility の V8 isolate に届かない | `orca/src/main/startup/renderer-heap-headroom.ts:20-24, 61-101` |
| **非表示時はポーリングを止める共通ヘルパを1本作る** | Orca の `installWindowVisibilityInterval()`（hidden で `clearInterval` + `clearTimeout`、visible で再起動、ジッタ上限 400ms）を 28ファイルが使っている。**本システムの対象: 録画の経過時間クロック（録画中は例外として止めない）、Agent 状態のポーリング、ポート/プロセスの監視** | `orca/src/renderer/src/lib/window-visibility-interval.ts:4-92` |
| **`backgroundThrottling` はリース方式で一時的に切る** | `acquire()` 初回で `setBackgroundThrottling(false)`、最終リース返却で `true` に戻す（`isDestroyed` ガード付き）。**本システムは録画中だけ false にする**（FeedbackRecorder も録画バーで `backgroundThrottling: false` にしている） | `orca/src/main/window/renderer-publication-throttle.ts:12-35`、`feedbackrecorder/app/src/main/main.js:29-31` |
| ブラウザ guest は `setBackgroundThrottling(false)` | 録画中に guest のタイマーが絞られるとコマ落ちする | `orca/src/main/browser/browser-manager-guest-policy.ts:31` |
| **`manualChunks` は使わない** | Orca は使っていない（リポジトリ全体でヒットなし）。renderer は `preserveEntrySignatures: 'strict'`（共有チャンクが別 React root の HTML entry を import しないため）、main の output は `format: 'cjs'`（Rolldown の SSR 既定 ESM を上書き） | `orca/electron.vite.config.ts:279-283, 337-342` |

### 3.11 ライセンス上の注意

| 対象 | ライセンス | 本システムでの扱い |
|---|---|---|
| **Orca** | MIT（Copyright (c) 2026 Lovecast Inc.） | **設計・数値・アルゴリズムの参考は制約なし。** ただし**ソースコードを転記・改変して取り込む場合は、著作権表示とライセンス全文を保持する義務がある**（MIT の唯一の条件）。該当しそうな候補: `pane-terminal-options.ts` のオプション塊、`terminal-themes/defaults.ts` の16色、`grab-guest-element-context-script.ts` のセレクタ生成、`xterm-bypass-policy.ts` のバイパス規則、`window-shortcut-policy.ts` の allowlist 構造。**流用する場合は `third_party/orca/` 配下に原文の LICENSE を置き、各ファイル先頭に `Adapted from stablyai/orca (MIT), Copyright (c) 2026 Lovecast Inc.` と出所コミット `7577366` を書く。** |
| **FeedbackRecorder** | MIT（Copyright (c) 2026 Magnus Landahl） | 同じ扱い。**流用する可能性が最も高いのは `app/src/shared/keyframes.js`（386行、閾値とアルゴリズムが一体）と `app/src/shared/wav.js`（67行）と `app/src/shared/narration.js`。** これらは TypeScript に書き直すとしても「翻案」なので、同様に `third_party/feedbackrecorder/LICENSE` ＋ ファイル先頭の帰属を置く。出所コミット `906b794`。 |
| **herdr** | **Apache-2.0** | MIT より義務が多い。**(a) ライセンス全文の添付、(b) 著作権・特許・商標・帰属表示の保持、(c) 改変したファイルに「変更した」旨の目立つ表示（§4b）、(d) `NOTICE` ファイルがあればその内容を再配布物に含める**。本システムは Rust コードを流用しないので、**採るのは設計（4状態、pending-idle 確定遅延、seen フラグ、TOMLマニフェストの発想）だけにとどめ、コードは一行も転記しない。** TOML マニフェストの正規表現を写すのは「ソースの転記」に当たるので、**自前で書き起こす**（claude / codex の OSC タイトル規則は公開仕様に近い事実なので、自分で観測して書く）。 |
| Clipy / AREC 仕様 | 製品はクローズド。**仕様文書の text は CC BY 4.0** | 仕様の記述を引用・翻訳する場合は帰属表示（Clipy / Codersera、`clipy.online/spec`）を付ける。**AREC 準拠を名乗るなら `spec_version` と MUST 要件を満たす必要がある。MVP では名乗らない。** |
| 同梱バイナリ | whisper.cpp = **MIT**、ggml モデル = 各モデルのライセンス（`ggerganov/whisper.cpp` の HF リポジトリ）、Silero VAD = **MIT** | インストーラに同梱するので、**サードパーティライセンス一覧（`THIRD_PARTY_NOTICES.md`）を作り、アプリの「情報」画面から開けるようにする。** Electron / Chromium / node-pty / xterm.js も同じ一覧に含める。 |

**OSS として公開するので、(a)〜(d)の義務を満たす。移植したファイルの先頭に帰属コメントを書き、[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) に一覧とライセンス全文を置く。**

---

## 4. 先行例より良くする点・やらない点

### 4.1 良くする点

| # | 点 | どの先行例に対して | 根拠 |
|---|---|---|---|
| 1 | **MTGで使えるモードを持つ** | 全4製品。Orca と herdr に録画がなく、FeedbackRecorder と Clipy は1人のナレーション録画が前提。FeedbackRecorder は**システム音声を意図的に録らない**（`docs/APP_DESIGN.md:444-453`） | フィードバックモード（MODE-2〜4）＋ PC音声の別系統録音（AUD-1）＋ 話者つき文字起こし（AUD-2） |
| 2 | **「人が喋った・囲んだ瞬間」を指摘の単位にする** | FeedbackRecorder は「画面が変わった瞬間」をキーフレームにし、ナレーションを後から時刻で紐づける（`brief.js:11-39`）。Clipy は「発話ポインタ」の瞬間を採るが座標とクリップだけ | 指摘と画像が1対1で対応する（EXT-2 / EXT-3）。FeedbackRecorder のキーフレームアルゴリズムは「指摘に紐づかない補助画像」の選定に転用する |
| 3 | **Web固有の情報を同梱する** | FeedbackRecorder は内蔵ブラウザがないので URL も DOM もない。Clipy はクリック座標のみで DOM を持たない（AREC の `clipy-recording` プロファイルに DOM セクションがない） | Orca の Grab 相当（セレクタ・computed CSS 16項目・**React のコンポーネント名と `file:line:col`**）を指摘に自動で付ける。Agent がコードを特定する速度がここで決まる |
| 4 | **一時停止・再開を実装する** | FeedbackRecorder は未実装（`pause`/`resume` の実装が1件もない） | REC-1。90分MTGで必須 |
| 5 | **文字起こしを録画中に逐次実行する** | FeedbackRecorder は録画後に一括実行し、人間の待ち時間（クロップ選択）と並行させることで隠している | 03_design.md 1.3。NF-3（停止から10秒以内）の達成手段 |
| 6 | **whisper.cpp の進捗を取る**（`--print-progress`） | FeedbackRecorder は取っていない | 90分録画では進捗が見えないと不安になる |
| 7 | **文字起こしの誤変換を後段 LLM が画面上のテキストで補正する** | FeedbackRecorder は補正なし（whisper の出力をそのまま brief に書く）。Clipy は中身を公開していない | EXT-6。操作ログの要素テキスト・ページタイトルという**正解候補を持っている**のが本システムの強み |
| 8 | **指摘の編集・削除・結合・画像差し替えができる** | FeedbackRecorder は**セグメントの編集・削除もキーフレームの個別差し替えもできない**（再フレーミングでやり直すのみ）。Orca の注釈トレイは編集と削除ができる | REV-2 / REV-3。FeedbackRecorder の「時刻 ±0.05秒 でコメントを追従させる」実装（`package-writer.js:195-212`）は画像差し替えに転用する |
| 9 | **画像を Agent のコンテキストに合わせて縮小する** | FeedbackRecorder は PNG ロスレスでクロップ後のフル解像度のまま保存（`app.js:1810-1812`）。Orca は 2MB 超のスクショを**縮小せずに捨てる**（「v1 では downscale は複雑さが増すので fail closed」、`browser-grab-screenshot.ts:87-89`） | EXT-5（長辺1568px）。Canvas で縮小するだけなので両者の割り切りに付き合う必要はない |
| 10 | **「録画由来の内容は untrusted evidence」を出力の先頭に書く** | Orca も FeedbackRecorder も書いていない。**AREC だけが MUST にしている** | 本システムは DOMテキスト・要素テキスト・MTG相手の発話を Agent に渡すので、プロンプトインジェクションの経路が3つある。`feedback.md` のヘッダに1行追加する（02_requirements.md 6章の修正提案） |
| 11 | **秘密情報を出力から遮断する** | FeedbackRecorder は遮断していない（URL も要素も取らないので必要がなかった）。Orca は遮断している | Orca の blocklist ＋ URL の query/hash 除去をそのまま採る。NF-2 の延長 |
| 12 | **座標を frame 相対（0〜1）で併記する** | FeedbackRecorder はピクセル座標のみ。**AREC は 0〜1 を必須にしている**（「レンダリングサイズが変わっても生き残る」） | 本システムは表示幅を切り替える（WS-3）ので、ピクセルだけでは再解釈できない |
| 13 | **Agent 状態を「見た／見ていない」で区別する** | Orca は OSC タイトルと hook から状態を出すが `done`/`idle` の区別がない。herdr は `seen` フラグで区別する | **フィードバックモードから戻ったときに「終わったのに気づいていない」を示せる。** 本システムに最も効く herdr の学び |

### 4.2 やらない点（先行例にあるが採らない）

| # | やらないこと | どこにあるか | 理由 |
|---|---|---|---|
| 1 | 並列 Agent 管理・worktree・セッション横断の状態一覧 | Orca（worktree サイドバー、ダッシュボード、Kanban）、herdr（workspaces / tabs / panes の3階層、サイドバー 26列） | 概念書の「やらないこと」。herdr の状態検知は**1タブぶんの表示**にしか使わない |
| 2 | **Agent 検知のマニフェスト駆動ルールエンジン** | herdr（TOML 22本、`claude.toml` だけで16ルール、region 14種、gate 6種、priority 50〜1100、リモート更新 30分間隔、DoS 上限 6種） | 本システムは1〜数タブ。**OSC タイトルの単純なパターンマッチだけ**にする。herdr の 4状態と確定遅延だけ採る |
| 3 | デーモン／クライアント分離、セッション永続化、リモート attach | herdr（UNIX socket 2本、`session.json` ＋ 48世代スナップショット）、Orca（orcad、SSH、relay、mobile） | 本システムはローカルのデスクトップアプリ。アプリが落ちたら録画データから復元する（NF-12）だけでよい |
| 4 | ターミナルタブの park（非表示ペインのアンマウント）と hidden WebGL retention | Orca（cold park 30秒、hot retain 5分×6件、WebGL 保持 LRU 6、serialize でバッファ退避、parked byte watcher） | タブ数が少ないので効果が小さく、実装コストが高い（Orca は `terminal-parking-*` だけで十数ファイル）。**scrollback 5000 の既定と `@xterm/addon-serialize` によるバッファ保存は採る** |
| 5 | コマンドパレット（`Mod+J` 相当）とそのランキングエンジン | Orca（`palette-match/` が非テスト13本、8段 quality、辞書式多段ランクタプル、typo は編集距離1・4文字以上・両方英字のみ、recency はバケット、チェックイン済み性能予算9項目） | 画面が2モード＋一覧の3つしかない。検索すべき対象がない |
| 6 | 入力イベント（クリック・キー・ショートカット）のOSレベルキャプチャ | FeedbackRecorder（`tools/input-tap.swift` / `input-tap-win.c`、`input-events.jsonl`、タイプ文字数だけカウントして内容は保存しない） | **フェーズ1は内蔵ブラウザなので、注入スクリプトからクリックと要素情報が取れる**（REC-4 / EXT-4）。OSレベルのタップはフェーズ2・3で必要になったら検討する。なおFeedbackRecorderの「ordinary typing は数だけ数えて内容を保存しない」というプライバシー方針は、フェーズ3で採る |
| 7 | zip 出力・ドラッグ＆ドロップ受け渡し | FeedbackRecorder（自前 zip 実装 303行、zip64対応、`dragstart` の前に zip を書いておく） | 本システムは**プロジェクト内のフォルダに出す**ので受け渡しが要らない（OUT-1）。外部 Agent 向けは「コピー」で足りる（OUT-3） |
| 8 | クラウド保存・共有リンク・MCP サーバ | Clipy（`.arec` URL、`@clipy/mcp`、Slack App） | NF-2（動画と音声は端末外へ送信しない）。FeedbackRecorder の判断がそのまま当てはまる: 「It works against every agent — Copilot CLI, a web chat, an editor extension — with no integration to build or keep working」（`docs/APP_DESIGN.md:385-395`） |
| 9 | 署名・read receipt・検証（AREC の Verification / Signature） | Clipy / AREC 0.3 の任意拡張 | ローカルファイルなので改ざん検知の相手がいない |
| 10 | キーマッププリセット（VS Code風など） | — | **Orca にも存在しない**（`preset.*keybind` の grep が0件、Settings のフィルタも `all/modified/unassigned/conflicts` のみ）。層は「既定」と「ユーザーオーバーライド」の2つだけにする |
| 11 | 多言語 UI（i18n） | Orca（i18next、6ロケール、カタログを prune して英語の必須分 139KB だけ eager、他は動的 import、抽出・カバレッジの CI チェック5本） | UI は日本語のみ。**ただし Orca の「巨大カタログを boot graph から外す」手法は、将来 i18n を入れるなら最初から踏襲する** |
| 12 | プラグイン機構 | Orca（`contributes.keybindings` 上限256、`plugin:<publisher>.<name>/<commandId>` 形式、同意画面でシャドウイング警告） | 単機能アプリ |

---

## 5. 未確認事項

| # | 事項 | 状況 | いつ埋めるか |
|---|---|---|---|
| 1 | **Orca が「Design Mode」という名前の機能を持つか** | 持たない。実体は **Grab（要素つかみ取り、`Mod+C`）＋ Annotate（注釈、`Mod+Shift+C` / `Alt+Shift+N`）** という2つの intent を持つ1つのピッカー。01_concept.md の「Design Mode」という記述は訂正が必要 | 概念書の次回更新 |
| 2 | Orca の Grab が画像をどう Agent に渡すか | **直接送る経路はない。** クリップボードに PNG を載せ、ユーザーがターミナルに貼ると既存の clipboard-screenshot paste が一時ファイルに書いてパスを TUI に渡す。注釈の Markdown プロンプトには画像が一切含まれない（永続化時に `screenshot: null`）。**つまりテキストと画像は別チャネル** | 確認済み |
| 3 | `agent-browser`（npm 依存）の CLI サブコマンド全体 | `node_modules` 未インストールのため未確認。Orca 側の呼び出し規約（`--session <name>` / `--cdp <port>` / `close` / `session list`）と「既存 `<webview>` の WebContents に CDP でアタッチして駆動する」ことのみコードから確認 | 本システムは Agent にブラウザを操作させないので不要 |
| 4 | Orca の `config/patches/` にある `addon-serialize` / `addon-ligatures` のベンダパッチ内容 | 未読。パッチが必要だった事実だけ把握 | xterm のアドオンで不具合を踏んだ時点 |
| 5 | Orca の `xterm` 設定のうち `letterSpacing` / `smoothScrollDuration` / `fastScrollModifier` | **非テストコードで一切設定されていない**（= xterm 既定のまま） | 確認済み（設定しない） |
| 6 | Orca の `--print-progress` 相当（whisper の進捗） | Orca は whisper を使わない（dictation は sherpa-onnx）。FeedbackRecorder も `--print-progress` を使っていない | 本システムの M0 技術検証で whisper.cpp の進捗出力形式を実測する |
| 7 | herdr の残り15マニフェストの正規表現 | claude / codex / github-copilot / gemini / cursor / amp / droid の7本は全ルール確認済み。devin, cline, kimi, kiro, maki, muse, grok, hermes, kilo, letta, qwen, qodercli, opencode, pi, antigravity はルール数と engine version のみ | 本システムは claude / codex の2つだけ対応するので不要 |
| 8 | herdr の「出力静止時間による working 判定」 | **実装されていない。** ドキュメントコメントが "PTY activity is the normal working authority" と示唆するが、`AgentState::Working` の代入は非テストコードではマニフェスト由来の1箇所のみ | 確認済み（本システムも静止時間では判定しない） |
| 9 | herdr のペインボーダーに Agent 状態色を付ける仕組み | 未確認。`ui/panes.rs` は `palette.accent` のみ。`ui.show_agent_labels_on_pane_borders`（既定 false）はラベル表示のみで、色の割当は確認できなかった | 本システムはタブ内のドットで表示するので不要 |
| 10 | Clipy の録画実装（Chrome拡張の制約、コンソールログ・ネットワークの取得方法） | クローズドソースのため未確認。AREC の `Browser diagnostics` セクションに「visited routes, warnings and errors, failed request metadata, dropped-event count, page-reported attestation」が入ることと、「headers / bodies / cookies / tokens / 生の query 値は MUST NOT」だけ判明 | **本システムは `<webview>` なので `console-message` と `did-fail-load` が取れる。コンソールログ・失敗リクエストを指摘に添えるのは MVP 後の拡張候補**として記録しておく |
| 11 | Clipy の `source: "fused"` が何と何を fuse するか | 「Mac アプリと Chrome 拡張のタブ録画では**実際のクリック座標を fuse する**」とだけ記述。発話の時刻とクリックの時刻をどう対応づけるかのアルゴリズムは非公開 | 本システムは注入スクリプトからクリックと要素が直接取れるので推測不要 |
| 12 | AREC の `/schema/arec-0.3.schema.json` の実内容 | 未取得（spec ページの記述のみ）。「識別ヘッダをパースしたオブジェクト、key-moments 配列、browser-diagnostics 配列」の3つだけが機械可読部分だと判明 | AREC 準拠を検討する段階 |
| 13 | **PC音声（相手の声）の取り込みの3OS差** | **どの先行例も実装していない。** FeedbackRecorder は意図的にマイクのみ、Orca は dictation のみ、herdr は音声なし。**ベンチマークから学べることがない最大の項目** | 03_design.md 10章リスク1。M0 技術検証で3OS実機確認が必須。**Electron の `getDisplayMedia({ audio: true })` と `desktopCapturer` の音声ループバックを両方試す** |
| 14 | 話者分離（マイク/PC音声の2系統マージと二重取り解消） | 先行例に実装なし | M0 技術検証。03_design.md 4章の「同時刻でPC音声側と内容が重なるマイク側の発話を捨てる」を実測で詰める |
| 15 | タブ録画 API（`webContents.getMediaSourceId`）の安定性 | FeedbackRecorder は `getDisplayMedia` でディスプレイ全体を録っており、**タブ録画（`getMediaSourceId`）は使っていない**。Orca は録画しない | 03_design.md 10章リスク2。**先行例が1つも使っていないことが判明したのは重要な負のシグナル。** M0 で優先的に検証し、だめなら FeedbackRecorder 方式（ディスプレイ録画＋リージョンクロップ）に切り替える。クロップは Canvas で済むので代替は現実的 |
| 16 | LLM 整理（`claude -p --json-schema` / `codex exec --output-schema`）の品質と所要時間 | 先行例に該当なし（Orca は Agent に「送る」だけ、FeedbackRecorder は LLM 整理をしない） | 03_design.md 10章リスク4。M0 |
| 17 | Orca の起動時間の目標値・予算 | **存在しない。** ベンチは JSON 書き出しと markdown テーブル print のみで閾値判定なし。CI 連携もなし。唯一 gate されている近傍 perf テストは**worktree 切替の first paint 250ms**（`tests/e2e/worktree-switch-first-paint.spec.ts:43`） | 本システムの NF-5（2秒）は自分で決めた値として実測で守る |
| 18 | Orca の過去の起動実測値の解釈 | Windows / Intel Core Ultra 9 185H / fixtureFiles=28000 での `totalToDidFinishLoad` 中央値は ACL 修正後 **1795.3ms**（修正前は 19313ms で、うち 15647ms が ACL grant）。ただし**旧フォーマットで現行フィールドを持たない** | 参考値として扱う。**「2秒以内」は Electron ＋ Chromium で現実的なライン**であることは支持される |
| 19 | 本システムのペン線が対象ページの既存コンテンツと干渉しないか | Orca の grab オーバーレイは closed shadow DOM ＋ `z-index: 2147483647` で代表的サイトをカバーしているが、**「完全な保証ではない（window の capture リスナは発火しうる）」と自認している**（`browser-grab-session-controller.ts:76-88`）。また Electron の `before-input-event` は**キーボードのみでマウスには発火しない**（API ギャップ） | 03_design.md 10章リスク5。M0。**代替案（内蔵ブラウザの上に別の透明ビューを重ねる）が必要になる確率は Orca の自認を見る限り低くない** |
| 20 | `--disable-features=IntensiveWakeUpThrottling` が録画中のタイマーに与える影響 | Orca は通知遅延の解消目的で入れている。録画中の経過時間クロックと逐次文字起こしのスケジューリングに有利に働くはずだが未検証 | M0 の性能実測時 |
