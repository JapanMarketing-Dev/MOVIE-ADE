/**
 * 分解パイプラインの入口（要件 5.5 / 設計 5章）。
 * 起動を軽くするため、main からは必要になった時点で動的 import する。
 *
 * ──────────────────────────── 使い方 ────────────────────────────
 *
 * 【起動時（1回）】使えるものを調べる
 *   const probes = nodeProbes()
 *   const whisper = await resolveWhisperRuntime({ modelDir, resourcesDir }, probes)
 *   const llm = await detectLlmRuntime(probes)            // 既定は Codex、無ければ Claude Code
 *   if ('error' in whisper) …                              // 実行ファイルが無い
 *   if (whisper.needsDownload) await downloadWhisperModel(whisper.modelId, whisper.modelPath, { onProgress })
 *
 * 【録画中】音声を流し込むだけ。無音で区切られ、区切りごとに文字起こしが走る
 *   const engine = new WhisperCppEngine({ binary, model, language: 'ja', ... })
 *   const stt = new IncrementalTranscriber(engine)
 *   const segmenter = new SilenceSegmenter(
 *     wavChunkWriter(audioDir, 16000, (f) => stt.push({ ...f, speaker: 'self', source: 'mic' })),
 *     { maxChunkMs: recommendedMaxChunkMs(whisper.gpuAvailable ? 'local-gpu' : 'local-cpu') }
 *   )
 *   segmenter.push(pcm)                                    // 16kHz モノラルの Int16
 *   // 相手の声も録る場合は、系統ごとに segmenter と IncrementalTranscriber を1組ずつ持つ
 *
 * 【停止時】下書きをすぐ出し、整理は後から差し替える
 *   segmenter.flush()
 *   const mic = await stt.flush()                          // 実測 約1秒
 *   const transcript = twoSpeakers
 *     ? mergeTranscripts(mic.segments, sys.segments)        // 二重取りを除去（AUD-3）
 *     : { segments: singleChannelTranscript(mic.segments), removed: [] }
 *   const material = { meta, transcript: transcript.segments, events, frames }
 *   const stage = buildDraftDocument(material)             // 実測 1ms 未満
 *   show(stage.document)                                   // ここまでで10秒以内（NF-3）
 *
 *   const refined = await refineWithLlm(material, stage, { runner, cwd: sessionDir, timeoutMs })
 *   show(refined.document)                                 // 失敗なら下書きのまま（EXT-11）
 *
 * 【出力】
 *   await writeFeedbackMarkdown(paths, renderFeedbackMarkdown(refined.document))
 *   for (const img of imagePlan(refined.document, material.frames)) saveResized(img)
 *   sendToTerminal(renderSendCommand(paths.relativeDir))
 */

// 型とスキーマ
export * from './types'
export * from './schema'

// ① 素材化（文字起こし）
export * from './stt/engine'
export * from './stt/whisper'
export * from './stt/openai'
export * from './stt/models'
export * from './stt/wav'
export * from './stt/segmenter'
export * from './stt/download'

// 話者のマージと二重取りの除去
export * from './merge'

// ② 下書き
export * from './draft'

// ③ 整理（LLM）
export * from './organize/index'

// ④ 出力
export * from './context'
export * from './assemble'
export * from './feedback'

// 下書き → 整理 → 出力 をまとめた入口
export * from './decompose'

// 実行環境の解決
export * from './environment'

// 文字列の整形（確認画面の表示で使う）
export { formatTimecode, formatDurationJa } from './text'
