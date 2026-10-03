/**
 * electron-builder の設定（MOVIE-ADE。当面は署名・公証しない）。
 *
 * 3つのOSの配布物（ファイル名は download-site と合意した MOVIE-ADE-<version>-<os>-<arch>.<ext>）：
 *   macOS   … dmg（arm64・x64）
 *   Windows … nsis（x64・arm64。1つのインストーラに両方入らないよう、CPU ごとに別々に走らせる）
 *   Linux   … AppImage / deb（x64。Linux の上でだけ作れる）
 * `pnpm build:<os>:dev` は --dir で展開済みのアプリだけを作る（速い確認用）。
 * `pnpm dist:<os>` が上の配布物を作る。配布は Cloudflare R2（scripts/release-r2.mjs）で、GitHub には添付しない。
 *
 * Orca由来: ~/bench/orca/config/electron-builder.config.cjs（MIT, Copyright 2026 Lovecast Inc.）
 *   mac / nsis / linux / deb の各項目の選び方と、deb の依存パッケージの一覧
 *
 * YAML ではなく JS にしているのは electronDist を関数にするため。
 * 手元の node_modules/electron/dist は「この Mac 用」なので、同じ OS・同じ CPU のときだけ使い、
 * それ以外（Windows / Linux / 別の CPU）は electron-builder に正しい Electron を取ってこさせる。
 *
 * userData は製品名ではなく ade-movie に固定している（src/main/index.ts）。製品名を変えても既存のデータは残る。
 */
const { chmodSync, existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

const localElectronDist = join(__dirname, 'node_modules', 'electron', 'dist')

/** electron-builder の Arch の番号（ia32=0, x64=1, armv7l=2, arm64=3, universal=4） */
const ARCH_NAME = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

// deb の depends を書くと electron-builder の既定が置き換わるので、Electron が必要とするものを並べる（Orca と同じ一覧）
const debElectronRuntimeDependencies = [
  'libgtk-3-0',
  'libnotify4',
  'libnss3',
  'libxss1',
  'libxtst6',
  'xdg-utils',
  'libatspi2.0-0',
  'libuuid1',
  'libsecret-1-0'
]

function listDirs(dir) {
  return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(dir, d.name)) : []
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.japanmarketing.movieade',
  productName: 'MOVIE-ADE',
  // 各ターゲットの既定。OS と CPU の語はダウンロードサイトがファイル名から判別する
  artifactName: 'MOVIE-ADE-${version}-${os}-${arch}.${ext}',
  electronDist: (options) => {
    const sameHost = options.platformName === process.platform && options.arch === process.arch
    return sameHost && existsSync(localElectronDist) ? localElectronDist : null
  },
  directories: {
    output: 'dist/release',
    buildResources: 'build'
  },
  files: [
    'out/**/*',
    'package.json',
    'node_modules/**/*',
    '!**/*.map',
    '!**/.env*',
    '!**/e2e-artifacts/**',
    // @sentry/node が依存に持つビルド用の道具（vite / rollup などのプラグイン用）。実行時は読まない（@sentry/node の
    // 本体は bundler-plugin を import せず、サブパスの ./vite などからだけ読む）。Sentry CLI（FSL ライセンス・15MB）と
    // ネイティブ付きの oxc-parser を配布物に入れない
    '!**/node_modules/@sentry/bundler-plugins/**',
    '!**/node_modules/sentry/**',
    '!**/node_modules/oxc-parser/**',
    '!**/node_modules/@oxc-parser/**'
  ],
  // node-pty はネイティブモジュールと補助の実行ファイル（spawn-helper、Windows の conpty.dll / OpenConsole.exe）を
  // asar の外に置かないと起動できない
  asarUnpack: ['node_modules/node-pty/**/*'],
  /*
   * node-pty 1.1 は N-API なので Electron 向けに作り直さなくても読める。
   * macOS / Windows は同梱の prebuilds/<os>-<cpu> があり、読み込み側（node-pty の loadNativeModule）が
   * build/Release で失敗するとそちらへ切り替える。ここで作り直すと、別 OS 向けのときに失敗するので切っておく。
   * Linux は prebuilds が無いので、Linux 上の `pnpm install` で作ったもの（build/Release）を使う（beforePack で確かめる）。
   */
  npmRebuild: false,
  beforePack: async (context) => {
    const target = context.electronPlatformName
    if (target === 'linux' && process.platform !== 'linux') {
      throw new Error(
        'Linux 版は Linux の上で作ってください。node-pty の Linux 用バイナリは同梱されておらず、' +
          'この OS の build/Release を詰めると起動できません（CI の ubuntu で作ります）。'
      )
    }
    const arch = ARCH_NAME[context.arch]
    const prebuilt = join(__dirname, 'node_modules', 'node-pty', 'prebuilds', `${target}-${arch}`)
    if (target !== 'linux' && !existsSync(prebuilt)) {
      throw new Error(`node-pty の ${target}-${arch} 用バイナリが見つかりません: ${prebuilt}`)
    }
  },
  /*
   * node-pty の spawn-helper（macOS が PTY を開くのに使う）は、prebuilds の中で実行権限が揃っていない。
   * インストール時の post-install はこの CPU（darwin-arm64）の分しか直さないので、darwin-x64 版は
   * 実行できず、Intel Mac で「posix_spawnp failed」になる（この Mac で x64 版を Rosetta で動かして確かめた）。
   * Orca由来: ~/bench/orca/config/electron-builder.config.cjs の afterPack（実行権限を揃える処理）（MIT）
   */
  afterPack: async (context) => {
    if (context.electronPlatformName === 'win32') return
    const resources =
      context.electronPlatformName === 'darwin'
        ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
        : join(context.appOutDir, 'resources')
    const ptyDir = join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty')
    for (const dir of [join(ptyDir, 'build', 'Release'), ...listDirs(join(ptyDir, 'prebuilds'))]) {
      const helper = join(dir, 'spawn-helper')
      if (existsSync(helper)) chmodSync(helper, 0o755)
    }
  },
  mac: {
    icon: 'build/icon.icns',
    identity: null,
    hardenedRuntime: false,
    notarize: false,
    category: 'public.app-category.developer-tools',
    extendInfo: {
      NSMicrophoneUsageDescription: 'MOVIE-ADE records your voice during a review and saves it with the findings on screen.'
    },
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }]
  },
  dmg: {
    artifactName: 'MOVIE-ADE-${version}-mac-${arch}.${ext}',
    title: '${productName} ${version}'
  },
  win: {
    icon: 'build/icon.ico',
    executableName: 'MOVIE-ADE',
    // この Mac で作った node-pty の build/Release は Windows では読めない。prebuilds/win32-<cpu> だけを使わせる
    files: ['!node_modules/node-pty/build/**'],
    // ウインドウのアイコン（src/main/index.ts の windowIcon。exe のアイコンとは別にタイトルバー用）
    extraResources: [{ from: 'build/icons/256x256.png', to: 'icon.png' }],
    // 署名しない（アイコンと版の埋め込みだけ行う）。
    // arch を2つ書くと両方入りの1本になるので、既定は x64 にし、arm64 は `--arm64` で別に走らせる（package.json の dist:win）
    target: [{ target: 'nsis', arch: ['x64'] }]
  },
  // Mac で作るとき、makensis（wine 経由で uninstaller を作る）は長いパスの下で失敗する（-1 で落ちる）。
  // 浅いフォルダ（このリポジトリの dist/release など）で作る
  nsis: {
    artifactName: 'MOVIE-ADE-${version}-win-${arch}.${ext}',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: '${productName}',
    uninstallDisplayName: '${productName}',
    createDesktopShortcut: 'always'
  },
  linux: {
    // フォルダの NxN.png を hicolor の各サイズに配る（scripts/build-icon.mjs が書き出す）
    icon: 'build/icons',
    // 製品名の空白と括弧はコマンド名・パッケージ名に使えない
    executableName: 'movie-ade',
    // .desktop のファイル名・StartupWMClass を package.json の desktopName（movie-ade.desktop）に揃える。
    // Electron はこれをウインドウの app_id / WM_CLASS に使うので、ドックでランチャーと同じアイコンにまとまる
    syncDesktopName: true,
    // ウインドウのアイコン（src/main/index.ts の windowIcon）
    extraResources: [{ from: 'build/icons/512x512.png', to: 'icon.png' }],
    category: 'Development',
    maintainer: 'JapanMarketing-Dev',
    synopsis: 'Give UI feedback to coding agents by talking and circling',
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] }
    ]
  },
  appImage: {
    // x64 は x86_64 になる
    artifactName: 'MOVIE-ADE-${version}-linux-${arch}.${ext}'
  },
  deb: {
    packageName: 'movie-ade',
    // x64 は amd64 になる
    artifactName: 'MOVIE-ADE-${version}-linux-${arch}.${ext}',
    depends: debElectronRuntimeDependencies
  },
  // 配布は R2 に scripts/release-r2.mjs で上げる。electron-builder からは公開しない（latest*.yml も作らない）
  publish: null
}
