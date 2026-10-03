/** 評価用の指標（文字誤り率・用語の再現率） */
import { normalizeJa } from '../../src/main/pipeline/text';

/** レーベンシュタイン距離（文字単位） */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/** 文字誤り率（正規化後）。0 が完全一致 */
export function characterErrorRate(reference: string, hypothesis: string): number {
  const ref = normalizeJa(reference);
  const hyp = normalizeJa(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return editDistance(ref, hyp) / ref.length;
}

/** 重要な用語がどれだけ拾えたか */
export function termRecall(hypothesis: string, terms: string[]): { hit: string[]; miss: string[]; rate: number } {
  const hyp = normalizeJa(hypothesis);
  const hit: string[] = [];
  const miss: string[] = [];
  for (const t of terms) {
    if (hyp.includes(normalizeJa(t))) hit.push(t);
    else miss.push(t);
  }
  return { hit, miss, rate: terms.length === 0 ? 1 : hit.length / terms.length };
}
