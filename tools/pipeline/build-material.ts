/**
 * 素材を実際に文字起こしして、分解パイプラインの入力（Material）を作る。
 * 録画中の逐次処理を模擬して、無音の切れ目ごとに whisper を呼ぶ。
 *
 *   npx tsx tools/pipeline/build-material.ts <materialDir> [--model large-v3-turbo]
 *
 * 話者のマージと二重取り除去の結果を、台本（正解）と突き合わせて評価する。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os'
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WhisperCppEngine } from '../../src/main/pipeline/stt/whisper';
import type { WhisperOptions } from '../../src/main/pipeline/stt/whisper';
import { OpenAiSttEngine } from '../../src/main/pipeline/stt/openai';
import type { OpenAiSttModel } from '../../src/main/pipeline/stt/openai';
import type { SttEngine } from '../../src/main/pipeline/stt/engine';
import { mergeTranscripts, singleChannelTranscript } from '../../src/main/pipeline/merge';
import type { Event, FrameRef, Material, SessionMeta, Speaker, TranscriptSegment } from '../../src/main/pipeline/types';

const exec = promisify(execFile);
const MODEL_DIR = process.env.ADE_MODEL_DIR ?? join(homedir(), '.cache', 'ade-movie', 'models');
const BINARY = process.env.ADE_WHISPER_BIN ?? '/opt/homebrew/bin/whisper-cli';
const INITIAL_PROMPT =
  'UIレビューの会話です。ボタン、ラベル、ヘッダー、サイドバー、アコーディオン、トグル、ダッシュボード、スマホ幅、月額、年額、税抜、CSV、ダークモードなどの言葉が出ます。';

interface TruthLine {
  index: number;
  t0: number;
  t1: number;
  speaker: Speaker;
  text: string;
  item: string | null;
  bleedToMic: boolean;
}
interface Truth {
  durationMs: number;
  twoSpeakers: boolean;
  lines: TruthLine[];
  expected: Array<{ id: string; gist: string; status: string }>;
}

/** 無音の切れ目でチャンクに割る（録画中の逐次処理） */
async function chunkBoundaries(lines: TruthLine[], durationMs: number): Promise<number[]> {
  const bounds: number[] = [0];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i]!.t0 - lines[i - 1]!.t1;
    if (gap >= 2000) bounds.push(Math.round(lines[i - 1]!.t1 + gap / 2));
  }
  bounds.push(durationMs);
  return bounds;
}

async function transcribeChannel(
  wav: string,
  lines: TruthLine[],
  durationMs: number,
  speaker: Speaker,
  source: 'mic' | 'system',
  engine: SttEngine,
  chunkDir: string,
): Promise<{ segments: TranscriptSegment[]; totalMs: number; lastMs: number; billedSeconds: number }> {
  await mkdir(chunkDir, { recursive: true });
  const bounds = await chunkBoundaries(lines, durationMs);
  const segments: TranscriptSegment[] = [];
  let totalMs = 0;
  let lastMs = 0;
  let billedSeconds = 0;

  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i]!;
    const end = bounds[i + 1]!;
    const path = join(chunkDir, `c${String(i).padStart(3, '0')}.wav`);
    await exec('ffmpeg', ['-y', '-v', 'error', '-i', wav, '-ss', String(start / 1000), '-to', String(end / 1000), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', path]);
    const r = await engine.transcribeChunk({
      wavPath: path, offsetMs: start, speaker, source, durationMs: end - start,
    });
    segments.push(...r.segments);
    totalMs += r.elapsedMs;
    lastMs = r.elapsedMs;
    billedSeconds += r.billedSeconds ?? 0;
  }
  return { segments, totalMs, lastMs, billedSeconds };
}

/** 二重取り除去の評価。回り込み由来の区間を時刻から判定する */
function evaluateDedup(
  micSegments: TranscriptSegment[],
  removed: TranscriptSegment[],
  truth: Truth,
): { bleedKept: number; bleedRemoved: number; selfRemoved: number; detail: string[] } {
  const bleedLines = truth.lines.filter((l) => l.bleedToMic);
  const selfLines = truth.lines.filter((l) => l.speaker === 'self');
  const overlaps = (s: TranscriptSegment, l: TruthLine) => s.t0 < l.t1 + 400 && l.t0 - 400 < s.t1;
  const isBleed = (s: TranscriptSegment) =>
    bleedLines.some((l) => overlaps(s, l)) && !selfLines.some((l) => overlaps(s, l));

  const detail: string[] = [];
  let bleedRemoved = 0;
  let selfRemoved = 0;
  for (const s of removed) {
    if (isBleed(s)) bleedRemoved++;
    else {
      selfRemoved++;
      detail.push(`誤って除去: [${s.t0}] ${s.text}`);
    }
  }
  let bleedKept = 0;
  for (const s of micSegments) {
    if (isBleed(s)) {
      bleedKept++;
      detail.push(`残った二重取り: [${s.t0}] ${s.text}`);
    }
  }
  return { bleedKept, bleedRemoved, selfRemoved, detail };
}

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error('使い方: tsx tools/build-material.ts <materialDir> [--model ...]');
  const mi = process.argv.indexOf('--model');
  const model = mi >= 0 ? process.argv[mi + 1]! : 'large-v3-turbo';
  const ei = process.argv.indexOf('--engine');
  const engineId = ei >= 0 ? process.argv[ei + 1]! : 'whisper';

  const truth: Truth = JSON.parse(await readFile(join(dir, 'truth.json'), 'utf8'));
  const meta: SessionMeta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
  const frames: FrameRef[] = JSON.parse(await readFile(join(dir, 'frames.json'), 'utf8'));
  const events: Event[] = (await readFile(join(dir, 'events.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Event);

  const wopt: WhisperOptions = {
    binary: BINARY,
    model: join(MODEL_DIR, `ggml-${model}.bin`),
    language: 'ja',
    threads: 8,
    suppressNonSpeech: true,
    initialPrompt: INITIAL_PROMPT,
    timeoutMs: 600_000,
  };
  const engine: SttEngine =
    engineId === 'openai'
      ? new OpenAiSttEngine({
          model: model as OpenAiSttModel,
          language: 'ja',
          ...(model === 'gpt-4o-transcribe-diarize' ? {} : { prompt: INITIAL_PROMPT }),
          timeoutMs: 900_000,
        })
      : new WhisperCppEngine(wopt);
  const tag = engineId === 'openai' ? `openai-${model}` : model;
  console.log(`エンジン: ${engine.id}（音声が端末外へ出る: ${engine.sendsAudioOffDevice ? 'はい' : 'いいえ'}）`);

  const micLines = truth.lines.filter((l) => l.speaker === 'self' || l.bleedToMic);
  const mic = await transcribeChannel(
    join(dir, 'mic.wav'), micLines, truth.durationMs, 'self', 'mic', engine, join(dir, `chunks-mic-${tag}`),
  );
  console.log(`マイク系統: ${mic.segments.length}区間 / whisper合計 ${(mic.totalMs / 1000).toFixed(1)}s / 最終区切り ${(mic.lastMs / 1000).toFixed(2)}s`);

  let transcript: TranscriptSegment[];
  let dedupReport: ReturnType<typeof evaluateDedup> | undefined;

  if (truth.twoSpeakers && existsSync(join(dir, 'system.wav'))) {
    const sysLines = truth.lines.filter((l) => l.speaker === 'other');
    const sys = await transcribeChannel(
      join(dir, 'system.wav'), sysLines, truth.durationMs, 'other', 'system', engine, join(dir, `chunks-system-${tag}`),
    );
    console.log(`PC音声系統: ${sys.segments.length}区間 / whisper合計 ${(sys.totalMs / 1000).toFixed(1)}s / 最終区切り ${(sys.lastMs / 1000).toFixed(2)}s`);

    const merged = mergeTranscripts(mic.segments, sys.segments);
    transcript = merged.segments;
    const keptMic = merged.segments.filter((s) => s.source === 'mic');
    dedupReport = evaluateDedup(keptMic, merged.removed.map((r) => r.segment), truth);
    console.log(
      `二重取り除去: 除去 ${merged.removed.length}件（うち回り込み ${dedupReport.bleedRemoved}件 / 誤除去 ${dedupReport.selfRemoved}件）、残った回り込み ${dedupReport.bleedKept}件`,
    );
    for (const d of dedupReport.detail.slice(0, 12)) console.log(`  ${d}`);
  } else {
    transcript = singleChannelTranscript(mic.segments);
  }

  const material: Material = { meta, transcript, events, frames };
  await writeFile(join(dir, `material.${tag}.json`), JSON.stringify(material, null, 2), 'utf8');
  await writeFile(
    join(dir, `stt-report.${tag}.json`),
    JSON.stringify(
      {
        engine: engine.id,
        model,
        micChunkTotalSec: +(mic.totalMs / 1000).toFixed(2),
        micLastChunkSec: +(mic.lastMs / 1000).toFixed(2),
        segments: transcript.length,
        dedup: dedupReport,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`${join(dir, `material.${tag}.json`)}  （${transcript.length}区間）`);
}

await main();
