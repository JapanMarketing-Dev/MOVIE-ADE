/**
 * OpenAI STT API の実測。ローカル whisper.cpp と同じ指標で比べる。
 *
 *   npx tsx tools/bench-stt-openai.ts <materialDir> --model gpt-transcribe [--channel mic|system|mixed]
 *       [--chunked] [--diarized-speakers]
 *
 * APIキーは環境変数 OPENAI_API_KEY から読む。**値は一切出力しない。**
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OpenAiSttEngine, openAiSttPricePerMinuteUsd } from '../../src/main/pipeline/stt/openai';
import type { OpenAiSttModel } from '../../src/main/pipeline/stt/openai';
import { wavDurationMs } from '../../src/main/pipeline/stt/wav';
import type { Speaker, TranscriptSegment } from '../../src/main/pipeline/types';
import { characterErrorRate, termRecall } from './metrics';

const exec = promisify(execFile);

const INITIAL_PROMPT =
  'UIレビューの会話です。ボタン、ラベル、ヘッダー、サイドバー、アコーディオン、トグル、ダッシュボード、スマホ幅、月額、年額、税抜、CSV、ダークモードなどの言葉が出ます。';
const KEYWORDS = ['トグル', '税抜', 'アコーディオン', 'サイドバー', 'ダークモード', 'スマホ幅'];
const KEY_TERMS = [
  '無料で始める', '税抜', '月額', 'アコーディオン', 'ダッシュボード', 'スマホ幅',
  '二重送信', 'サイドバー', 'ダークモード', 'CSV', 'トグル', 'パスワード',
];

interface TruthLine {
  index: number; t0: number; t1: number; speaker: Speaker; text: string; item: string | null; bleedToMic: boolean;
}
interface Truth { durationMs: number; twoSpeakers: boolean; lines: TruthLine[] }

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** 無音の切れ目で分割（録画中の逐次処理の模擬）。whisper.cpp のベンチと同じ境界 */
async function splitAtSilence(wav: string, lines: TruthLine[], durationMs: number, outDir: string) {
  await mkdir(outDir, { recursive: true });
  const bounds = [0];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i]!.t0 - lines[i - 1]!.t1;
    if (gap >= 2000) bounds.push(Math.round(lines[i - 1]!.t1 + gap / 2));
  }
  bounds.push(durationMs);
  const chunks: Array<{ path: string; offsetMs: number; durationMs: number }> = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i]!;
    const end = bounds[i + 1]!;
    const path = join(outDir, `c${String(i).padStart(3, '0')}.wav`);
    await exec('ffmpeg', ['-y', '-v', 'error', '-i', wav, '-ss', String(start / 1000), '-to', String(end / 1000),
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', path]);
    chunks.push({ path, offsetMs: start, durationMs: end - start });
  }
  return chunks;
}

/** 話者分離の精度: 各区間を時間の重なりが最大の台本行に当て、話者が一致するか */
function diarizationAccuracy(segments: TranscriptSegment[], truth: Truth) {
  let matched = 0;
  let correct = 0;
  const confusion: Record<string, number> = {};
  for (const s of segments) {
    let best: TruthLine | undefined;
    let bestOverlap = 0;
    for (const l of truth.lines) {
      const ov = Math.min(s.t1, l.t1) - Math.max(s.t0, l.t0);
      if (ov > bestOverlap) { bestOverlap = ov; best = l; }
    }
    if (!best || bestOverlap <= 0) continue;
    matched++;
    const key = `正解=${best.speaker} 出力=${s.speaker}`;
    confusion[key] = (confusion[key] ?? 0) + 1;
    if (best.speaker === s.speaker) correct++;
  }
  const labels = [...new Set(segments.map((s) => s.speakerLabel).filter(Boolean))];
  return { matched, correct, rate: matched > 0 ? correct / matched : 0, labels, confusion };
}

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error('使い方: tsx tools/bench-stt-openai.ts <materialDir> --model <id> [...]');
  const model = (arg('--model', 'gpt-transcribe')!) as OpenAiSttModel;
  const channel = arg('--channel', 'mic')! as 'mic' | 'system' | 'mixed';
  const chunked = process.argv.includes('--chunked');
  const diarizedSpeakers = process.argv.includes('--diarized-speakers');

  const truth: Truth = JSON.parse(await readFile(join(dir, 'truth.json'), 'utf8'));
  const wav = join(dir, `${channel}.wav`);
  const audioMs = await wavDurationMs(wav);
  const label = `${basename(dir)}/${channel}`;

  // 参照テキスト（その系統に物理的に入っている発話）
  const refSpeaker: Speaker = channel === 'system' ? 'other' : 'self';
  const refLines =
    channel === 'mixed'
      ? truth.lines
      : truth.lines.filter((l) => l.speaker === refSpeaker || (channel === 'mic' && l.bleedToMic));
  const ref = [...refLines].sort((a, b) => a.t0 - b.t0).map((l) => l.text).join('');
  const terms = KEY_TERMS.filter((t) => ref.includes(t));

  const engine = new OpenAiSttEngine({
    model,
    language: 'ja',
    ...(model === 'gpt-4o-transcribe-diarize' ? {} : { prompt: INITIAL_PROMPT }),
    ...(model === 'gpt-transcribe' ? { keywords: KEYWORDS } : {}),
    ...(diarizedSpeakers ? { useDiarizedSpeakers: true } : {}),
    timeoutMs: 900_000,
  });

  console.log(`${label} / ${model}${chunked ? ' / 逐次' : ' / 一括'}${diarizedSpeakers ? ' / 話者分離を採用' : ''}`);

  let segments: TranscriptSegment[] = [];
  let totalMs = 0;
  let lastMs = 0;
  let maxMs = 0;
  let billedSeconds = 0;
  let requests = 0;

  if (chunked) {
    const chunkLines = channel === 'mixed' ? truth.lines : refLines;
    const chunks = await splitAtSilence(wav, chunkLines, truth.durationMs, join(dir, `chunks-oa-${channel}`));
    for (const c of chunks) {
      const r = await engine.transcribeChunk({
        wavPath: c.path, offsetMs: c.offsetMs, speaker: refSpeaker,
        source: channel === 'system' ? 'system' : 'mic', durationMs: c.durationMs,
      });
      segments.push(...r.segments);
      totalMs += r.elapsedMs;
      lastMs = r.elapsedMs;
      maxMs = Math.max(maxMs, r.elapsedMs);
      billedSeconds += r.billedSeconds ?? 0;
      requests++;
    }
    console.log(`  逐次 ${chunks.length}区切り 合計${(totalMs / 1000).toFixed(1)}s 最終区切り${(lastMs / 1000).toFixed(2)}s 最大${(maxMs / 1000).toFixed(2)}s`);
  } else {
    const r = await engine.transcribeChunk({
      wavPath: wav, offsetMs: 0, speaker: refSpeaker,
      source: channel === 'system' ? 'system' : 'mic', durationMs: audioMs,
    });
    segments = r.segments;
    totalMs = r.elapsedMs;
    lastMs = r.elapsedMs;
    maxMs = r.elapsedMs;
    billedSeconds = r.billedSeconds ?? 0;
    requests = 1;
    console.log(`  一括 ${(totalMs / 1000).toFixed(1)}s（音声長比 ${(totalMs / audioMs).toFixed(3)}×RT）`);
  }

  const hyp = segments.map((s) => s.text).join('');
  const cer = characterErrorRate(ref, hyp);
  const recall = termRecall(hyp, terms);
  const costUsd = (billedSeconds / 60) * openAiSttPricePerMinuteUsd[model];
  const hourlyUsd = openAiSttPricePerMinuteUsd[model] * 60;

  console.log(`  CER ${(cer * 100).toFixed(1)}% / 用語 ${recall.hit.length}/${terms.length}${recall.miss.length ? `（未検出 ${recall.miss.join(' ')}）` : ''} / 区間 ${segments.length}`);
  console.log(`  課金 ${billedSeconds}秒 = $${costUsd.toFixed(4)}（リクエスト ${requests}回） / 録画1時間あたり $${hourlyUsd.toFixed(3)}`);

  const diar = engine.hasDiarization ? diarizationAccuracy(segments, truth) : undefined;
  if (diar) {
    console.log(`  話者分離: ラベル ${diar.labels.join(',') || '-'} / 一致 ${diar.correct}/${diar.matched}（${(diar.rate * 100).toFixed(1)}%）`);
    for (const [k, v] of Object.entries(diar.confusion)) console.log(`    ${k}: ${v}件`);
  }

  const out = join(dir, `oa-${model}-${channel}${chunked ? '-chunked' : ''}${diarizedSpeakers ? '-diar' : ''}.json`);
  await writeFile(out, JSON.stringify({
    label, model, channel, chunked, diarizedSpeakers, audioMs,
    totalMs, lastMs, maxMs, requests, billedSeconds, costUsd, hourlyUsd,
    cerPct: +(cer * 100).toFixed(1), termHit: `${recall.hit.length}/${terms.length}`, termMiss: recall.miss,
    diarization: diar, segments,
  }, null, 2), 'utf8');
  console.log(`  ${out}`);
}

await main();
