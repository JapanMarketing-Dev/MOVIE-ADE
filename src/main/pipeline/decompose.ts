/**
 * 分解パイプラインの入口。
 * 素材（文字起こし・操作ログ・静止画の時刻一覧）→ 下書き → LLM整理 → feedback.md
 *
 * UI は2段階で使う:
 *   1. buildDraftDocument() を停止直後に呼び、下書き一覧をすぐ出す（NF-3: 10秒以内）
 *   2. refineWithLlm() の結果が届いたら差し替える（NF-3: 5分の録画で60秒以内）
 * LLM が失敗したら 1 のまま使う（EXT-11）。
 */
import { buildDraft, defaultDraftOptions } from './draft'
import type { DraftOptions } from './draft'
import { assembleFromDraft, assembleFromOrganized } from './assemble'
import type { AssembleOptions } from './assemble'
import { organize, organizeChunked } from './organize/index'
import type { ChunkedOptions, OrganizeOptions, OrganizeResult } from './organize/index'
import type { Draft, FeedbackDocument, Material, OrganizeInput } from './types'

export interface DecomposeOptions {
  draft?: Partial<DraftOptions>
  assemble?: Partial<AssembleOptions>
}

export interface DraftStage {
  draft: Draft
  document: FeedbackDocument
  organizeInput: OrganizeInput
}

/** ①→②→④。LLM を使わずに下書きの一覧と feedback.md を作れる状態にする */
export function buildDraftDocument(material: Material, options: DecomposeOptions = {}): DraftStage {
  const draft = buildDraft(material, options.draft)
  const document = assembleFromDraft(material, draft.items, options.assemble)
  const organizeInput: OrganizeInput = {
    meta: material.meta,
    transcript: material.transcript,
    events: material.events,
    frameTimes: material.frames.map((f) => f.t),
    draft: draft.items,
  }
  return { draft, document, organizeInput }
}

export interface RefineResult {
  /** 整理に成功すれば LLM 版、失敗すれば下書き版 */
  document: FeedbackDocument
  organize: OrganizeResult;
  /** 下書きへフォールバックしたか */
  fellBack: boolean
}

/** ③→④。失敗時は下書きの document をそのまま返す */
export async function refineWithLlm(
  material: Material,
  stage: DraftStage,
  llm: OrganizeOptions,
  options: DecomposeOptions = {},
): Promise<RefineResult> {
  const result = await organize(stage.organizeInput, llm)
  return applyOrganizeResult(material, stage, result, options)
}

/**
 * ③→④を時間帯で分割して並列実行する。長い録画でも所要時間が線形に伸びない（NF-3）。
 * 一部の区間だけ失敗した場合は、成功した区間の指摘を使う。
 */
export async function refineWithLlmChunked(
  material: Material,
  stage: DraftStage,
  llm: ChunkedOptions,
  options: DecomposeOptions = {},
): Promise<RefineResult & { chunks: number; failedChunks: number }> {
  const r = await organizeChunked(stage.organizeInput, llm)
  const chunks = r.parts.length
  if (!r.ok || !r.output) {
    return {
      document: stage.document,
      organize: { ok: false, reason: r.reason ?? '整理に失敗', issues: [], elapsedMs: r.elapsedMs },
      fellBack: true,
      chunks,
      failedChunks: r.failed,
    }
  }
  const issues = r.parts.flatMap((p) => p.issues)
  const commandLine = r.parts.find((p) => p.commandLine)?.commandLine ?? ''
  return {
    document: assembleFromOrganized(material, r.output, options.assemble),
    organize: { ok: true, output: r.output, issues, elapsedMs: r.elapsedMs, commandLine, raw: '' },
    fellBack: false,
    chunks,
    failedChunks: r.failed,
  }
}

function applyOrganizeResult(
  material: Material,
  stage: DraftStage,
  result: OrganizeResult,
  options: DecomposeOptions,
): RefineResult {
  if (!result.ok) {
    return { document: stage.document, organize: result, fellBack: true }
  }
  return {
    document: assembleFromOrganized(material, result.output, options.assemble),
    organize: result,
    fellBack: false,
  }
}

/** 停止後の一連の処理をまとめた形（バッチ処理・検証用） */
export async function decompose(
  material: Material,
  llm: OrganizeOptions | undefined,
  options: DecomposeOptions = {},
): Promise<RefineResult & { stage: DraftStage }> {
  const stage = buildDraftDocument(material, options)
  if (!llm) {
    return {
      stage,
      document: stage.document,
      organize: { ok: false, reason: 'LLM 未設定', issues: [], elapsedMs: 0 },
      fellBack: true,
    }
  }
  const refined = await refineWithLlm(material, stage, llm, options)
  return { ...refined, stage }
}

export { defaultDraftOptions }
