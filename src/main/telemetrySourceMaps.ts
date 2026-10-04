import { SourceMap } from 'node:module'
import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * dev 起動のスタックを、Sentry へ送る前に元のファイルと行へ戻す（配布版は CLI で上げたソースマップを Sentry が使う）。
 *
 * - main / preload … out/ の JS の隣にある .map（electron.vite.config.ts の hidden）を読む
 * - renderer … Vite の dev サーバーが返すモジュールの末尾の inline のソースマップを読む
 *
 * 戻したフレームは `app:///src/...` の形にし、元のファイルの前後の行（context）も付ける。
 * 読めないフレームはそのまま残す（送ること自体は止めない）。
 */

type Frame = {
  filename?: string
  abs_path?: string
  lineno?: number
  colno?: number
  pre_context?: string[]
  context_line?: string
  post_context?: string[]
  in_app?: boolean
}

interface LoadedMap {
  map: SourceMap
  /** sources[i] をリポジトリからの相対パスにしたもの */
  sources: string[]
  contents: Array<string | null>
}

const CONTEXT_LINES = 5

interface RemapOptions {
  /** リポジトリの直下（dev では app.getAppPath()） */
  appPath: string
  /** Vite の dev サーバー（ELECTRON_RENDERER_URL）。無ければ renderer は戻さない */
  rendererUrl?: string
  /** renderer のモジュールの取得。テストで差し替える */
  fetchText?: (url: string) => Promise<string>
}

/** out/ の .map は dev の再ビルドで変わるので、更新時刻で読み直す */
const fileCache = new Map<string, { mtimeMs: number; loaded: LoadedMap | null }>()
const urlCache = new Map<string, Promise<LoadedMap | null>>()

function toRepoPath(appPath: string, source: string, baseDir: string): string {
  const cleaned = source.replace(/^webpack:\/\/|^file:\/\//, '').replace(/[?#].*$/, '')
  const abs = isAbsolute(cleaned) ? cleaned : resolve(baseDir, cleaned)
  const rel = relative(appPath, abs).split(sep).join('/')
  if (!rel.startsWith('..')) return rel
  // アプリの場所の外（別の出力先から起動したときなど）は、src/ から先だけを残す
  const unix = abs.split(sep).join('/')
  const at = unix.lastIndexOf('/src/')
  return at >= 0 ? unix.slice(at + 1) : unix
}

function load(payload: string, appPath: string, baseDir: string): LoadedMap | null {
  try {
    const raw = JSON.parse(payload) as { sources?: string[]; sourcesContent?: Array<string | null>; sourceRoot?: string }
    const root = raw.sourceRoot ? resolve(baseDir, raw.sourceRoot) : baseDir
    return {
      map: new SourceMap(raw as ConstructorParameters<typeof SourceMap>[0]),
      sources: (raw.sources ?? []).map((s) => toRepoPath(appPath, s, root)),
      contents: raw.sourcesContent ?? []
    }
  } catch {
    return null
  }
}

function loadFileMap(jsPath: string, appPath: string): LoadedMap | null {
  const mapPath = `${jsPath}.map`
  try {
    const { mtimeMs } = statSync(mapPath)
    const hit = fileCache.get(mapPath)
    if (hit && hit.mtimeMs === mtimeMs) return hit.loaded
    const loaded = load(readFileSync(mapPath, 'utf8'), appPath, dirname(mapPath))
    fileCache.set(mapPath, { mtimeMs, loaded })
    return loaded
  } catch {
    return null
  }
}

const INLINE_MAP = /\/\/# sourceMappingURL=data:application\/json(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=]+)\s*$/

function loadUrlMap(url: string, opts: RemapOptions): Promise<LoadedMap | null> {
  const key = url.replace(/[?#].*$/, '')
  let hit = urlCache.get(key)
  if (!hit) {
    const fetchText = opts.fetchText ?? (async (u: string) => (await fetch(u)).text())
    hit = fetchText(url).then((text) => {
      const m = INLINE_MAP.exec(text)
      // Vite の sources はモジュールのフォルダからの相対。URL のパスは src/renderer（Vite の root）から、
      // root の外（@shared など）は /@fs/<絶対パス>
      const path = decodeURIComponent(new URL(url).pathname)
      const file = path.startsWith('/@fs/') ? path.slice(4) : join(opts.appPath, 'src', 'renderer', path)
      return m ? load(Buffer.from(m[1]!, 'base64').toString('utf8'), opts.appPath, dirname(file)) : null
    }).catch(() => null)
    urlCache.set(key, hit)
    // dev の HMR でモジュールが変わるので、長くは覚えない
    setTimeout(() => urlCache.delete(key), 30_000).unref?.()
  }
  return hit
}

function apply(frame: Frame, loaded: LoadedMap): void {
  if (!frame.lineno) return
  const entry = loaded.map.findEntry(frame.lineno - 1, Math.max(0, (frame.colno ?? 1) - 1)) as {
    originalSource?: string
    originalLine?: number
    originalColumn?: number
  }
  if (entry.originalLine === undefined || !entry.originalSource) return
  // findEntry の originalSource は解決済みの URL になることがあるので、末尾が一致する sources を探す
  const tail = entry.originalSource.replace(/^file:\/\//, '').replace(/[?#].*$/, '')
  let index = loaded.sources.findIndex((s) => tail === s || tail.endsWith(`/${s}`))
  if (index < 0) index = loaded.sources.findIndex((s) => s.endsWith(tail.split('/').pop() ?? '\0'))
  const path = index >= 0 ? loaded.sources[index]! : tail
  frame.filename = `app:///${path.replace(/^\/+/, '')}`
  frame.abs_path = frame.filename
  frame.lineno = entry.originalLine + 1
  frame.colno = (entry.originalColumn ?? 0) + 1
  frame.in_app = !path.includes('node_modules')
  const content = index >= 0 ? loaded.contents[index] : null
  if (content) {
    const lines = content.split('\n')
    const i = entry.originalLine
    frame.pre_context = lines.slice(Math.max(0, i - CONTEXT_LINES), i)
    frame.context_line = lines[i] ?? ''
    frame.post_context = lines.slice(i + 1, i + 1 + CONTEXT_LINES)
  }
}

/** イベントの例外のフレームを元のファイルと行へ戻す（その場で書き換える） */
export async function remapDevFrames(event: { exception?: { values?: Array<{ stacktrace?: { frames?: Frame[] } }> } }, opts: RemapOptions): Promise<void> {
  const rendererOrigin = opts.rendererUrl ? new URL(opts.rendererUrl).origin : null
  for (const value of event.exception?.values ?? []) {
    for (const frame of value.stacktrace?.frames ?? []) {
      const name = frame.filename ?? ''
      if (rendererOrigin && name.startsWith(rendererOrigin)) {
        // Vite の root の外（@shared など）は /@fs/<絶対パス>。先に SDK がアプリの場所を app:/// に縮めていると
        // 「/@fsapp:///src/...」になるので、取りに行く前に元の URL に戻す
        const url = name.replace('/@fsapp:///', `/@fs${opts.appPath.split(sep).join('/').replace(/\/$/, '')}/`)
        const loaded = await loadUrlMap(url, opts)
        if (loaded) apply(frame, loaded)
        continue
      }
      // main / preload は normalizePaths でアプリの場所からの app:///out/... になっている
      const m = /^app:\/\/\/(.+\.js)$/.exec(name)
      const jsPath = m ? join(opts.appPath, m[1]!) : isAbsolute(name) && name.endsWith('.js') ? name : null
      if (!jsPath) continue
      const loaded = loadFileMap(jsPath, opts.appPath)
      if (loaded) apply(frame, loaded)
    }
  }
}

/** 配布版の JS の末尾の `//# debugId=…`（sentry sourcemap upload が書き込む）。ファイルごとに1度だけ読む */
const debugIdCache = new Map<string, string | null>()
const DEBUG_ID = /\/\/# debugId=([0-9a-fA-F-]{36})\s*$/

function debugIdOf(file: string): string | null {
  if (debugIdCache.has(file)) return debugIdCache.get(file)!
  let id: string | null = null
  try {
    const text = readFileSync(file, 'utf8')
    id = DEBUG_ID.exec(text.slice(-200))?.[1] ?? null
  } catch {
    // 読めないファイル（asar の外・消えた）は付けない（想定内）
  }
  debugIdCache.set(file, id)
  return id
}

type DebugMetaEvent = {
  exception?: { values?: Array<{ stacktrace?: { frames?: Frame[] } }> }
  debug_meta?: { images?: Array<Record<string, unknown>> }
}

/**
 * 配布版：スタックの `app:///…js` のファイルに debug ID を付ける（event.debug_meta.images）。
 * main と renderer は SDK が自分で付けるが、preload の例外（preload-error を main で受けたもの）などは付かないので、
 * ここで補い、上げたソースマップで元の TS の行に戻せるようにする。付いているものは触らない
 */
export function attachDebugIds(event: DebugMetaEvent, appPath: string): void {
  const images = event.debug_meta?.images ?? []
  const known = new Set(images.map((i) => String(i.code_file ?? '')))
  const added: Array<Record<string, unknown>> = []
  for (const value of event.exception?.values ?? []) {
    for (const frame of value.stacktrace?.frames ?? []) {
      const name = frame.abs_path ?? frame.filename ?? ''
      const m = /^app:\/\/\/(.+\.js)$/.exec(name)
      if (!m || known.has(name)) continue
      known.add(name)
      const id = debugIdOf(join(appPath, m[1]!))
      if (id) added.push({ type: 'sourcemap', code_file: name, debug_id: id })
    }
  }
  if (added.length) event.debug_meta = { ...event.debug_meta, images: [...images, ...added] }
}
