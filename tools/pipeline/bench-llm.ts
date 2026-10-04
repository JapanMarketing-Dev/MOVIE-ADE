/**
 * LLM整理の実測。
 *   npx tsx tools/pipeline/bench-llm.ts <materialDir> --runner claude|codex [--model haiku] [--out <dir>]
 *
 * 子プロセスの作業フォルダはセッションフォルダ（出力先）に限定する。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { buildDraftDocument, refineWithLlm, refineWithLlmChunked } from '../../src/main/pipeline/decompose';
import { renderFeedbackMarkdown } from '../../src/main/pipeline/feedback';
import { ClaudeCodeRunner } from '../../src/main/pipeline/organize/runners/claudeCode';
import { CodexRunner } from '../../src/main/pipeline/organize/runners/codex';
import { buildPrompt } from '../../src/main/pipeline/organize/prompt';
import type { LlmRunner, Material } from '../../src/main/pipeline/index';
import { evaluateOrganize, summarize } from './eval-organize';
import type { Truth } from './eval-organize';

const CLAUDE_BIN = process.env.ADE_CLAUDE_BIN ?? 'claude';

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error('使い方: tsx tools/bench-llm.ts <materialDir> --runner claude|codex [--model ...]');
  const runnerId = arg('--runner', 'claude')!;
  const model = arg('--model');
  const sttModel = arg('--stt', 'large-v3-turbo')!;
  const timeoutMs = Number(arg('--timeout', '180000'));
  const chunked = process.argv.includes('--chunked');
  const itemsPerChunk = Number(arg('--items-per-chunk', '10'));
  const effort = arg('--effort', 'low')!;
  const tag = `${runnerId}${model ? `-${model}` : ''}${chunked ? `-chunked${itemsPerChunk}` : ''}`;
  const outDir = resolve(arg('--out', join(dir, 'out', tag))!);
  await mkdir(outDir, { recursive: true });

  const material: Material = JSON.parse(await readFile(join(dir, `material.${sttModel}.json`), 'utf8'));
  const truth: Truth = JSON.parse(await readFile(join(dir, 'truth.json'), 'utf8'));

  const runner: LlmRunner =
    runnerId === 'codex'
      ? new CodexRunner({ ...(model ? { model } : {}) })
      : new ClaudeCodeRunner({ binary: CLAUDE_BIN, effort: effort as 'low', ...(model ? { model } : {}) });

  const stage = buildDraftDocument(material);
  await writeFile(join(outDir, 'prompt.txt'), buildPrompt(stage.organizeInput), 'utf8');
  await writeFile(join(outDir, 'feedback.draft.md'), renderFeedbackMarkdown(stage.document), 'utf8');

  console.log(`${basename(dir)} / ${tag}`);
  console.log(`  下書き ${stage.draft.items.length}件 / プロンプト ${(buildPrompt(stage.organizeInput).length / 1000).toFixed(1)}k文字`);

  const started = Date.now();
  const llmOpts = { runner, cwd: outDir, timeoutMs, ...(model ? { model } : {}) };
  let chunkInfo: { chunks: number; failedChunks: number } | undefined;
  let r;
  if (chunked) {
    const c = await refineWithLlmChunked(material, stage, { ...llmOpts, itemsPerChunk, concurrency: 4 });
    chunkInfo = { chunks: c.chunks, failedChunks: c.failedChunks };
    r = c;
  } else {
    r = await refineWithLlm(material, stage, llmOpts);
  }
  const wall = Date.now() - started;
  if (chunkInfo) console.log(`  区間 ${chunkInfo.chunks}並列（失敗 ${chunkInfo.failedChunks}）`);

  if (r.organize.raw) await writeFile(join(outDir, 'llm-raw.json'), r.organize.raw, 'utf8');
  await writeFile(join(outDir, 'feedback.md'), renderFeedbackMarkdown(r.document), 'utf8');
  await writeFile(
    join(outDir, 'feedback.with-needs-check.md'),
    renderFeedbackMarkdown(r.document, { includeNeedsCheck: true }),
    'utf8',
  );
  await writeFile(join(outDir, 'document.json'), JSON.stringify(r.document, null, 2), 'utf8');

  if (!r.organize.ok) {
    console.log(`  ✗ 失敗（下書きへフォールバック）: ${r.organize.reason}`);
    console.log(`  実行 ${(wall / 1000).toFixed(1)}s`);
    if (r.organize.stderrTail) console.log(`  stderr: ${r.organize.stderrTail.slice(-1200)}`);
    await writeFile(join(outDir, 'result.json'), JSON.stringify({ tag, ok: false, wallMs: wall, organize: r.organize }, null, 2), 'utf8');
    process.exitCode = 1;
    return;
  }

  const ev = evaluateOrganize(material, truth, r.organize.output, r.document);
  console.log(`  ✓ ${(r.organize.elapsedMs / 1000).toFixed(1)}s（実測 ${(wall / 1000).toFixed(1)}s）`);
  if (r.organize.ok && r.organize.usage) {
    const u = r.organize.usage as Record<string, number>;
    console.log(`  トークン 入力${u.input_tokens ?? '-'}+キャッシュ${u.cache_creation_input_tokens ?? 0}/${u.cache_read_input_tokens ?? 0} 出力${u.output_tokens ?? '-'}（思考 ${JSON.stringify(u.output_tokens_details ?? {})}） API ${u.duration_api_ms ?? '-'}ms ターン ${u.num_turns ?? '-'}`);
  }
  console.log(`  ${summarize(ev)}`);
  const warn = r.organize.issues.filter((i) => i.level === 'warning');
  if (warn.length > 0) {
    console.log(`  検証の警告 ${warn.length}件: ${[...new Set(warn.map((w) => w.code))].join(', ')}`);
  }
  for (const s of ev.spurious) console.log(`  [捏造の疑い] ${s.title} / ${s.request}`);
  for (const s of ev.statusWrong) console.log(`  [要確認の誤り] ${s.id} 正解=${s.expected} 出力=${s.actual} / ${s.title}`);
  for (const s of ev.droppedWrongly) console.log(`  [誤除外] (${s.item}) ${s.text} ← ${s.reason}`);
  for (const s of ev.overMerged) console.log(`  [過結合] ${s.ids.join('+')} / ${s.title}`);
  for (const s of ev.suspectedAdditions) console.log(`  [具体値の追加] ${s.token} / ${s.request}`);

  await writeFile(
    join(outDir, 'result.json'),
    JSON.stringify(
      {
        tag,
        ok: true,
        chunkInfo,
        usage: r.organize.ok ? r.organize.usage : undefined,
        partUsage: chunkInfo ? undefined : undefined,
        llmElapsedMs: r.organize.elapsedMs,
        wallMs: wall,
        commandLine: r.organize.commandLine,
        issues: r.organize.issues,
        eval: ev,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`  ${outDir}`);
}

await main();
