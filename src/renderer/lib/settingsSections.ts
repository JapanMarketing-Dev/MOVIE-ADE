/**
 * 設定ページの節と、上部の検索欄での絞り込み。画面に依存しない純粋な関数だけを置く（単体テストの対象）。
 *
 * 並びは左の一覧の順。VS Code / Orca の設定ページと同じく、節の名前だけでなく
 * 中の項目の言葉（マイク・キー・テーマ…）でも引けるよう、節ごとに検索語を持つ。
 * 検索語は英語と日本語の両方を入れる（画面の言語を変えても同じ言葉で探せる）。
 */

export const SETTINGS_SECTIONS = [
  // セットアップのチェックリスト（済んだ項目が緑になる）。いつでも見られるよう一番上に置く
  'setup',
  'general',
  // よく使う・大事なもの（Agent と判定モデル）を一般のすぐ下に置く
  'agents',
  'verify',
  'recording',
  'transcription',
  'organize',
  'accounts',
  'appearance',
  'language',
  'layout',
  'github',
  'about'
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]

export const SECTION_KEYWORDS: Record<SettingsSectionId, readonly string[]> = {
  setup: ['setup', 'checklist', 'onboarding', 'getting started', 'progress', 'セットアップ', 'チェックリスト', '初期設定', '進み具合'],
  general: ['storage', 'keep', 'retention', 'days', 'delete', 'feedback screen', 'stop', 'crash', 'report', 'privacy', 'sentry',
    '保管', '保存期間', '削除', '日', '停止', 'フィードバック画面', 'クラッシュ', 'プライバシー'],
  appearance: ['theme', 'color', 'dark', 'light', 'system', 'テーマ', '配色', 'ダーク', 'ライト', '外観'],
  language: ['language', 'locale', 'english', 'japanese', 'interface', '言語', '英語', '日本語', '表示言語'],
  layout: ['layout', 'panel', 'dock', 'footer', 'terminal', 'sidebar', 'files', 'position', 'drag', '配置', 'パネル', 'フッター', 'ターミナル', 'サイドバー', 'レイアウト', 'ドラッグ', '移動'],
  recording: ['microphone', 'mic', 'audio', 'voice', 'system audio', 'device', 'マイク', '音声', '声', '録音', '録画', 'デバイス'],
  transcription: ['transcription', 'speech', 'whisper', 'model', 'openai', 'api key', 'key', 'base url', 'cost', 'limit', 'compatible', 'local',
    '文字起こし', 'モデル', 'キー', '費用', '上限', '接続', '端末内', '言語'],
  organize: ['organize', 'findings', 'llm', 'anthropic', 'claude api', 'gemini', 'openrouter', 'api key', 'model', 'split',
    '整理', '指摘', 'キー', 'モデル', '分割'],
  verify: ['decision', 'verify', 'judge', 'done', 'ollama', 'clef', 'typesafe', 'jev', 'vercel', 'gateway', 'system one', 'api key',
    '判定', '検証', '完了', 'キー'],
  agents: ['agent', 'claude', 'codex', 'gemini', 'opencode', 'cursor', 'copilot', 'aider', 'grok', 'qwen', 'amp', 'custom', 'install',
    'command', 'args', 'arguments', 'prompt', 'instruction', 'startup', 'エージェント', 'カスタム', 'インストール', 'コマンド', '引数', '指示', 'プロンプト', '起動'],
  accounts: ['account', 'login', 'sign in', 'usage', 'manage', 'アカウント', 'ログイン', '使用量', '管理'],
  github: ['github', 'gh', 'pull request', 'pr', 'issue', 'repository', 'リポジトリ', 'プルリクエスト', 'イシュー'],
  about: ['about', 'version', 'update', 'ferret', 'movie-ade', 'バージョン', '更新', 'について']
}

/** 全角・大文字小文字の揺れをならす */
export function normalizeSearch(text: string): string {
  return text.normalize('NFKC').toLowerCase().trim()
}

/**
 * 検索語に合う節を、一覧の順のまま返す。空なら全部。
 * 空白で区切った語は「すべてを含む」（AND）。節の表示名（今の言語）と検索語の両方を見る。
 */
export function filterSettingsSections(query: string, titleOf: (id: SettingsSectionId) => string): SettingsSectionId[] {
  const words = normalizeSearch(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...SETTINGS_SECTIONS]
  return SETTINGS_SECTIONS.filter((id) => {
    const haystack = normalizeSearch([id, titleOf(id), ...SECTION_KEYWORDS[id]].join(' '))
    return words.every((word) => haystack.includes(word))
  })
}

/**
 * スクロール位置から、いま読んでいる節を決める（左の一覧の選択表示に使う）。
 * tops は各節の上端（スクロール領域の上端からの距離）。上端を少しでも過ぎた最後の節を選ぶ。
 */
export function activeSectionAt(tops: ReadonlyArray<{ id: SettingsSectionId; top: number }>, offset = 24): SettingsSectionId | null {
  let current: SettingsSectionId | null = tops[0]?.id ?? null
  for (const { id, top } of tops) if (top <= offset) current = id
  return current
}
