/** 合成音声の台本（＝正解データ）の型 */

export interface CueNav {
  type: 'nav';
  /** 行の開始からの相対時刻(ms)。負なら行の前 */
  at: number;
  url: string;
  title: string;
  viewport?: number;
}
export interface CueClick {
  type: 'click';
  at: number;
  x: number;
  y: number;
  selector: string;
  text?: string;
}
export interface CueScroll {
  type: 'scroll';
  at: number;
  y: number;
}
export interface CuePen {
  type: 'pen';
  at: number;
  id: string;
  durationMs: number;
  bbox: [number, number, number, number];
  selector: string;
  text?: string;
}
export type Cue = CueNav | CueClick | CueScroll | CuePen;

export interface Line {
  /** 'self' = マイク系統、'other' = PC音声系統 */
  speaker: 'self' | 'other';
  /** 直前の行の終わりからの間隔(ms) */
  gap: number;
  text: string;
  /**
   * 正解のラベル。
   *  - 文字列: その指摘に属する（同じIDの行は1件の指摘にまとまるのが正解）
   *  - null: 指摘ではない（つなぎ言葉・独り言・雑談）→ dropped が正解
   */
  item: string | null;
  cues?: Cue[];
  /** この行をマイク側にも二重で入れる（スピーカーの回り込みを模擬） */
  bleedToMic?: boolean;
}

export interface Material {
  name: string;
  /** 'ja_JP' の声名（say -v） */
  voices: { self: string; other?: string };
  /** say の話速 */
  rate: number;
  twoSpeakers: boolean;
  startedAt: string;
  initialNav: CueNav;
  lines: Line[];
  /** 正解の指摘（期待する見出し・要望の要旨と、結論が出ているか） */
  expected: Array<{ id: string; gist: string; status: 'decided' | 'needs_check' }>;
}
