/**
 * LLM の実行方法のインタフェース（EXT-10「実行方法は差し替え可能」）。
 * 分解処理は「入力JSON → 出力JSON」の1関数で、ここだけを差し替える。
 */

export interface RunnerRequest {
  /** CLI に渡すプロンプト全文 */
  prompt: string;
  /** 出力の JSON Schema */
  schema: unknown;
  /**
   * セッションフォルダ（記録用）。CLI の runner はここを作業フォルダにせず、実行ごとの空の一時フォルダで動かす
   * （プロンプトにページの文字が入るため、ファイルを見せない。security-2 [3]）
   */
  cwd: string;
  /** タイムアウト(ms) */
  timeoutMs: number;
  /** モデル名（CLI の指定方法に従う） */
  model?: string
}

export interface RunnerResult {
  /** パース前の生テキスト（JSON想定） */
  raw: string
  elapsedMs: number;
  /** 実際に実行したコマンドライン（記録・FINDINGS用） */
  commandLine: string;
  /** stderr の末尾（失敗の調査用） */
  stderrTail?: string;
  /** CLI が報告したトークン数など（計測用。無い場合もある） */
  usage?: Record<string, unknown>
}

export interface LlmRunner {
  /** 設定・ログで使う識別子 */
  readonly id: string;
  /** インストール・ログイン済みかを調べる（起動時の検出。設計6章） */
  available(): Promise<boolean>
  run(req: RunnerRequest): Promise<RunnerResult>
}

export class RunnerError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'exit' | 'spawn' | 'empty',
    readonly commandLine?: string,
    readonly stderrTail?: string,
  ) {
    super(message)
    this.name = 'RunnerError'
  }
}
