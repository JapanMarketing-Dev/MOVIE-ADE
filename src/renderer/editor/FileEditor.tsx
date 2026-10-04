import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { AlertTriangle, Columns2, ExternalLink, FileCode, FolderOpen, Globe, Save } from 'lucide-react'
import { previewKind, previewUrl } from '@shared/preview'
import { isRiskyToOpenExternally, isSvgPath } from '@shared/fileViewer'
import FileViewer from './FileViewer'
import { monaco } from './monacoSetup'
import { applyEditorTheme, useAppTheme } from './editorTheme'
import { isMarkdownLanguage } from './language'
import { registerModelDisposer, type OpenFilesApi, type OpenFile } from './useOpenFiles'
import { Button, EmptyState, Spinner } from '../ui'
import { useT } from '../lib/i18n'
import { reportHandled } from '@shared/report'

type CodeEditor = Parameters<OnMount>[0]

/** 打鍵が止まってから横のプレビューを描き直すまでの待ち（数百ミリ秒で追従させる） */
const LIVE_PREVIEW_DELAY_MS = 150

/** モデルの URI。プロジェクトの根を含めて、別のプロジェクトの同名ファイルと分ける */
function modelPath(file: OpenFile): string {
  return monaco.Uri.file(file.id).toString()
}

registerModelDisposer((id) => monaco.editor.getModel(monaco.Uri.file(id))?.dispose())

/** プレビューで編集（tiptap を含むので、開いたときだけ読む） */
const RichMarkdownEditor = lazy(() => import('./richMarkdown/RichMarkdownEditor'))
/** プレビューで編集しているファイル（タブを切り替えても残す） */
const richFiles = new Set<string>()

/**
 * 開いたファイルを Monaco で編集する（中央のファイルタブの中身）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/editor/EditorPanel.tsx・EditorPanelHeader.tsx（MIT）
 *   - エディタは1つだけ置き、タブを切り替えるとモデルを差し替える（undo とスクロール位置がタブごとに残る）
 *   - 見出しにパスと、markdown / Mermaid ならプレビュー
 *   - 外部の変更で未保存の内容と食い違ったら、上書きせずに帯で知らせる
 * プレビューは renderer の DOM ではなく ade-preview://（main が描くページ）で、
 * 「横に並べる」は iframe、「内蔵ブラウザで開く」は録画でレビューできる内蔵ブラウザに出す。
 * monaco-editor を含むので、App からは React.lazy で遅れて読む（起動時間 NF-5 を守る）。
 */
export default function FileEditor({ file, editor: api }: { file: OpenFile; editor: OpenFilesApi }) {
  const t = useT()
  const theme = useAppTheme()
  const [themeName, setThemeName] = useState(() => applyEditorTheme(monaco, theme))
  const frameRef = useRef<HTMLIFrameElement>(null)
  const editorRef = useRef<CodeEditor | null>(null)
  const liveTimer = useRef<number | undefined>(undefined)
  const [, setRichVersion] = useState(0)

  useEffect(() => setThemeName(applyEditorTheme(monaco, theme)), [theme])

  // ディスクの内容で差し替えた（外部の変更の取り込み・再読込）。undo で戻れるよう編集として入れる
  useEffect(() => {
    const model = monaco.editor.getModel(monaco.Uri.parse(modelPath(file)))
    const next = api.getDraft(file.id) ?? file.saved
    if (!model || model.getValue() === next) return
    // 全体を置き換えるとカーソルと選択が末尾へ飛ぶ。置き換えの前の位置・スクロールを戻す
    // （行が減っていれば Monaco が範囲の中に丸める。Orca #13756）
    const editor = editorRef.current?.getModel() === model ? editorRef.current : null
    const view = editor?.saveViewState() ?? null
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: next }], () => null)
    if (editor && view) editor.restoreViewState(view)
  }, [file.id, file.revision])

  /*
   * 横に並べたプレビューを打鍵に追従させる。編集中の内容を main で HTML にし（ファイルは読まない）、
   * iframe の page.js に中身だけ差し替えさせる（スクロール位置を保つ）。
   */
  const sendLivePreview = (delay: number) => {
    window.clearTimeout(liveTimer.current)
    liveTimer.current = window.setTimeout(() => {
      const source = api.getDraft(file.id) ?? file.saved
      void window.ade.invoke('preview:render', file.path, source).then((html) => {
        frameRef.current?.contentWindow?.postMessage({ type: 'ade-preview:html', html }, '*')
      }).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
    }, delay)
  }
  useEffect(() => () => window.clearTimeout(liveTimer.current), [])

  // 外部で書き換えられたら（未保存の編集が無いときだけ）ファイルを取り直させる
  useEffect(() => {
    if (!file.preview || file.dirty) return
    return window.ade.on('fs:changed', (event) => {
      if (event.paths.includes(file.path)) frameRef.current?.contentWindow?.postMessage('ade-preview:refresh', '*')
    })
  }, [file.preview, file.path, file.dirty])

  // プレビューでダブルクリックした塊の元の行へ移る（「この箇所を編集」）
  useEffect(() => {
    if (!file.preview) return
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; line?: unknown; kind?: unknown; name?: unknown } | null
      // プレビューの図（mermaid）の描画の失敗。書き間違いは page.js が除いてある。中身は含まない
      if (event.source === frameRef.current?.contentWindow && data?.type === 'ade-preview:render-error') {
        const failure = new Error(`${String(data.kind)} render failed: ${String(data.name)}`)
        reportHandled(failure, { area: 'editor', op: 'render mermaid' })
        return
      }
      if (event.source !== frameRef.current?.contentWindow || data?.type !== 'ade-preview:reveal' || typeof data.line !== 'number') return
      const editor = editorRef.current
      if (!editor) return
      editor.revealLineInCenter(data.line)
      editor.setPosition({ lineNumber: data.line, column: 1 })
      editor.focus()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [file.preview])

  const markdown = isMarkdownLanguage(file.language)
  // Markdown は「ソース」と「プレビューで編集」を切り替えられる。内容はどちらも同じ drafts を通す
  // （MDX は JSX を含むので、ソースだけで編集する）
  const richable = file.language === 'markdown' && file.status === 'ready' && !file.viewer
  const rich = richable && richFiles.has(file.id)
  const setRich = (on: boolean) => {
    if (on) richFiles.add(file.id)
    else richFiles.delete(file.id)
    setRichVersion((v) => v + 1)
  }
  const previewable = previewKind(file.path) !== null && file.status === 'ready' && !file.viewer
  const segments = file.path.split('/')

  return (
    <div className="editor-area" data-testid="file-editor">
      <header className="editor-head">
        <span className="editor-head__path" title={file.path}>
          {segments.map((segment, index) => (
            <span key={index} className={index === segments.length - 1 ? 'editor-head__name' : 'editor-head__dir'}>
              {segment}
            </span>
          ))}
        </span>
        {file.dirty && <span className="editor-head__dirty" title={t('editor.dirtyTitle')}>{t('editor.dirty')}</span>}
        <span className="editor-head__spacer" />
        {richable && (
          <span className="editor-head__modes" role="group" aria-label={t('editor.viewMode')}>
            <Button variant="ghost" selected={!rich} onClick={() => setRich(false)} data-testid="editor-mode-source">
              {t('editor.viewSource')}
            </Button>
            <Button variant="ghost" selected={rich} title={t('editor.viewRichTitle')} onClick={() => setRich(true)} data-testid="editor-mode-rich">
              {t('editor.viewRich')}
            </Button>
          </span>
        )}
        {previewable && (
          <>
            {!rich && <Button
              variant="ghost"
              icon={<Columns2 size={13} />}
              aria-pressed={file.preview}
              onClick={() => api.togglePreview(file.id)}
              data-testid="editor-preview-toggle"
            >
              {file.preview ? t('editor.closePreview') : t('editor.previewToSide')}
            </Button>}
            <Button variant="ghost" icon={<Globe size={13} />} title={t('editor.openPreviewTitle')} onClick={() => api.openPreviewInBrowser(file.id)} data-testid="editor-preview-browser">
              {t('editor.openPreview')}
            </Button>
          </>
        )}
        {file.viewer && file.status === 'ready' && (
          <>
            {file.viewer === 'image' && isSvgPath(file.path) && (
              <Button variant="ghost" icon={<FileCode size={13} />} onClick={() => api.openAsText(file.id)} data-testid="viewer-open-as-text">
                {t('viewer.openAsText')}
              </Button>
            )}
            <Button variant="ghost" icon={<FolderOpen size={13} />} onClick={() => api.reveal(file.id)} data-testid="viewer-reveal">
              {t('viewer.showInFolder')}
            </Button>
            {!isRiskyToOpenExternally(file.path) && (
              <Button variant="ghost" icon={<ExternalLink size={13} />} onClick={() => api.openExternally(file.id)} data-testid="viewer-open-external">
                {t('viewer.openExternal')}
              </Button>
            )}
          </>
        )}
        {file.status === 'ready' && !file.viewer && (
          <Button variant="ghost" icon={<Save size={13} />} disabled={!file.dirty && !file.external} onClick={() => void api.save(file.id)} data-testid="editor-save">
            {t('common.save')}
          </Button>
        )}
      </header>

      {file.external && (
        <div className="editor-banner" role="alert" data-testid="editor-external-change">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>
            {file.external === 'deleted'
              ? t('editor.deletedOnDisk')
              : t('editor.changedOnDisk')}
          </span>
          <span className="editor-head__spacer" />
          {file.external === 'changed' && (
            <Button variant="ghost" onClick={() => api.reloadFromDisk(file.id)}>
              {t('editor.reloadFromDisk')}
            </Button>
          )}
          <Button variant="ghost" onClick={() => api.keepMine(file.id)}>
            {t('editor.keepMine')}
          </Button>
        </div>
      )}

      <div className={`editor-body${previewable && file.preview && !rich ? ' editor-body--split' : ''}`}>
        {file.status === 'loading' ? (
          <div className="editor-body__center"><Spinner size={18} /></div>
        ) : file.status === 'unavailable' ? (
          <EmptyState size="sm" title={t('editor.cannotOpen')} description={file.message ?? ''} testId="editor-unavailable" />
        ) : file.viewer ? (
          <FileViewer path={file.path} name={file.name} viewer={file.viewer} info={file.info} message={file.message} revision={file.revision} />
        ) : rich ? (
          <Suspense fallback={<div className="editor-body__center"><Spinner size={18} /></div>}>
            <RichMarkdownEditor key={file.id} file={file} editor={api} />
          </Suspense>
        ) : (
          <>
            <Editor
              path={modelPath(file)}
              defaultValue={api.getDraft(file.id) ?? file.saved}
              defaultLanguage={file.language}
              language={file.language}
              theme={themeName}
              loading={<Spinner size={18} />}
              onMount={(editor) => {
                editorRef.current = editor
                // プレビューで編集した後に戻ってきたとき、モデルを編集中の内容に合わせる（undo で戻れるよう編集として入れる）
                const model = editor.getModel()
                const next = api.getDraft(file.id) ?? file.saved
                if (model && model.getValue() !== next) model.pushEditOperations([], [{ range: model.getFullModelRange(), text: next }], () => null)
              }}
              onChange={(value) => {
                api.setDraft(file.id, value ?? '')
                if (file.preview) sendLivePreview(LIVE_PREVIEW_DELAY_MS)
              }}
              options={{
                automaticLayout: true,
                fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || undefined,
                fontSize: 13,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                renderWhitespace: 'selection',
                tabSize: 2,
                wordWrap: markdown ? 'on' : 'off',
                contextmenu: true,
                // 日本語の全角の括弧や記号を「紛らわしい文字」として枠で囲まない
                unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false },
                // Monaco 0.57 の既定（EditContext）では、Windows の Microsoft Pinyin などが候補窓を出さない。
                // 入力を従来の textarea で受ける（Orca #23360、microsoft/vscode#259380）
                editContext: false
              }}
            />
            {previewable && file.preview && (
              // 開いた直後はファイルの内容。未保存の編集があれば、読み込み終わりに編集中の内容へ差し替える
              <iframe
                onLoad={() => { if (file.dirty) sendLivePreview(0) }}
                ref={frameRef} key={file.id} className="editor-preview" title={t('editor.previewFrameTitle', { name: file.name })} src={previewUrl(file.path)} data-testid="editor-preview" />
            )}
          </>
        )}
      </div>
    </div>
  )
}
