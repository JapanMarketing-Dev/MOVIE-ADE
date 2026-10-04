/**
 * whisper.cpp のモデル比較。
 *   npx tsx tools/pipeline/bench-stt.ts <materialDir> [--models a,b,c] [--chunked] [--nogpu] [--greedy]
 *
 * 計測: 実時間、音声長に対する比（×RT）、文字誤り率、重要語の再現率。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os'
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { transcribeChunk } from '../../src/main/pipeline/stt/whisper';
import type { WhisperOptions } from '../../src/main/pipeline/stt/whisper';
import type { TranscriptSegment } from '../../src/main/pipeline/types';
import { characterErrorRate, termRecall } from './metrics';

const exec = promisify(execFile);
const MODEL_DIR = process.env.ADE_MODEL_DIR ?? join(homedir(), '.cache', 'ade-movie', 'models');
const BINARY = process.env.ADE_WHISPER_BIN ?? '/opt/homebrew/bin/whisper-cli';

/** UI用語の初期プロンプト。誤変換を減らす狙い（効果はベンチで判定） */
const INITIAL_PROMPT =
  'UIレビューの会話です。ボタン、ラベル、ヘッダー、サイドバー、アコーディオン、トグル、ダッシュボード、スマホ幅、月額、年額、税抜、CSV、ダークモードなどの言葉が出ます。';

interface Truth {
  durationMs: number;
  twoSpeakers: boolean;
  lines: Array<{ index: number; t0: number; t1: number; speaker: 'self' | 'other'; text: string; item: string | null; bleedToMic: boolean }>;
}

const KEY_TERMS = [
  '無料で始める', '税抜', '月額', 'アコーディオン', 'ダッシュボード', 'スマホ幅',
  '二重送信', 'サイドバー', 'ダークモード', 'CSV', 'トグル', 'パスワード',
];

function parseArgs() {
  const args = process.argv.slice(2);
  const materialDir = args[0];
  if (!materialDir) throw new Error('使い方: tsx tools/bench-stt.ts <materialDir> [--models ...]');
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    materialDir,
    models: (get('--models') ?? 'tiny,base,small,large-v3-turbo-q5_0,large-v3-turbo').split(','),
    chunked: args.includes('--chunked'),
    noGpu: args.includes('--nogpu'),
    greedy: args.includes('--greedy'),
    noPrompt: args.includes('--no-prompt'),
    threads: Number(get('--threads') ?? '8'),
    out: get('--out'),
    /** どの系統を測るか。mic=自分（Bでは回り込みも入る）、system=相手 */
    channel: (get('--channel') ?? 'mic') as 'mic' | 'system',
  };
}

async function audioDurationMs(path: string): Promise<number> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]);
  return Math.round(Number(stdout.trim()) * 1000);
}

/** 無音の切れ目で音声を分割する（録画中の逐次処理の模擬） */
async function splitAtSilence(wav: string, truth: Truth, outDir: string, channel: 'self' | 'other'): Promise<Array<{ path: string; offsetMs: number }>> {
  await mkdir(outDir, { recursive: true });
  const lines = truth.lines.filter((l) => l.speaker === channel || (channel === 'self' && l.bleedToMic));
  // 2秒以上の無音をチャンク境界にする
  const bounds: number[] = [0];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i]!.t0 - lines[i - 1]!.t1;
    if (gap >= 2000) bounds.push(Math.round(lines[i - 1]!.t1 + gap / 2));
  }
  bounds.push(truth.durationMs);

  const chunks: Array<{ path: string; offsetMs: number }> = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i]!;
    const end = bounds[i + 1]!;
    const path = join(outDir, `c${String(i).padStart(3, '0')}.wav`);
    await exec('ffmpeg', ['-y', '-v', 'error', '-i', wav, '-ss', String(start / 1000), '-to', String(end / 1000), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', path]);
    chunks.push({ path, offsetMs: start });
  }
  return chunks;
}

async function main() {
  const opt = parseArgs();
  const truth: Truth = JSON.parse(await readFile(join(opt.materialDir, 'truth.json'), 'utf8'));
  const micWav = join(opt.materialDir, `${opt.channel}.wav`);
  const audioMs = await audioDurationMs(micWav);
  const label = `${basename(opt.materialDir)}/${opt.channel}`;

  // 参照テキスト: その系統に入っている発話
  const refSpeaker = opt.channel === 'mic' ? 'self' : 'other';
  // マイク系統には回り込み（bleedToMic）の音も物理的に入っているので、参照にも含める
  const refSelf = truth.lines
    .filter((l) => l.speaker === refSpeaker || (opt.channel === 'mic' && l.bleedToMic))
    .sort((a, b) => a.t0 - b.t0)
    .map((l) => l.text)
    .join('');
  // 参照に実在する用語だけを再現率の対象にする
  const terms = KEY_TERMS.filter((t) => refSelf.includes(t));

  const rows: Array<Record<string, string | number>> = [];
  const results: Record<string, { segments: TranscriptSegment[]; elapsedMs: number; commandLine: string }> = {};

  for (const model of opt.models) {
    const modelPath = join(MODEL_DIR, `ggml-${model}.bin`);
    const wopt: WhisperOptions = {
      binary: BINARY,
      model: modelPath,
      language: 'ja',
      threads: opt.threads,
      suppressNonSpeech: true,
      ...(opt.noPrompt ? {} : { initialPrompt: INITIAL_PROMPT }),
      ...(opt.greedy ? { greedy: true } : {}),
      ...(opt.noGpu ? { noGpu: true } : {}),
      timeoutMs: 1_800_000,
    };

    process.stdout.write(`${label} / ${model} … `);
    try {
      let segments: TranscriptSegment[];
      let elapsedMs: number;
      let commandLine: string;

      if (opt.chunked) {
        const chunks = await splitAtSilence(micWav, truth, join(opt.materialDir, `chunks-${opt.channel}`), refSpeaker);
        segments = [];
        elapsedMs = 0;
        commandLine = '';
        const perChunk: number[] = [];
        for (const c of chunks) {
          const r = await transcribeChunk(
            { wavPath: c.path, offsetMs: c.offsetMs, speaker: refSpeaker, source: opt.channel },
            wopt,
          );
          segments.push(...r.segments);
          elapsedMs += r.elapsedMs;
          perChunk.push(r.elapsedMs);
          commandLine = r.commandLine;
        }
        const last = perChunk[perChunk.length - 1] ?? 0;
        console.log(`逐次 ${chunks.length}区切り 合計${(elapsedMs / 1000).toFixed(1)}s 最終区切り${(last / 1000).toFixed(2)}s 最大${(Math.max(...perChunk) / 1000).toFixed(2)}s`);
        rows.push({
          model,
          mode: 'chunked',
          chunks: chunks.length,
          totalSec: +(elapsedMs / 1000).toFixed(1),
          lastChunkSec: +(last / 1000).toFixed(2),
          maxChunkSec: +(Math.max(...perChunk) / 1000).toFixed(2),
          cer: +characterErrorRate(refSelf, segments.map((s) => s.text).join("")).toFixed(4),
        });
      } else {
        const r = await transcribeChunk(
          { wavPath: micWav, offsetMs: 0, speaker: refSpeaker, source: opt.channel },
          wopt,
        );
        segments = r.segments;
        elapsedMs = r.elapsedMs;
        commandLine = r.commandLine;
        const hyp = segments.map((s) => s.text).join('');
        const cer = characterErrorRate(refSelf, hyp);
        const recall = termRecall(hyp, terms);
        const rtf = elapsedMs / audioMs;
        console.log(`${(elapsedMs / 1000).toFixed(1)}s (${rtf.toFixed(3)}×RT) CER ${(cer * 100).toFixed(1)}% 用語 ${recall.hit.length}/${terms.length}`);
        rows.push({
          model,
          mode: 'full',
          sec: +(elapsedMs / 1000).toFixed(1),
          xRT: +rtf.toFixed(3),
          cerPct: +(cer * 100).toFixed(1),
          termHit: `${recall.hit.length}/${terms.length}`,
          miss: recall.miss.join(' '),
          segments: segments.length,
        });
      }
      results[model] = { segments, elapsedMs, commandLine };
    } catch (e) {
      console.log(`失敗: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
      rows.push({ model, mode: opt.chunked ? 'chunked' : 'full', sec: -1, note: 'failed' });
    }
  }

  const outFile = opt.out ?? join(opt.materialDir, `stt-bench-${opt.channel}${opt.chunked ? '-chunked' : ''}.json`);
  await writeFile(outFile, JSON.stringify({ label, audioMs, options: opt, rows, results }, null, 2), 'utf8');
  console.log(`\n${outFile}`);
  console.table(rows);
}

await main();
