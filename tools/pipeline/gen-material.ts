/**
 * テスト用素材の生成。
 * macOS の `say`（日本語音声）で台本を読み上げ、`afconvert` で 16kHz モノラル WAV にする。
 * 台本から操作ログ・静止画の時刻一覧・正解データも同時に書き出す。
 *
 *   npx tsx tools/gen-material.ts <出力フォルダ>
 *
 * 注意: 合成音声は実際の人の声より明瞭で、口ごもり・言い直し・被りが無い。
 * 文字起こしの精度はここで測った値より実環境では落ちる（FINDINGS.md「限界」参照）。
 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Cue, Line, Material as Script } from './scripts/types';
import { materialA } from './scripts/material-a';
import { materialB } from './scripts/material-b';
import type { Event, FrameRef, SessionMeta } from '../../src/main/pipeline/types';

const exec = promisify(execFile);

/** 静止画の基準間隔(ms)。設計では0.5秒ごとに撮って変化時のみ保存するので、変化点＋この間隔で模擬する */
const FRAME_BASE_INTERVAL = 3000;

interface PlacedLine extends Line {
  index: number;
  /** 録画開始からの開始時刻(ms) */
  t0: number;
  /** 終了時刻(ms) */
  t1: number;
  wav: string;
}

async function synthesize(text: string, voice: string, rate: number, outDir: string, name: string): Promise<{ wav: string; durationMs: number }> {
  const wav = join(outDir, `${name}.wav`);
  // 16kHz モノラル 16bit PCM（whisper.cpp の想定入力）を say から直接出す
  await exec('say', [
    '-v', voice,
    '-r', String(rate),
    '-o', wav,
    '--data-format=LEI16@16000',
    '--file-format=WAVE',
    text,
  ]);
  const { stdout } = await exec('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav,
  ]);
  const durationMs = Math.round(Number(stdout.trim()) * 1000);
  return { wav, durationMs };
}

async function mixChannel(
  parts: Array<{ wav: string; delayMs: number; volume: number }>,
  totalMs: number,
  out: string,
): Promise<void> {
  if (parts.length === 0) {
    await exec('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', `anullsrc=r=16000:cl=mono`,
      '-t', String(totalMs / 1000), '-c:a', 'pcm_s16le', out,
    ]);
    return;
  }
  const args: string[] = ['-y'];
  for (const p of parts) args.push('-i', p.wav);
  const chains = parts
    .map((p, i) => `[${i}:a]adelay=${p.delayMs}|${p.delayMs},volume=${p.volume}[a${i}]`)
    .join(';');
  const mixIn = parts.map((_, i) => `[a${i}]`).join('');
  const filter = `${chains};${mixIn}amix=inputs=${parts.length}:normalize=0:dropout_transition=0[mix];[mix]apad[outa]`;
  args.push(
    '-filter_complex', filter,
    '-map', '[outa]',
    '-t', String(totalMs / 1000),
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
    out,
  );
  await exec('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 });
}

function buildEvents(script: Script, placed: PlacedLine[]): Event[] {
  const events: Event[] = [
    { t: 0, type: 'nav', url: script.initialNav.url, title: script.initialNav.title, viewport: script.initialNav.viewport },
  ];
  if (script.initialNav.viewport) {
    events.push({ t: 0, type: 'viewport', width: script.initialNav.viewport });
  }

  for (const line of placed) {
    for (const cue of line.cues ?? []) {
      const t = Math.max(0, line.t0 + cue.at);
      events.push(...cueToEvents(cue, t));
    }
  }
  return events.sort((a, b) => a.t - b.t);
}

function cueToEvents(cue: Cue, t: number): Event[] {
  switch (cue.type) {
    case 'nav': {
      const out: Event[] = [{ t, type: 'nav', url: cue.url, title: cue.title, viewport: cue.viewport }];
      if (cue.viewport) out.push({ t, type: 'viewport', width: cue.viewport });
      return out;
    }
    case 'click':
      return [{ t, type: 'click', x: cue.x, y: cue.y, el: { selector: cue.selector, ...(cue.text ? { text: cue.text } : {}) } }];
    case 'scroll':
      return [{ t, type: 'scroll', y: cue.y }];
    case 'pen':
      return [{
        t,
        type: 'pen',
        id: cue.id,
        t_end: t + cue.durationMs,
        bbox: cue.bbox,
        el: { selector: cue.selector, ...(cue.text ? { text: cue.text } : {}) },
      }];
    case 'text':
      return [{
        t,
        type: 'text',
        id: cue.id,
        x: cue.x,
        y: cue.y,
        body: cue.body,
        ...(cue.selector ? { el: { selector: cue.selector, ...(cue.elText ? { text: cue.elText } : {}) } } : {}),
      }];
  }
}

/** 画面が変化した時刻（nav・click・scroll・ペン確定・テキスト設置）＋基準間隔 */
function buildFrames(events: Event[], totalMs: number): FrameRef[] {
  const times = new Set<number>([0]);
  for (let t = FRAME_BASE_INTERVAL; t < totalMs; t += FRAME_BASE_INTERVAL) times.add(t);
  for (const e of events) {
    if (e.type === 'nav' || e.type === 'click' || e.type === 'scroll') times.add(e.t + 200);
    if (e.type === 'pen') times.add(e.t_end + 100);
    if (e.type === 'text') times.add(e.t + 300);
  }
  const sorted = [...times].filter((t) => t >= 0 && t <= totalMs).sort((a, b) => a - b);
  // カーソル位置は直前のクリック座標を使う（EXT-3 のリング合成用）
  let cursor = { x: 640, y: 360 };
  const clicks = events.filter((e): e is Extract<Event, { type: 'click' }> => e.type === 'click');
  return sorted.map((t) => {
    for (const c of clicks) if (c.t <= t) cursor = { x: c.x, y: c.y };
    return { t, path: `work/frames/${String(t).padStart(7, '0')}.png`, cursor: { ...cursor } };
  });
}

async function generate(script: Script, outRoot: string): Promise<void> {
  const dir = join(outRoot, `material-${script.name}`);
  const partsDir = join(dir, 'parts');
  await mkdir(partsDir, { recursive: true });

  // 1. 各行を合成して長さを測る
  const placed: PlacedLine[] = [];
  let cursor = 0;
  for (let i = 0; i < script.lines.length; i++) {
    const line = script.lines[i]!;
    const voice = line.speaker === 'self' ? script.voices.self : (script.voices.other ?? script.voices.self);
    const { wav, durationMs } = await synthesize(line.text, voice, script.rate, partsDir, `l${String(i).padStart(3, '0')}`);
    const t0 = cursor + line.gap;
    placed.push({ ...line, index: i, t0, t1: t0 + durationMs, wav });
    cursor = t0 + durationMs;
    process.stdout.write(`\r  合成 ${i + 1}/${script.lines.length}`);
  }
  process.stdout.write('\n');

  const totalMs = cursor + 2000;

  // 2. 系統ごとにミックス
  const micParts = placed
    .filter((p) => p.speaker === 'self')
    .map((p) => ({ wav: p.wav, delayMs: p.t0, volume: 1 }));
  // スピーカー回り込み: 150ms 遅れ・音量 0.35 でマイク側へ混ぜる
  const bleeds = placed.filter((p) => p.speaker === 'other' && p.bleedToMic);
  for (const b of bleeds) micParts.push({ wav: b.wav, delayMs: b.t0 + 150, volume: 0.35 });

  const sysParts = placed
    .filter((p) => p.speaker === 'other')
    .map((p) => ({ wav: p.wav, delayMs: p.t0, volume: 1 }));

  await mixChannel(micParts, totalMs, join(dir, 'mic.wav'));
  if (script.twoSpeakers) await mixChannel(sysParts, totalMs, join(dir, 'system.wav'));

  // 3. 操作ログ・静止画・正解データ
  const events = buildEvents(script, placed);
  const frames = buildFrames(events, totalMs);
  const meta: SessionMeta = {
    id: `material-${script.name}`,
    startedAt: script.startedAt,
    durationMs: totalMs,
    targetUrl: script.initialNav.url,
    twoSpeakers: script.twoSpeakers,
  };

  await writeFile(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  await writeFile(join(dir, 'frames.json'), JSON.stringify(frames, null, 2), 'utf8');
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  await writeFile(
    join(dir, 'truth.json'),
    JSON.stringify(
      {
        name: script.name,
        durationMs: totalMs,
        twoSpeakers: script.twoSpeakers,
        bleedLineIndexes: bleeds.map((b) => b.index),
        lines: placed.map((p) => ({
          index: p.index,
          t0: p.t0,
          t1: p.t1,
          speaker: p.speaker,
          text: p.text,
          item: p.item,
          bleedToMic: p.bleedToMic ?? false,
        })),
        expected: script.expected,
      },
      null,
      2,
    ),
    'utf8',
  );

  const mins = (totalMs / 60000).toFixed(1);
  console.log(`素材${script.name}: ${mins}分 / 行 ${placed.length} / 指摘(正解) ${script.expected.length} / 静止画 ${frames.length} / 二重取り ${bleeds.length}`);
  console.log(`  ${dir}`);
}

const outRoot = resolve(process.argv[2] ?? './materials');
await mkdir(outRoot, { recursive: true });
await generate(materialA, outRoot);
await generate(materialB, outRoot);
