import type { DroppedEntry } from '@shared/externalDrop'

/**
 * 外（Finder・デスクトップ・エクスプローラー）からのファイル・フォルダのドロップ。
 * タブ・ペイン・パネルの並べ替えのドラッグ（独自のデータの種類だけを運ぶ）と区別するため、
 * DataTransfer に 'Files' があるときだけ外からのドロップとして扱う。
 */
export function hasExternalFiles(dataTransfer: DataTransfer | null | undefined): boolean {
  return !!dataTransfer && Array.from(dataTransfer.types ?? []).includes('Files')
}

/** 落とされたものの実パスを main で確かめて返す（無いもの・読めないものは入らない） */
export async function readDrop(dataTransfer: DataTransfer): Promise<DroppedEntry[]> {
  const files = Array.from(dataTransfer.files ?? [])
  if (files.length === 0 || typeof window.ade.inspectDrop !== 'function') return []
  return window.ade.inspectDrop(files)
}

/** 名前だけ（トーストの文言に使う） */
export function droppedName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** エディタの領域へ落としたものの振り分け（App.tsx）。どれを開き、何を案内するか */
export interface EditorDropPlan {
  /** プロジェクトの中のファイル（相対パス）。エディタ・ビューアで開く */
  open: string[]
  /** プロジェクトとして追加して開くフォルダ（いちばん初めの1つ） */
  folder: string | null
  /** プロジェクトの外のファイル（ツリーへの取り込みを案内する。最初の1つの名前） */
  outside: string | null
  /** 読み取れたものが1つも無い */
  unreadable: boolean
}

export function planEditorDrop(entries: readonly DroppedEntry[]): EditorDropPlan {
  const open = entries.flatMap((entry) => (entry.kind === 'file' && entry.relPath ? [entry.relPath] : []))
  const outsideFile = entries.find((entry) => entry.kind === 'file' && !entry.relPath)
  const folder = open.length === 0 ? entries.find((entry) => entry.kind === 'dir')?.path ?? null : null
  return { open, folder, outside: outsideFile ? droppedName(outsideFile.path) : null, unreadable: entries.length === 0 }
}
