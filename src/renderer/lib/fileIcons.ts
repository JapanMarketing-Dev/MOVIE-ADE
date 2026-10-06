/**
 * ファイルツリーのアイコンと色（VS Code の Material Icon Theme などの考え: 決まった名前・拡張子で見分ける）。
 * 外部のアイコンテーマは足さず、lucide の形と色の組で表す。名前から決める純粋関数（components/FileIcon.tsx が描く）。
 */

/** 使う lucide のアイコン（FileIcon.tsx の表と対） */
export type FileIconName =
  | 'Folder' | 'FolderOpen' | 'FolderCode' | 'FolderCog' | 'FolderGit2' | 'FolderArchive' | 'FolderKey'
  | 'BookOpen' | 'Server' | 'FlaskConical' | 'Terminal' | 'Images' | 'Globe' | 'Component' | 'Bot' | 'Package' | 'Database'
  | 'Webhook' | 'Palette' | 'Languages' | 'Braces' | 'Wrench' | 'Boxes' | 'Workflow'
  | 'FileText' | 'FileCode' | 'FileJson' | 'FileCog' | 'FileTerminal' | 'FileImage' | 'FileVideo' | 'FileAudio' | 'FileArchive'
  | 'FileSpreadsheet' | 'FileKey' | 'FileLock' | 'FileBox' | 'Lock' | 'KeyRound' | 'GitBranch' | 'Container' | 'Scale' | 'ScrollText'

/** 色の名前（editor.css の --fi-* が両方の配色で読める濃さを決める） */
export type FileIconTone = 'blue' | 'sky' | 'cyan' | 'teal' | 'green' | 'yellow' | 'amber' | 'orange' | 'red' | 'pink' | 'purple' | 'slate'

export interface FileIconSpec {
  icon: FileIconName
  /** 無ければ行の文字の色のまま */
  tone?: FileIconTone
}

const spec = (icon: FileIconName, tone?: FileIconTone): FileIconSpec => (tone ? { icon, tone } : { icon })

/** フォルダの名前（小文字）→ アイコン */
const FOLDERS: ReadonlyMap<string, FileIconSpec> = new Map(Object.entries({
  src: spec('FolderCode', 'blue'), source: spec('FolderCode', 'blue'), lib: spec('FolderCode', 'blue'), libs: spec('FolderCode', 'blue'),
  app: spec('FolderCode', 'blue'), apps: spec('FolderCode', 'blue'), pkg: spec('FolderCode', 'blue'), internal: spec('FolderCode', 'blue'), cmd: spec('FolderCode', 'blue'),
  packages: spec('Boxes', 'amber'),
  docs: spec('BookOpen', 'sky'), doc: spec('BookOpen', 'sky'), documentation: spec('BookOpen', 'sky'), wiki: spec('BookOpen', 'sky'),
  infra: spec('Server', 'purple'), infrastructure: spec('Server', 'purple'), terraform: spec('Server', 'purple'), deploy: spec('Server', 'purple'),
  deployment: spec('Server', 'purple'), deployments: spec('Server', 'purple'), k8s: spec('Server', 'purple'), kubernetes: spec('Server', 'purple'), helm: spec('Server', 'purple'),
  server: spec('Server', 'teal'), backend: spec('Server', 'teal'),
  test: spec('FlaskConical', 'green'), tests: spec('FlaskConical', 'green'), __tests__: spec('FlaskConical', 'green'), spec: spec('FlaskConical', 'green'),
  specs: spec('FlaskConical', 'green'), e2e: spec('FlaskConical', 'green'), testing: spec('FlaskConical', 'green'), fixtures: spec('FlaskConical', 'green'),
  scripts: spec('Terminal', 'slate'), script: spec('Terminal', 'slate'), bin: spec('Terminal', 'slate'), tools: spec('Wrench', 'slate'),
  assets: spec('Images', 'amber'), images: spec('Images', 'amber'), img: spec('Images', 'amber'), icons: spec('Images', 'amber'), media: spec('Images', 'amber'),
  public: spec('Globe', 'teal'), static: spec('Globe', 'teal'),
  components: spec('Component', 'cyan'), ui: spec('Component', 'cyan'), widgets: spec('Component', 'cyan'),
  '.github': spec('FolderGit2', 'slate'), '.gitlab': spec('FolderGit2', 'orange'), '.git': spec('FolderGit2', 'orange'), '.husky': spec('FolderGit2', 'slate'),
  '.vscode': spec('FolderCog', 'blue'), '.idea': spec('FolderCog', 'blue'), '.devcontainer': spec('FolderCog', 'blue'),
  '.claude': spec('Bot', 'orange'), '.codex': spec('Bot', 'slate'), '.cursor': spec('Bot', 'slate'), '.agents': spec('Bot', 'orange'), '.ferret': spec('Bot', 'teal'),
  node_modules: spec('Package', 'green'), vendor: spec('Package', 'slate'), '.pnpm-store': spec('Package', 'slate'),
  db: spec('Database', 'amber'), database: spec('Database', 'amber'), migrations: spec('Database', 'amber'), prisma: spec('Database', 'teal'), sql: spec('Database', 'amber'),
  web: spec('Globe', 'blue'), frontend: spec('Globe', 'blue'), client: spec('Globe', 'blue'), site: spec('Globe', 'blue'), www: spec('Globe', 'blue'),
  api: spec('Webhook', 'purple'), routes: spec('Webhook', 'purple'), handlers: spec('Webhook', 'purple'), services: spec('Webhook', 'purple'),
  config: spec('FolderCog', 'slate'), configs: spec('FolderCog', 'slate'), conf: spec('FolderCog', 'slate'), settings: spec('FolderCog', 'slate'), '.config': spec('FolderCog', 'slate'),
  dist: spec('FolderArchive', 'slate'), build: spec('FolderArchive', 'slate'), out: spec('FolderArchive', 'slate'), target: spec('FolderArchive', 'slate'),
  release: spec('FolderArchive', 'slate'), coverage: spec('FolderArchive', 'slate'), '.next': spec('FolderArchive', 'slate'), '.nuxt': spec('FolderArchive', 'slate'),
  styles: spec('Palette', 'pink'), css: spec('Palette', 'pink'), theme: spec('Palette', 'pink'),
  i18n: spec('Languages', 'sky'), locales: spec('Languages', 'sky'), locale: spec('Languages', 'sky'), lang: spec('Languages', 'sky'), translations: spec('Languages', 'sky'),
  types: spec('Braces', 'blue'), typings: spec('Braces', 'blue'), '@types': spec('Braces', 'blue'),
  utils: spec('Wrench', 'slate'), helpers: spec('Wrench', 'slate'),
  workflows: spec('Workflow', 'slate'), hooks: spec('Workflow', 'cyan'),
  secrets: spec('FolderKey', 'yellow'), certs: spec('FolderKey', 'yellow')
}))

/** ファイルの名前（小文字）そのもの → アイコン */
const FILES: ReadonlyMap<string, FileIconSpec> = new Map(Object.entries({
  'package.json': spec('Package', 'green'),
  'claude.md': spec('Bot', 'orange'), 'agents.md': spec('Bot', 'orange'), 'gemini.md': spec('Bot', 'blue'), '.cursorrules': spec('Bot', 'slate'),
  '.gitignore': spec('GitBranch', 'orange'), '.gitattributes': spec('GitBranch', 'orange'), '.gitmodules': spec('GitBranch', 'orange'), '.gitkeep': spec('GitBranch', 'orange'),
  'dockerfile': spec('Container', 'blue'), '.dockerignore': spec('Container', 'blue'),
  'docker-compose.yml': spec('Container', 'blue'), 'docker-compose.yaml': spec('Container', 'blue'), 'compose.yml': spec('Container', 'blue'), 'compose.yaml': spec('Container', 'blue'),
  'tsconfig.json': spec('FileCog', 'blue'), 'jsconfig.json': spec('FileCog', 'yellow'),
  'license': spec('Scale', 'amber'), 'licence': spec('Scale', 'amber'), 'copying': spec('Scale', 'amber'),
  'changelog.md': spec('ScrollText', 'sky'),
  'makefile': spec('FileTerminal', 'orange'), 'justfile': spec('FileTerminal', 'orange'),
  '.editorconfig': spec('FileCog', 'slate'), '.npmrc': spec('FileCog', 'red'), '.nvmrc': spec('FileCog', 'green'), '.node-version': spec('FileCog', 'green'),
  'pnpm-lock.yaml': spec('Lock', 'slate'), 'package-lock.json': spec('Lock', 'slate'), 'yarn.lock': spec('Lock', 'slate'), 'bun.lockb': spec('Lock', 'slate'),
  'bun.lock': spec('Lock', 'slate'), 'cargo.lock': spec('Lock', 'slate'), 'poetry.lock': spec('Lock', 'slate'), 'gemfile.lock': spec('Lock', 'slate'),
  'composer.lock': spec('Lock', 'slate'), 'go.sum': spec('Lock', 'slate'), 'uv.lock': spec('Lock', 'slate'), 'flake.lock': spec('Lock', 'slate'),
  'go.mod': spec('FileCog', 'cyan'), 'cargo.toml': spec('FileCog', 'orange'), 'pyproject.toml': spec('FileCog', 'sky'), 'requirements.txt': spec('FileCog', 'sky')
}))

/** 拡張子（小文字・点なし）→ アイコン */
const EXTENSIONS: ReadonlyMap<string, FileIconSpec> = new Map(Object.entries({
  ts: spec('FileCode', 'blue'), mts: spec('FileCode', 'blue'), cts: spec('FileCode', 'blue'), tsx: spec('FileCode', 'cyan'),
  js: spec('FileCode', 'yellow'), mjs: spec('FileCode', 'yellow'), cjs: spec('FileCode', 'yellow'), jsx: spec('FileCode', 'cyan'),
  py: spec('FileCode', 'sky'), ipynb: spec('FileCode', 'orange'), go: spec('FileCode', 'cyan'), rs: spec('FileCode', 'orange'),
  java: spec('FileCode', 'red'), kt: spec('FileCode', 'purple'), swift: spec('FileCode', 'orange'), rb: spec('FileCode', 'red'), php: spec('FileCode', 'purple'),
  c: spec('FileCode', 'blue'), h: spec('FileCode', 'purple'), cpp: spec('FileCode', 'blue'), hpp: spec('FileCode', 'purple'), cs: spec('FileCode', 'purple'),
  vue: spec('FileCode', 'green'), svelte: spec('FileCode', 'orange'), astro: spec('FileCode', 'orange'), dart: spec('FileCode', 'sky'), lua: spec('FileCode', 'blue'),
  html: spec('FileCode', 'orange'), htm: spec('FileCode', 'orange'), xml: spec('FileCode', 'orange'), graphql: spec('FileCode', 'pink'), gql: spec('FileCode', 'pink'),
  proto: spec('FileCode', 'slate'),
  json: spec('FileJson', 'yellow'), jsonc: spec('FileJson', 'yellow'), json5: spec('FileJson', 'yellow'), jsonl: spec('FileJson', 'yellow'),
  yaml: spec('FileCog', 'purple'), yml: spec('FileCog', 'purple'), toml: spec('FileCog', 'slate'), ini: spec('FileCog', 'slate'), conf: spec('FileCog', 'slate'),
  md: spec('FileText', 'sky'), mdx: spec('FileText', 'sky'), markdown: spec('FileText', 'sky'), txt: spec('FileText'), rst: spec('FileText', 'sky'),
  pdf: spec('FileText', 'red'), log: spec('ScrollText', 'slate'),
  docx: spec('FileText', 'blue'), docm: spec('FileText', 'blue'), doc: spec('FileText', 'blue'), gdoc: spec('FileText', 'blue'),
  pptx: spec('FileText', 'orange'), pptm: spec('FileText', 'orange'), ppt: spec('FileText', 'orange'), ppsx: spec('FileText', 'orange'), gslides: spec('FileText', 'amber'),
  xlsm: spec('FileSpreadsheet', 'green'), gsheet: spec('FileSpreadsheet', 'green'),
  css: spec('Palette', 'purple'), scss: spec('Palette', 'pink'), sass: spec('Palette', 'pink'), less: spec('Palette', 'pink'),
  sql: spec('Database', 'amber'), prisma: spec('Database', 'teal'), sqlite: spec('Database', 'amber'), db: spec('Database', 'amber'),
  sh: spec('FileTerminal', 'green'), bash: spec('FileTerminal', 'green'), zsh: spec('FileTerminal', 'green'), fish: spec('FileTerminal', 'green'),
  ps1: spec('FileTerminal', 'blue'), bat: spec('FileTerminal', 'slate'), cmd: spec('FileTerminal', 'slate'),
  csv: spec('FileSpreadsheet', 'green'), tsv: spec('FileSpreadsheet', 'green'), xlsx: spec('FileSpreadsheet', 'green'), xls: spec('FileSpreadsheet', 'green'),
  png: spec('FileImage', 'teal'), jpg: spec('FileImage', 'teal'), jpeg: spec('FileImage', 'teal'), gif: spec('FileImage', 'teal'), webp: spec('FileImage', 'teal'),
  avif: spec('FileImage', 'teal'), bmp: spec('FileImage', 'teal'), ico: spec('FileImage', 'teal'), icns: spec('FileImage', 'teal'), heic: spec('FileImage', 'teal'),
  svg: spec('FileImage', 'amber'),
  mp4: spec('FileVideo', 'pink'), mov: spec('FileVideo', 'pink'), webm: spec('FileVideo', 'pink'), mkv: spec('FileVideo', 'pink'), avi: spec('FileVideo', 'pink'),
  mp3: spec('FileAudio', 'pink'), wav: spec('FileAudio', 'pink'), m4a: spec('FileAudio', 'pink'), ogg: spec('FileAudio', 'pink'), flac: spec('FileAudio', 'pink'),
  zip: spec('FileArchive', 'amber'), tar: spec('FileArchive', 'amber'), gz: spec('FileArchive', 'amber'), tgz: spec('FileArchive', 'amber'), '7z': spec('FileArchive', 'amber'), rar: spec('FileArchive', 'amber'),
  pem: spec('FileKey', 'yellow'), key: spec('FileKey', 'yellow'), crt: spec('FileKey', 'yellow'), p12: spec('FileKey', 'yellow'), pub: spec('FileKey', 'yellow'),
  lock: spec('Lock', 'slate'), lockb: spec('Lock', 'slate'),
  wasm: spec('FileBox', 'purple'), dockerfile: spec('Container', 'blue')
}))

const DEFAULT_FILE = spec('FileText')

/** フォルダのアイコン。決まった名前でなければ、開いた・閉じたフォルダ（色なし） */
export function folderIconFor(name: string, open: boolean): FileIconSpec {
  return FOLDERS.get(name.toLowerCase()) ?? spec(open ? 'FolderOpen' : 'Folder')
}

/** ファイルのアイコン。名前そのもの → 名前の形（README・.env・テスト・設定）→ 拡張子 の順に見る */
export function fileIconFor(name: string): FileIconSpec {
  const lower = name.toLowerCase()
  const exact = FILES.get(lower)
  if (exact) return exact
  if (/^readme(\.|$)/.test(lower)) return spec('BookOpen', 'sky')
  if (/^licen[sc]e(\.|$)/.test(lower)) return spec('Scale', 'amber')
  if (/^\.env(\.|$)/.test(lower)) return spec('KeyRound', 'yellow')
  if (/^dockerfile\./.test(lower) || /^docker-compose\..+\.ya?ml$/.test(lower)) return spec('Container', 'blue')
  if (/^tsconfig\..+\.json$/.test(lower)) return spec('FileCog', 'blue')
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(lower) || /^test_.+\.py$|_test\.(py|go)$/.test(lower)) return spec('FlaskConical', 'green')
  if (/\.d\.[cm]?ts$/.test(lower)) return spec('Braces', 'blue')
  // vite.config.ts・eslint.config.mjs・.prettierrc・.eslintrc.json など
  if (/\.config\.[cm]?[jt]s$/.test(lower) || /^\.(prettier|eslint|stylelint|babel|swc|lintstaged)rc/.test(lower)) return spec('FileCog', 'slate')
  const dot = lower.lastIndexOf('.')
  if (dot <= 0 || dot === lower.length - 1) return DEFAULT_FILE
  return EXTENSIONS.get(lower.slice(dot + 1)) ?? DEFAULT_FILE
}
