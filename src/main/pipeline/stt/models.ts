/**
 * whisper.cpp のモデル一覧と置き場所。
 *
 * 入手方針（FINDINGS.md 参照）:
 *   - バイナリ: アプリに同梱する（whisper.cpp を各OS向けにビルドして resources/ へ入れる）。
 *     開発・検証中の Mac では Homebrew の `whisper.cpp` formula（`whisper-cli`）をそのまま使える。
 *   - モデル: 同梱しない。初回起動時にユーザー設定フォルダへダウンロードする（設計1.1）。
 *     推奨モデル1つ（既定）＋ 低速な端末向けの軽量モデルを選べるようにする。
 */

import { join } from 'node:path'
import type { WhisperModelName } from '@shared/types'

/** 画面とやり取りするので、名前の一覧は shared/types に置く */
export type WhisperModelId = WhisperModelName

interface WhisperModelInfo {
  id: WhisperModelId;
  /** ggml ファイル名 */
  file: string;
  /** 概算のダウンロードサイズ(MB) */
  sizeMb: number;
  /** 正確なサイズ(バイト)。Hugging Face の LFS の値 */
  bytes: number;
  /** ダウンロード後に照合する sha256（Hugging Face の LFS の oid。2026-10-03 に API で取得） */
  sha256: string;
  /** Hugging Face の配布URL */
  url: string;
  /** UIに出す短い説明 */
  note: string
}

const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

export const whisperModels: Record<WhisperModelId, WhisperModelInfo> = {
  tiny: {
    id: 'tiny',
    file: 'ggml-tiny.bin',
    bytes: 77691713,
    sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
    sizeMb: 74,
    url: `${HF_BASE}/ggml-tiny.bin`,
    note: '最速。日本語の精度は実用水準に届かない',
  },
  base: {
    id: 'base',
    file: 'ggml-base.bin',
    bytes: 147951465,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    sizeMb: 141,
    url: `${HF_BASE}/ggml-base.bin`,
    note: '軽量。日本語は誤りが多い',
  },
  small: {
    id: 'small',
    file: 'ggml-small.bin',
    bytes: 487601967,
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
    sizeMb: 465,
    url: `${HF_BASE}/ggml-small.bin`,
    note: 'CPUのみの端末向けの下限',
  },
  medium: {
    id: 'medium',
    file: 'ggml-medium.bin',
    bytes: 1533763059,
    sha256: '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208',
    sizeMb: 1456,
    url: `${HF_BASE}/ggml-medium.bin`,
    note: 'large-v3-turbo に速度・精度の両方で劣るため既定では出さない',
  },
  'large-v3-turbo-q5_0': {
    id: 'large-v3-turbo-q5_0',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    bytes: 574041195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    sizeMb: 547,
    url: `${HF_BASE}/ggml-large-v3-turbo-q5_0.bin`,
    note: '量子化版。ディスク・メモリを節約したい場合',
  },
  'large-v3-turbo': {
    id: 'large-v3-turbo',
    file: 'ggml-large-v3-turbo.bin',
    bytes: 1624555275,
    sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
    sizeMb: 1549,
    url: `${HF_BASE}/ggml-large-v3-turbo.bin`,
    note: '既定。日本語の精度が実用水準で、Metal/GPUなら十分速い',
  },
};

/** 既定モデル（技術検証の実測で決定。FINDINGS.md 参照） */
export const defaultWhisperModel: WhisperModelId = 'large-v3-turbo';

/** 設定の画面で選べる順（小さい順）。medium は large-v3-turbo に劣るので出さない */
export const selectableWhisperModels: WhisperModelId[] = ['small', 'large-v3-turbo-q5_0', 'large-v3-turbo', 'base', 'tiny']

export function isWhisperModelId(value: unknown): value is WhisperModelId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(whisperModels, value)
}

/** ダウンロードしたモデルの置き場所（userData/models）。プロジェクトを汚さない */
export function whisperModelDir(userDataDir: string): string {
  return join(userDataDir, 'models')
}

export function downloadedWhisperModelPath(userDataDir: string, id: WhisperModelId): string {
  return join(whisperModelDir(userDataDir), whisperModels[id].file)
}
