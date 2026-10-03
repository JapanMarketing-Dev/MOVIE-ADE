/**
 * LLM整理の品質評価。
 *
 * 台本（正解）との突き合わせは「引用の時刻」を手がかりにする:
 *   LLM出力の quote.t → 文字起こしの区間 → その時刻に重なる台本の行 → 行の item ラベル
 * これで、言い換えの表現に左右されずに「どの指摘を拾えたか」を機械的に判定できる。
 */
import type { FeedbackDocument, Material, OrganizeOutput, TranscriptSegment } from '../../src/main/pipeline/types';
import { normalizeJa } from '../../src/main/pipeline/text';

export interface TruthLine {
  index: number;
  t0: number;
  t1: number;
  speaker: 'self' | 'other';
  text: string;
  item: string | null;
  bleedToMic: boolean;
}

export interface Truth {
  durationMs: number;
  twoSpeakers: boolean;
  lines: TruthLine[];
  expected: Array<{ id: string; gist: string; status: 'decided' | 'needs_check' }>;
}

/** 誤変換の補正が効いたかを見る対（文字起こしに現れた誤り → 正しい語） */
export const correctionChecks = [
  { wrong: 'バジ', right: 'バッジ' },
  { wrong: 'ランの枠', right: '欄' },
  { wrong: '税抜け', right: '税抜' },
  { wrong: 'ホームから', right: '法務' },
  { wrong: '数理', right: '数字' },
  { wrong: 'をとく', right: 'お得' },
  { wrong: '規定に', right: '既定' },
  { wrong: 'ランの下', right: '欄' },
];

export interface EvalResult {
  expectedCount: number;
  producedCount: number;
  covered: string[];
  missing: string[];
  /** 台本の指摘に結び付かない指摘（＝つなぎ言葉や雑談から作ってしまったもの） */
  spurious: Array<{ title: string; request: string; quotes: string[] }>;
  /** 1つの台本の指摘が複数件に割れた */
  overSplit: Array<{ id: string; count: number }>;
  /** 複数の台本の指摘が1件にまとまった */
  overMerged: Array<{ title: string; ids: string[] }>;
  statusOk: number;
  statusWrong: Array<{ id: string; expected: string; actual: string; title: string }>;
  /** 指摘になるべき発話を dropped にした（内容の取りこぼし） */
  droppedWrongly: Array<{ t: number; text: string; reason: string; item: string }>;
  droppedCount: number;
  /**
   * 誤変換の補正。
   *  fixed  : 正しい語が title/request に出ている
   *  leaked : 誤ったままの語が title/request に出ている（＝補正の失敗）
   *  どちらも false なら、その語が要約に含まれなかっただけ（失敗ではない）
   */
  corrections: Array<{ wrong: string; right: string; fixed: boolean; leaked: boolean; appearsInTranscript: boolean }>;
  /** 画像の時刻がすべて実在するか、書き込みのある指摘で書き込み後の時刻を選べているか */
  frameAllValid: boolean;
  frameAfterAnnotation: { ok: number; late: number };
  /** 要望に、引用に無い具体的な指定（色コード・数値）が混ざっていないか（捏造の候補。目視確認用） */
  suspectedAdditions: Array<{ title: string; request: string; token: string }>;
}

function labelsForTime(transcript: TranscriptSegment[], truth: Truth, t: number): Set<string | null> {
  const seg = transcript.find((s) => s.t0 === t) ?? nearestSegment(transcript, t);
  const out = new Set<string | null>();
  if (!seg) return out;
  for (const l of truth.lines) {
    if (l.speaker !== seg.speaker) continue;
    if (seg.t0 < l.t1 + 500 && l.t0 - 500 < seg.t1) out.add(l.item);
  }
  return out;
}

function nearestSegment(transcript: TranscriptSegment[], t: number): TranscriptSegment | undefined {
  let best: TranscriptSegment | undefined;
  let d = Infinity;
  for (const s of transcript) {
    const dd = Math.abs(s.t0 - t);
    if (dd < d) {
      best = s;
      d = dd;
    }
  }
  return d <= 3000 ? best : undefined;
}

/** 言っていない具体値を足していないかの当たり（最終判断は目視） */
const ADDITION_PATTERNS = [/#[0-9a-fA-F]{3,6}/g, /\b\d+\s?px\b/g, /\brem\b/g, /\b\d+ms\b/g];

export function evaluateOrganize(
  material: Material,
  truth: Truth,
  output: OrganizeOutput,
  doc: FeedbackDocument,
): EvalResult {
  const transcript = material.transcript;
  const expectedIds = truth.expected.map((e) => e.id);
  const expectedStatus = new Map(truth.expected.map((e) => [e.id, e.status]));

  const itemLabels: Array<{ item: OrganizeOutput['items'][number]; ids: string[] }> = output.items.map((item) => {
    const ids = new Set<string>();
    for (const q of item.quotes) {
      for (const l of labelsForTime(transcript, truth, q.t)) if (l) ids.add(l);
    }
    return { item, ids: [...ids] };
  });

  const coverCount = new Map<string, number>();
  for (const { ids } of itemLabels) for (const id of ids) coverCount.set(id, (coverCount.get(id) ?? 0) + 1);

  const covered = expectedIds.filter((id) => (coverCount.get(id) ?? 0) > 0);
  const missing = expectedIds.filter((id) => (coverCount.get(id) ?? 0) === 0);
  const overSplit = [...coverCount.entries()].filter(([, c]) => c > 1).map(([id, count]) => ({ id, count }));
  const overMerged = itemLabels
    .filter((x) => x.ids.length > 1)
    .map((x) => ({ title: x.item.title, ids: x.ids }));
  const spurious = itemLabels
    .filter((x) => x.ids.length === 0)
    .map((x) => ({ title: x.item.title, request: x.item.request, quotes: x.item.quotes.map((q) => q.text) }));

  let statusOk = 0;
  const statusWrong: EvalResult['statusWrong'] = [];
  for (const { item, ids } of itemLabels) {
    if (ids.length !== 1) continue;
    const id = ids[0]!;
    const want = expectedStatus.get(id);
    if (!want) continue;
    if (want === item.status) statusOk++;
    else statusWrong.push({ id, expected: want, actual: item.status, title: item.title });
  }

  // 除外の妥当性
  const droppedWrongly: EvalResult['droppedWrongly'] = [];
  for (const d of output.dropped) {
    const labels = labelsForTime(transcript, truth, d.t);
    const real = [...labels].filter((l): l is string => l !== null);
    // 文字起こしの1区間が「指摘」と「つなぎ言葉」の両方を含む場合は判定しない
    if (real.length > 0 && !labels.has(null)) {
      droppedWrongly.push({ t: d.t, text: d.text, reason: d.reason, item: real[0]! });
    }
  }

  // 誤変換の補正
  const allTranscript = normalizeJa(transcript.map((s) => s.text).join(''));
  const allOutput = normalizeJa(output.items.map((i) => `${i.title}${i.request}`).join(''));
  const corrections = correctionChecks.map((c) => ({
    ...c,
    appearsInTranscript: allTranscript.includes(normalizeJa(c.wrong)),
    fixed: allOutput.includes(normalizeJa(c.right)),
    leaked: allOutput.includes(normalizeJa(c.wrong)),
  }));

  // 画像の時刻
  const frameTimes = new Set(material.frames.map((f) => f.t));
  const frameAllValid = output.items.every((i) => i.frame_times.every((t) => frameTimes.has(t)));
  const annById = new Map(
    material.events
      .filter((e) => e.type === 'pen' || e.type === 'text')
      .map((e) => [
        (e as { id: string }).id,
        e.type === 'pen' ? (e as { t_end: number }).t_end : e.t,
      ]),
  );
  let ok = 0;
  let late = 0;
  for (const i of output.items) {
    if (i.annotation_ids.length === 0 || i.frame_times.length === 0) continue;
    const need = Math.min(...i.annotation_ids.map((id) => annById.get(id) ?? Infinity));
    if (!Number.isFinite(need)) continue;
    if (i.frame_times.some((t) => t >= need)) ok++;
    else late++;
  }

  const suspectedAdditions: EvalResult['suspectedAdditions'] = [];
  for (const i of output.items) {
    const quoted = i.quotes.map((q) => q.text).join('');
    for (const re of ADDITION_PATTERNS) {
      for (const m of i.request.matchAll(re)) {
        if (!quoted.includes(m[0])) {
          suspectedAdditions.push({ title: i.title, request: i.request, token: m[0] });
        }
      }
    }
  }

  return {
    expectedCount: expectedIds.length,
    producedCount: output.items.length,
    covered,
    missing,
    spurious,
    overSplit,
    overMerged,
    statusOk,
    statusWrong,
    droppedWrongly,
    droppedCount: output.dropped.length,
    corrections,
    frameAllValid,
    frameAfterAnnotation: { ok, late },
    suspectedAdditions,
  };
}

export function summarize(r: EvalResult): string {
  const fixable = r.corrections.filter((c) => c.appearsInTranscript);
  return [
    `指摘 ${r.producedCount}件（正解 ${r.expectedCount}件）`,
    `カバレッジ ${r.covered.length}/${r.expectedCount}`,
    `漏れ ${r.missing.length}（${r.missing.join(',') || '-'}）`,
    `捏造の疑い ${r.spurious.length}`,
    `過分割 ${r.overSplit.length} / 過結合 ${r.overMerged.length}`,
    `要確認の判定 ${r.statusOk}正解 / ${r.statusWrong.length}誤り`,
    `誤除外 ${r.droppedWrongly.length}（除外 ${r.droppedCount}件中）`,
    `誤変換 対象${fixable.length}語: 補正${fixable.filter((c) => c.fixed).length} / 誤りが残った${fixable.filter((c) => c.leaked).length} / 要約に出ず${fixable.filter((c) => !c.fixed && !c.leaked).length}`,
    `画像時刻 ${r.frameAllValid ? '全て実在' : '不正あり'} / 書き込み後 ${r.frameAfterAnnotation.ok}件・前 ${r.frameAfterAnnotation.late}件`,
  ].join('\n  ');
}
