/**
 * セッション（`.ferret/reviews/<日時>/`。古いものは `.ade-movie/`）の読み書きと履歴（要件 5.7 / 設計 8章）。
 * 起動を軽くするため、main からは必要になった時点で動的 import する。
 *
 * ──────────────────────────── 使い方 ────────────────────────────
 *
 * 【プロジェクトを開いたとき（1回）】
 *   await ensureGitExclude(projectDir)          // .git/info/exclude へ追記（.gitignore は触らない）
 *   await pruneRecordings(projectDir)           // 7日を過ぎた動画を削除（NF-8）
 *   const broken = await findIncompleteSessions(projectDir)   // 異常終了の残り（NF-12）
 *
 * 【録画開始】
 *   const paths = await createSession(projectDir)   // work/audio と work/frames まで作る
 *   // 録画中は逐次書く
 *   await appendEvents(paths, events)               // 操作ログ（追記のみ）
 *   // 音声チャンクは paths.audioDir、静止画は paths.framesDir へ
 *
 * 【分解のあと】
 *   await saveSession(paths, { version: 1, meta, transcript, removedDuplicates,
 *                              frames, draft, llm, document, edits: [] })
 *   await writeFeedbackMarkdown(paths, renderFeedbackMarkdown(document))
 *   await clearWork(paths)                          // 中間ファイルを片付ける
 *
 * 【確認画面の編集 → feedback.md の再生成】
 *   const record = await loadSession(paths)
 *   const events = await readEvents(paths)          // 文脈の引き直しに使う
 *   const edits = [...record.edits, { kind: 'text', id: 'i3', title: '…' }]
 *   const { document, skipped } = applyEdits({ document: baseDocument, edits,
 *                                             events, frames: record.frames })
 *   await saveSession(paths, { ...record, document, edits })
 *   await writeFeedbackMarkdown(paths, renderFeedbackMarkdown(document))
 *   // 画像を差し替えたら URL・要素・直前の操作も引き直される（設計5章④）
 *
 * 【履歴】
 *   const list = await listSessions(projectDir)     // 新しい順。再送信に使う（OUT-5）
 *
 * 注意: `applyEdits` には**編集前の正本**（分解直後の document）を渡す。
 * 編集は操作の列として session.json に残し、feedback.md は毎回そこから作り直す。
 */

export * from './paths'
export * from './store'
export * from './edits'
export * from './history'
export * from './labels'
export * from './summary'
export * from './progress'
export * from './retention'
export * from './gitexclude'
export * from './recover'
