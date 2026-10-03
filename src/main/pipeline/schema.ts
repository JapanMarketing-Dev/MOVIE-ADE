/**
 * LLM 出力の JSON Schema。
 *
 * 設計上の要点: **引用の本文を LLM に書かせない。** 文字起こしの区間の時刻（t）だけを返させ、
 * 本文と話者は ADE が文字起こしから引く。これで
 *   - 出力トークンが大幅に減る（実測で所要時間が約3分の1。FINDINGS.md 参照）
 *   - 「発話の原文をそのまま併記する」（EXT-8）が構造的に保証され、引用の捏造が起こり得ない
 * という2つが同時に成立する。
 *
 * Codex の `--output-schema` は OpenAI の structured outputs の strict モードに渡されるため、
 * 次の制約を満たす必要がある（実測で確認）:
 *   - すべてのオブジェクトに additionalProperties: false
 *   - properties のキーを全部 required に入れる（省略可にできない）
 *   - minItems / maxItems / minLength / pattern などの検証キーワードは使えない
 * Claude Code の `--json-schema` はこれより緩いが、同じスキーマを共用して
 * 2つの CLI で出力形式を揃える。
 */
export const organizeOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'dropped'],
  properties: {
    items: {
      type: 'array',
      description: '整理後の指摘。時系列の順に並べる。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'request', 'status', 'quote_ts', 'frame_times', 'annotation_ids'],
        properties: {
          title: {
            type: 'string',
            description: '指摘の見出し。20文字程度の日本語。',
          },
          request: {
            type: 'string',
            description: '何をどうして欲しいか。発話に無い要望を足さない。',
          },
          status: {
            type: 'string',
            enum: ['decided', 'needs_check'],
            description: '結論が出ていれば decided、出ていなければ needs_check。',
          },
          quote_ts: {
            type: 'array',
            description:
              '根拠となる発話の t（transcript の t をそのままの数値で）。本文は書かない。1件以上。',
            items: { type: 'integer' },
          },
          frame_times: {
            type: 'array',
            description: '画像にする静止画の時刻。入力の frame_times にある値だけを使う。1〜3個。',
            items: { type: 'integer' },
          },
          annotation_ids: {
            type: 'array',
            description: '関係するペン・テキストのID（p1, x1 など）。無ければ空配列。',
            items: { type: 'string' },
          },
        },
      },
    },
    dropped: {
      type: 'array',
      description: '指摘でないとして除外した発話。確認画面で復元できるよう理由を付ける。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['t', 'reason'],
        properties: {
          t: { type: 'integer', description: 'transcript の t をそのまま。本文は書かない。' },
          reason: { type: 'string', description: '除外した理由（つなぎ言葉・独り言・雑談 など）。' },
        },
      },
    },
  },
} as const

export type OrganizeOutputSchema = typeof organizeOutputSchema;

/** LLM が実際に返す形（本文を含まない） */
export interface RawOrganizeItem {
  title: string
  request: string
  status: 'decided' | 'needs_check'
  quote_ts: number[]
  frame_times: number[]
  annotation_ids: string[]
}

export interface RawOrganizeOutput {
  items: RawOrganizeItem[]
  dropped: Array<{ t: number; reason: string }>
}
