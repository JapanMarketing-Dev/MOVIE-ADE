/// <reference types="vite/client" />
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker'

/**
 * Monaco を同梱の版で動かす準備（CDN からは読まない。オフラインでも動く）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/lib/monaco-setup.ts（MIT）
 *   - worker は Vite の ?worker で同梱し、言語ごとに振り分ける
 *   - TypeScript の型検査は切る（プロジェクトの import を解決できず、偽の赤線だらけになる）
 *   - loader.config({ monaco }) で @monaco-editor/react に同梱の monaco を使わせる
 * monaco-editor 0.57 は package.json の exports が `./*` → `./esm/vs/*.js` なので、
 * worker の指定は Orca（0.55）の `monaco-editor/esm/vs/...` ではなく `monaco-editor/...` にする。
 */

globalThis.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json':
        return new jsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker()
      case 'typescript':
      case 'javascript':
        return new tsWorker()
      default:
        return new editorWorker()
    }
  }
}

const diagnosticsOptions = {
  noSemanticValidation: true,
  noSuggestionDiagnostics: true,
  noSyntaxValidation: false
}
monaco.typescript.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions)
monaco.typescript.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions)
// .tsx / .jsx も同じ言語 ID なので、JSX を許さないと全タグに TS17004 が出る
monaco.typescript.typescriptDefaults.setCompilerOptions({
  ...monaco.typescript.typescriptDefaults.getCompilerOptions(),
  jsx: monaco.typescript.JsxEmit.Preserve
})
monaco.typescript.javascriptDefaults.setCompilerOptions({
  ...monaco.typescript.javascriptDefaults.getCompilerOptions(),
  jsx: monaco.typescript.JsxEmit.Preserve
})

loader.config({ monaco })

export { monaco }
