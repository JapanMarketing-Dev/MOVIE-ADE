import { useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import { AlertTriangle, Columns2, Globe, Save } from 'lucide-react'
import { previewKind, previewUrl } from '@shared/preview'
import { monaco } from './monacoSetup'
import { applyEditorTheme, useAppTheme } from './editorTheme'
import { isMarkdownLanguage } from './language'
import { registerModelDisposer, type OpenFilesApi, type OpenFile } from './useOpenFiles'
import { Button, EmptyState, Spinner } from '../ui'
import { useT } from '../lib/i18n'

/** モデルの URI。プロジェクトの根を含めて、別のプロジェクトの同名ファイルと分ける */
function modelPath(file: OpenFile): string {
  return monaco.Uri.file(file.id).toString()
}

registerModelDisposer((id) => monaco.editor.getModel(monaco.Uri.file(id))?.dispose())

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

  useEffect(() => setThemeName(applyEditorTheme(monaco, theme)), [theme])

  // ディスクの内容で差し替えた（外部の変更の取り込み・再読込）。undo で戻れるよう編集として入れる
  useEffect(() => {
    const model = monaco.editor.getModel(monaco.Uri.parse(modelPath(file)))
    const next = api.getDraft(file.id) ?? file.saved
    if (!model || model.getValue() === next) return
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: next }], () => null)
  }, [file.id, file.revision])

  // 保存されたら、横のプレビューに中身だけ差し替えさせる（スクロール位置を保つ。page.js が受ける）
  useEffect(() => {
    if (!file.preview) return
    return window.ade.on('fs:changed', (event) => {
      if (event.paths.includes(file.path)) frameRef.current?.contentWindow?.postMessage('ade-preview:refresh', '*')
    })
  }, [file.preview, file.path])

  const markdown = isMarkdownLanguage(file.language)
  const previewable = previewKind(file.path) !== null && file.status === 'ready'
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
        {previewable && (
          <>
            <Button
              variant="ghost"
              icon={<Columns2 size={13} />}
              aria-pressed={file.preview}
              onClick={() => api.togglePreview(file.id)}
              data-testid="editor-preview-toggle"
            >
              {file.preview ? t('editor.closePreview') : t('editor.previewToSide')}
            </Button>
            <Button variant="ghost" icon={<Globe size={13} />} title={t('editor.openPreviewTitle')} onClick={() => api.openPreviewInBrowser(file.id)} data-testid="editor-preview-browser">
              {t('editor.openPreview')}
            </Button>
          </>
        )}
        {file.status === 'ready' && (
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

      <div className={`editor-body${previewable && file.preview ? ' editor-body--split' : ''}`}>
        {file.status === 'loading' ? (
          <div className="editor-body__center"><Spinner size={18} /></div>
        ) : file.status === 'unavailable' ? (
          <EmptyState size="sm" title={t('editor.cannotOpen')} description={file.message ?? ''} testId="editor-unavailable" />
        ) : (
          <>
            <Editor
              path={modelPath(file)}
              defaultValue={api.getDraft(file.id) ?? file.saved}
              defaultLanguage={file.language}
              language={file.language}
              theme={themeName}
              loading={<Spinner size={18} />}
              onChange={(value) => api.setDraft(file.id, value ?? '')}
              options={{
                automaticLayout: true,
                fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || undefined,
                fontSize: 13,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                renderWhitespace: 'selection',
                tabSize: 2,
                wordWrap: markdown ? 'on' : 'off',
                contextmenu: true
              }}
            />
            {previewable && file.preview && (
              // 保存した内容を出す（未保存の編集は、保存すると反映される）
              <iframe ref={frameRef} key={file.id} className="editor-preview" title={t('editor.previewFrameTitle', { name: file.name })} src={previewUrl(file.path)} data-testid="editor-preview" />
            )}
          </>
        )}
      </div>
    </div>
  )
}
