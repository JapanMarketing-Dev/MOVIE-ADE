import { useEffect, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { Save } from 'lucide-react'
import type { SettingsFileError } from '@shared/types'
import { classifyDiskChange } from '@shared/diskChange'
import { SETTINGS_SCHEMA } from '@shared/settingsSchema'
import { monaco } from '../editor/monacoSetup'
import { applyEditorTheme, useAppTheme } from '../editor/editorTheme'
import { Button, useToast } from '../ui'
import { useT } from '../lib/i18n'
import { errorMessage } from '../lib/errors'

type CodeEditor = Parameters<OnMount>[0]

/** このエディタのモデルの URI。スキーマはこの URI にだけ当てる */
const MODEL_URI = 'inmemory://ferret/settings.json'

monaco.json.jsonDefaults.setDiagnosticsOptions({
  validate: true,
  allowComments: false,
  enableSchemaRequest: false,
  // "$schema": "./settings.schema.json" をここでは取りに行かない（スキーマは同梱のものを当てる）
  schemaRequest: 'ignore',
  schemas: [{ uri: SETTINGS_SCHEMA.$id ?? 'settings.schema.json', fileMatch: [MODEL_URI], schema: SETTINGS_SCHEMA as unknown as Record<string, unknown> }]
})

/**
 * settings.json を内蔵の Monaco で開く（設定のページの中）。
 * スキーマで補完と検証をし、保存は main が確かめてから一時ファイル＋rename で書く（壊れていれば書かない）。
 * ディスク側の変更（Claude Code などの書き換え）は、編集していなければ取り込み、編集中なら帯で知らせる。
 * monaco-editor を含むので、設定のページからは React.lazy で遅れて読む。
 */
export default function SettingsJsonEditor({ path }: { path: string }) {
  const t = useT()
  const toast = useToast()
  const theme = useAppTheme()
  const [themeName, setThemeName] = useState(() => applyEditorTheme(monaco, theme))
  const [text, setText] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [diskChanged, setDiskChanged] = useState(false)
  const [error, setError] = useState<SettingsFileError | null>(null)
  const editorRef = useRef<CodeEditor | null>(null)
  /*
   * 変更ありの基準（最後に読んだ／保存した文）。state の text ではなく ref で持つ。
   * 読み直しの model.setValue は同じ流れの中で onChange を呼ぶので、state の text と比べると
   * 古い文と比べて「変更あり」と取り違え、次の知らせで警告していた（自分の保存なのに警告が出た原因）。
   */
  const baselineRef = useRef('')

  useEffect(() => setThemeName(applyEditorTheme(monaco, theme)), [theme])

  /** ディスクの文をエディタへ入れる。基準を先に揃えてから入れる（onChange が新しい基準と比べるように） */
  const apply = (next: string) => {
    baselineRef.current = next
    setText(next)
    setDirty(false)
    setDiskChanged(false)
    const model = editorRef.current?.getModel()
    if (model && model.getValue() !== next) model.setValue(next)
  }

  const load = () => window.ade.invoke('settingsFile:read').then(apply)
    .catch((err: unknown) => toast({ tone: 'danger', message: errorMessage(err) }))

  useEffect(() => {
    void load()
    /*
     * 外部の変更と、自分の Save（settingsFile:write の取り込み）の両方で届く。中身で見分ける。
     * main は別の操作のあと settings.json を整形し直して書くので（キーの並び・2スペース）、
     * JSON として同じものは同じとみなす（src/shared/diskChange.ts）。
     */
    return window.ade.on('settings:changed', () => {
      void window.ade.invoke('settingsFile:read').then((disk) => {
        const current = editorRef.current?.getValue() ?? baselineRef.current
        const action = classifyDiskChange({ disk, baseline: baselineRef.current, current, json: true })
        if (action === 'conflict') setDiskChanged(true)
        else if (action === 'keep') baselineRef.current = disk
        else if (action === 'ignore') {
          baselineRef.current = disk
          setText(disk)
          setDirty(false)
          setDiskChanged(false)
        } else apply(disk)
      }).catch(() => setDiskChanged(true)) // 読めなければ念のため知らせる（上書きはしない）
    })
  }, [])

  const save = async () => {
    const value = editorRef.current?.getValue() ?? text ?? ''
    // 保存の途中に届く知らせ（main は取り込んだその場で送る）も自分の保存と分かるよう、先に基準を進める
    const previous = baselineRef.current
    baselineRef.current = value
    const result = await window.ade.invoke('settingsFile:write', value).catch((err: unknown) => {
      toast({ tone: 'danger', message: errorMessage(err) })
      return undefined
    })
    if (result !== null) baselineRef.current = previous
    if (result === undefined) return
    setError(result)
    if (result) {
      if (result.line) editorRef.current?.revealLineInCenter(result.line)
      return
    }
    setText(value)
    setDirty(false)
    setDiskChanged(false)
    toast({ tone: 'success', message: t('settings.file.saved') })
  }
  const saveRef = useRef(save)
  saveRef.current = save

  const onMount: OnMount = (editor) => {
    editorRef.current = editor
    // ⌘S / Ctrl+S でこのエディタを保存する（アプリのファイル保存とは別）
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current())
  }

  return <div className="st-json" data-testid="settings-json-editor">
    <div className="st-json__bar">
      <code className="st-json__path" title={path}>{path}</code>
      <Button icon={<Save size={14} strokeWidth={1.5} />} disabled={!dirty} onClick={() => void save()} data-testid="settings-json-save">{t('settings.file.save')}</Button>
    </div>
    {diskChanged && <p className="st-note st-note--warn">{t('settings.file.diskChanged')} <Button variant="ghost" onClick={() => void load()}>{t('settings.file.reload')}</Button></p>}
    {error && <p className="st-note st-note--warn" role="alert" data-testid="settings-json-error">{t('settings.file.errorAt', { line: String(error.line ?? '?'), message: error.message })}</p>}
    <div className="st-json__editor">
      {text !== null && <Editor path={MODEL_URI} defaultLanguage="json" defaultValue={text} theme={themeName} onMount={onMount}
        onChange={(value) => setDirty((value ?? '') !== baselineRef.current)}
        options={{ minimap: { enabled: false }, fontSize: 12, tabSize: 2, scrollBeyondLastLine: false, automaticLayout: true, wordWrap: 'on', editContext: false /* IME の候補窓のため（FileEditor.tsx と同じ） */ }} />}
    </div>
  </div>
}
