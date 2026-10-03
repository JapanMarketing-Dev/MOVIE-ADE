import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FsChangedEvent } from '@shared/files'
import { previewUrl } from '@shared/preview'
import { errorMessage } from '../lib/errors'
import { t } from '@shared/i18n'
import { CLOSE_REQUEST_EVENT } from '../components/TerminalPane'
import { detectLanguage } from './language'

/**
 * 開いているファイル（中央のタブ）の状態。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/editor/editor-content-dirty-state.ts と
 * use-terminal-editor-close-*.ts（MIT）の考え方
 *   - 変更ありは「ディスクで最後に見た内容」と「編集中の内容」の差で決める
 *   - 変更ありのまま閉じるときは「保存 / 保存しない / キャンセル」を聞く
 *   - 外部の変更は、未保存の変更が無ければ取り込み、あれば上書きせずに知らせる
 * store・自動保存・ウィンドウを閉じるときの確認は持ち込まない。
 *
 * 編集中の内容は Monaco のモデルが正本で、ここでは drafts（ref）に写しだけを持つ。
 * 打鍵のたびに React の再描画を起こさないため、state に置くのは dirty の真偽だけにする。
 */
export interface OpenFile {
  /** タブの識別子。プロジェクトの根＋相対パス（別のプロジェクトの同名ファイルと区別する） */
  id: string
  root: string
  /** プロジェクトからの相対パス */
  path: string
  name: string
  language: string
  status: 'loading' | 'ready' | 'unavailable'
  /** ディスクで最後に見た内容 */
  saved: string
  dirty: boolean
  /** 開けない理由（バイナリ・大きすぎる・読めない） */
  message?: string
  /** 未保存の変更があるうちに、ディスク側が変わった／消えた */
  external?: 'changed' | 'deleted'
  /** markdown / Mermaid のプレビューを横に並べている */
  preview: boolean
  /** ディスクの内容でバッファを差し替えた回数。エディタはこれを見てモデルを入れ替える */
  revision: number
}

export type FileTabId = `file:${string}`

export function fileTabId(id: string): FileTabId {
  return `file:${id}`
}

function fileId(root: string, path: string): string {
  return `${root.replace(/[\\/]+$/, '')}/${path}`
}

/*
 * 閉じたファイルの Monaco のモデルを捨てる口。monaco-editor は遅れて読むので、ここでは import せず、
 * FileEditor が読み込まれたときに登録する（まだ読まれていなければモデルも無い）。
 * 捨てないと、閉じてすぐ開き直したときに古い内容と undo が残る。
 */
let modelDisposer: ((id: string) => void) | null = null
export function registerModelDisposer(dispose: (id: string) => void): void {
  modelDisposer = dispose
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export interface OpenFilesApi {
  /** 今のプロジェクトのファイルだけ（別のプロジェクトのタブは戻ってきたときに出す） */
  files: OpenFile[]
  activeFile: OpenFile | null
  open: (path: string) => void
  /** 変更ありなら確認を出す */
  requestClose: (id: string) => void
  save: (id: string) => Promise<boolean>
  /** Monaco の内容が変わった */
  setDraft: (id: string, value: string) => void
  getDraft: (id: string) => string | undefined
  togglePreview: (id: string) => void
  /** プレビューを内蔵ブラウザで開く（そのまま録画でレビューできる） */
  openPreviewInBrowser: (id: string) => void
  /** 外部の変更を取り込む（自分の変更は捨てる） */
  reloadFromDisk: (id: string) => void
  /** 外部の変更の知らせを閉じ、自分の変更を残す */
  keepMine: (id: string) => void
  /** 閉じる確認の対象。null なら出していない */
  pendingClose: OpenFile | null
  resolveClose: (choice: 'save' | 'discard' | 'cancel') => void
  /** 変更ありのファイルの相対パス（エクスプローラの M の印） */
  dirtyPaths: ReadonlySet<string>
}

export function useOpenFiles({
  root,
  activeTab,
  setActiveTab,
  onError
}: {
  root: string | null
  /** 中央のタブの選択（CenterTab）。file: で始まればファイル */
  activeTab: string
  setActiveTab: (tab: 'browser' | FileTabId) => void
  onError: (message: string) => void
}): OpenFilesApi {
  const [allFiles, setAllFiles] = useState<OpenFile[]>([])
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null)
  const drafts = useRef(new Map<string, string>())
  const filesRef = useRef(allFiles)
  filesRef.current = allFiles

  const patch = useCallback((id: string, update: Partial<OpenFile> | ((file: OpenFile) => Partial<OpenFile>)) => {
    setAllFiles((files) => files.map((f) => (f.id === id ? { ...f, ...(typeof update === 'function' ? update(f) : update) } : f)))
  }, [])

  const files = useMemo(() => allFiles.filter((f) => f.root === root), [allFiles, root])
  const activeFile = activeTab.startsWith('file:') ? (files.find((f) => fileTabId(f.id) === activeTab) ?? null) : null

  const load = useCallback(async (id: string, path: string) => {
    try {
      const result = await window.ade.invoke('fs:read', path)
      if (result.kind === 'text') {
        drafts.current.set(id, result.content)
        patch(id, (f) => ({ status: 'ready', saved: result.content, dirty: false, message: undefined, external: undefined, revision: f.revision + 1 }))
      } else {
        patch(id, { status: 'unavailable', message: result.reason })
      }
    } catch (err) {
      patch(id, { status: 'unavailable', message: errorMessage(err) })
    }
  }, [patch])

  const open = useCallback((path: string) => {
    if (!root) return
    const id = fileId(root, path)
    if (!filesRef.current.some((f) => f.id === id)) {
      const file: OpenFile = {
        id, root, path, name: baseName(path), language: detectLanguage(path),
        status: 'loading', saved: '', dirty: false, preview: false, revision: 0
      }
      setAllFiles((list) => [...list, file])
      void load(id, path)
    }
    setActiveTab(fileTabId(id))
  }, [root, load, setActiveTab])

  const remove = useCallback((id: string) => {
    const list = filesRef.current
    const index = list.findIndex((f) => f.id === id)
    if (index === -1) return
    drafts.current.delete(id)
    modelDisposer?.(id)
    setAllFiles((files) => files.filter((f) => f.id !== id))
    // 閉じたのが選択中なら、隣のファイル（無ければブラウザ）へ移る
    if (activeTab === fileTabId(id)) {
      const siblings = list.filter((f) => f.root === list[index]!.root && f.id !== id)
      const next = siblings[Math.min(index, siblings.length - 1)] ?? siblings.at(-1)
      setActiveTab(next ? fileTabId(next.id) : 'browser')
    }
  }, [activeTab, setActiveTab])

  const save = useCallback(async (id: string): Promise<boolean> => {
    const file = filesRef.current.find((f) => f.id === id)
    if (!file || file.status !== 'ready' || file.root !== root) return false
    const content = drafts.current.get(id) ?? file.saved
    try {
      await window.ade.invoke('fs:write', file.path, content)
      // 保存中に打った分は変更ありのまま残す
      patch(id, { saved: content, dirty: (drafts.current.get(id) ?? content) !== content, external: undefined })
      return true
    } catch (err) {
      onError(t('editor.saveFailed', { error: errorMessage(err) }))
      return false
    }
  }, [root, patch, onError])

  const setDraft = useCallback((id: string, value: string) => {
    drafts.current.set(id, value)
    const file = filesRef.current.find((f) => f.id === id)
    if (!file) return
    const dirty = value !== file.saved
    if (dirty !== file.dirty) patch(id, { dirty })
  }, [patch])

  const getDraft = useCallback((id: string) => drafts.current.get(id), [])

  const requestClose = useCallback((id: string) => {
    const file = filesRef.current.find((f) => f.id === id)
    if (!file) return
    if (file.dirty) {
      setActiveTab(fileTabId(id))
      setPendingCloseId(id)
    } else {
      remove(id)
    }
  }, [remove, setActiveTab])

  const resolveClose = useCallback((choice: 'save' | 'discard' | 'cancel') => {
    const id = pendingCloseId
    setPendingCloseId(null)
    if (!id || choice === 'cancel') return
    if (choice === 'discard') { remove(id); return }
    // 保存に失敗したら閉じない（内容を失わない）
    void save(id).then((ok) => { if (ok) remove(id) })
  }, [pendingCloseId, remove, save])

  const togglePreview = useCallback((id: string) => patch(id, (f) => ({ preview: !f.preview })), [patch])
  const reloadFromDisk = useCallback((id: string) => {
    const file = filesRef.current.find((f) => f.id === id)
    if (file) void load(id, file.path)
  }, [load])
  const keepMine = useCallback((id: string) => patch(id, { external: undefined }), [patch])
  const openPreviewInBrowser = useCallback((id: string) => {
    const file = filesRef.current.find((f) => f.id === id)
    if (!file) return
    setActiveTab('browser')
    void window.ade.invoke('browser:navigate', previewUrl(file.path)).catch((err) => onError(errorMessage(err)))
  }, [setActiveTab, onError])

  /*
   * 外部の変更（Agent の書き換えなど）。
   * 未保存の変更が無ければ黙って取り込み、あれば上書きせずに知らせる。
   * 自分の保存でも通知は来るが、中身が saved と同じなので何もしない。
   */
  useEffect(() => {
    return window.ade.on('fs:changed', (event: FsChangedEvent) => {
      const changed = new Set(event.paths)
      for (const file of filesRef.current) {
        if (file.root !== root || file.status === 'loading' || !changed.has(file.path)) continue
        void window.ade.invoke('fs:read', file.path).then(
          (result) => {
            const current = filesRef.current.find((f) => f.id === file.id)
            if (!current || result.kind !== 'text' || result.content === current.saved) {
              if (current?.external === 'deleted' && result.kind === 'text') patch(file.id, { external: undefined })
              return
            }
            if (current.dirty) {
              patch(file.id, { external: 'changed' })
            } else {
              drafts.current.set(file.id, result.content)
              patch(file.id, (f) => ({ status: 'ready', saved: result.content, message: undefined, external: undefined, revision: f.revision + 1 }))
            }
          },
          // 読めなくなった＝消えた・名前が変わった。内容は残し、保存すれば作り直せる
          () => patch(file.id, { external: 'deleted' })
        )
      }
    })
  }, [root, patch])

  /*
   * ⌘W。メニューはターミナルを閉じる指示を出すが、TerminalPane はターミナルにフォーカスが無いとき
   * 先に 'ade:close-request' を投げる（terminal-agent との取り決め）。エディタかファイルのタブに
   * フォーカスがあれば、それを止めてファイルのタブを閉じる（変更ありなら確認を出す）。
   */
  const activeId = activeFile?.id ?? null
  useEffect(() => {
    if (!activeId) return
    const onCloseRequest = (event: Event) => {
      if (!document.activeElement?.closest('.editor-area, .ctab--file')) return
      event.preventDefault()
      requestClose(activeId)
    }
    window.addEventListener(CLOSE_REQUEST_EVENT, onCloseRequest)
    return () => window.removeEventListener(CLOSE_REQUEST_EVENT, onCloseRequest)
  }, [activeId, requestClose])

  // ウィンドウを閉じるときの確認のため、未保存のファイルを main へ知らせる（別のプロジェクトのタブも含める）
  const unsavedKey = allFiles.filter((f) => f.dirty).map((f) => f.id).join('\n')
  useEffect(() => {
    void window.ade.invoke('editor:unsaved', unsavedKey ? unsavedKey.split('\n') : []).catch(() => undefined)
  }, [unsavedKey])

  // プロジェクトを切り替えて選択中のファイルが見えなくなったら、ブラウザへ戻す
  useEffect(() => {
    if (activeTab.startsWith('file:') && !files.some((f) => fileTabId(f.id) === activeTab)) setActiveTab('browser')
  }, [activeTab, files, setActiveTab])

  const dirtyPaths = useMemo(() => new Set(files.filter((f) => f.dirty).map((f) => f.path)), [files])
  const pendingClose = allFiles.find((f) => f.id === pendingCloseId) ?? null

  return {
    files, activeFile, open, requestClose, save, setDraft, getDraft, togglePreview, openPreviewInBrowser,
    reloadFromDisk, keepMine, pendingClose, resolveClose, dirtyPaths
  }
}
