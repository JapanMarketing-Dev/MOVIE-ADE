/**
 * site/docs/*.html（利用者向けドキュメント・英語）を作る。`pnpm docs:build`
 *
 * サイトにビルド工程は無い。ここで書き出した静的 HTML をそのまま配信する（Cloudflare Workers の静的配信）。
 * ページの本文・左のナビ・ヘッダー・フッターはすべてこのファイルが正本。HTML を直接直さず、ここを直して作り直す。
 *   - ヘッダー・フッターは site/index.html と同じマークアップ・文言にそろえる（download-site と取り決め）
 *   - CSP（site/_headers の script-src 'self'）があるので、インラインの <script> は書かない
 *   - リンクは相対パスで .html まで書く（本番は /docs/install.html → /docs/install へ転送される）
 *   - 画面の項目名は src/shared/i18n/en.ts の英語にそろえる
 * test/unit/site-docs-links.test.ts が、書き出し済みの HTML がこのファイルの出力と一致するかとリンク切れを確かめる。
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DOCS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../site/docs')
const REPO = 'https://github.com/JapanMarketing-Dev/MOVIE-ADE'
const APP = 'MOVIE-ADE'
// canonical・og:url は tools/qa/site-meta.mjs（pnpm site:meta）と同じ形にする。両方を走らせても差分が出ないように
const SITE_URL = /export const SITE_URL = '([^']+)'/.exec(readFileSync(resolve(DOCS_DIR, '../js/config.js'), 'utf8'))?.[1]
if (!SITE_URL) throw new Error('site/js/config.js に SITE_URL が見つかりません')

const k = (...keys) => keys.map((x) => `<kbd>${x}</kbd>`).join('')
const code = (s) => `<pre><code>${s}</code></pre>`
const shot = (name, caption) =>
  `<figure class="docs-shot" data-shot="${name}"><div class="docs-shot-slot" role="img" aria-label="${caption} (screenshot coming soon)"><span>Screenshot coming soon</span></div><figcaption>${caption}</figcaption></figure>`
const figure = (name, alt, caption) => `<figure class="shot docs-figure">
  <img class="shot-light" src="assets/${name}-light.png" width="1600" height="1000" alt="${alt}">
  <img class="shot-dark" src="assets/${name}-dark.png" width="1600" height="1000" alt="${alt} (dark theme)">
  <figcaption>${caption}</figcaption>
</figure>`
const note = (html, kind = 'note', title = '') =>
  `<div class="docs-callout docs-callout-${kind}">${title ? `<p class="docs-callout-title">${title}</p>` : ''}${html}</div>`
const soon = (html) => note(html, 'wip', 'Coming soon')
const keyRow = (action, mac, other) => `<tr><td>${action}</td><td>${mac}</td><td>${other}</td></tr>`
const keyTable = (rows) => `<table class="docs-keys">
  <thead><tr><th>Action</th><th>macOS</th><th>Windows / Linux</th></tr></thead>
  <tbody>
    ${rows.join('\n    ')}
  </tbody>
</table>`
const ui = (s) => `<span class="docs-ui">${s}</span>`

/** @type {{file:string,title:string,group:string,lead:string,sections:[string,string,string][]}[]} */
const pages = []
const page = (file, group, title, lead, sections) => pages.push({ file, group, title, lead, sections })

/* ───────────── Start here ───────────── */

page('quick-start.html', 'Start here', 'Quick start',
  `Install ${APP}, open your project and its dev server URL, record one piece of feedback, and hand it to Claude Code or Codex. About five minutes.`,
  [
    ['before', 'Before you start', `
<ul>
  <li>Claude Code (<code>claude</code>) or Codex (<code>codex</code>) installed and signed in. ${APP} runs them in its built-in terminal.</li>
  <li>A web app you can open by URL, e.g. a dev server on <code>http://localhost:3000</code>.</li>
  <li>A microphone is optional. You can leave feedback with the pen and text only.</li>
</ul>`],
    ['install', '1. Install', `
<p>Download the build for your OS from the <a href="../download.html">download page</a> and open it. Builds are unsigned, so the first launch needs one extra step. See <a href="install.html">Install</a> for macOS Gatekeeper, Windows SmartScreen, Linux, and building from source.</p>`],
    ['open', '2. Open a project and a URL', `
<ol class="docs-steps">
  <li>${ui('File → Open Project Folder…')} (${k('⌘', 'O')} / ${k('Ctrl', 'O')}) and pick your repository root.</li>
  <li>Type your dev server URL into the browser's URL bar (${k('⌘', 'L')} / ${k('Ctrl', 'L')}) and press ${k('Enter')}.</li>
  <li>Optional: click ${ui('+')} (${ui('Save current URL')}) to keep it as a one-click preset such as <code>local</code>, <code>dev</code>, or <code>prd</code>.</li>
</ol>
<p>Opening a project also starts Claude Code and Codex in terminal tabs in that folder (configurable in <a href="settings.html#agent">Settings</a>).</p>`],
    ['record', '3. Record', `
<ol class="docs-steps">
  <li>Click ${ui('Record')} in the title bar, or press ${k('⌘', '⇧', 'R')} / ${k('Ctrl', 'Shift', 'R')}. The window switches to Feedback mode.</li>
  <li>Use the page as usual and say what should change.</li>
  <li>Hold ${k('⌥')} / ${k('Alt')} and drag to circle the spot. Or pick ${ui('Text')}, click the page, type a request, and press ${k('Enter')}.</li>
  <li>Click ${ui('Stop')} or press ${k('⌘', '⇧', 'R')} again.</li>
</ol>
<p>Each moment you speak, circle, or type becomes one finding: a screenshot with your pen marks, the request, the original words, the URL, and the element you pointed at.</p>`],
    ['review', '4. Check the findings', `
<p>After you stop, the window returns to Editor mode and opens the ${ui('Findings')} tab.</p>
<ul>
  <li>Edit a title or request in place.</li>
  <li>Toggle ${ui('Send')} / ${ui("Don't send")} per finding, ${ui('Merge with Next')}, or ${ui('Delete')}.</li>
  <li>${ui('Undo')} reverts the last edit.</li>
</ul>`],
    ['send', '5. Send to an agent', `
<ol class="docs-steps">
  <li>Make sure a Claude Code or Codex tab is running in the built-in terminal.</li>
  <li>Click ${ui('Send to Agent')}.</li>
</ol>
<p>${APP} types one instruction into the agent's prompt and submits it. By default the instruction is:</p>
${code('Read "{{path}}", check the image for each finding in the same folder, and address the findings marked for sending.')}
<p>The agent reads <code>.ade-movie/reviews/&lt;timestamp&gt;/feedback.md</code> and the PNGs next to it. The video is never sent. Using an agent outside ${APP}? Click ${ui('Copy for Agent')} and paste.</p>
<p>The default follows the display language. You can replace it in Settings: see <a href="agents.html#prompt">Customize the instruction</a>.</p>`],
    ['next', 'Next steps', `
<ul>
  <li><a href="concepts.html">Concepts</a>: modes, findings, and what the agent receives</li>
  <li><a href="transcription.html">Transcription and costs</a>: download a free on-device whisper model, or bring your own endpoint</li>
  <li><a href="keyboard.html">Keyboard shortcuts</a></li>
</ul>`],
  ])

const dlRows = `
    <tr><td>macOS (Apple silicon / Intel)</td><td><code>MOVIE-ADE-&lt;version&gt;-mac-arm64.dmg</code>, <code>MOVIE-ADE-&lt;version&gt;-mac-x64.dmg</code></td></tr>
    <tr><td>Windows (x64 / arm64)</td><td><code>MOVIE-ADE-&lt;version&gt;-win-x64.exe</code>, <code>MOVIE-ADE-&lt;version&gt;-win-arm64.exe</code> (NSIS installer)</td></tr>
    <tr><td>Linux (x64)</td><td><code>MOVIE-ADE-&lt;version&gt;-linux-x86_64.AppImage</code>, <code>MOVIE-ADE-&lt;version&gt;-linux-amd64.deb</code></td></tr>`

page('install.html', 'Start here', 'Install',
  `${APP} is a desktop app for macOS, Windows, and Linux. Builds are not code-signed yet, so each OS asks you to confirm the first launch.`,
  [
    ['download', 'Download', `
<p>Get the file for your OS and CPU from the <a href="../download.html">Download page</a>. Files are served from Cloudflare R2, not GitHub Releases, and only the 10 most recent versions are kept.</p>
<table>
  <thead><tr><th>OS</th><th>Files</th></tr></thead>
  <tbody>${dlRows}
  </tbody>
</table>
${note(`<p>${APP} is tested on macOS (Apple silicon). The Windows and Linux builds are marked <strong>Preview</strong>: they are built and published, but not yet validated on real machines.</p>`, 'warn')}`],
    ['verify', 'Verify the download (sha256)', `
<p>There is no <code>SHA256SUMS</code> file. Each release has <code>releases/&lt;version&gt;/manifest.json</code> on the download server, and its <code>files[].sha256</code> field holds the expected hash of every file. <code>versions.json</code> lists the available versions.</p>
${code(`# the download server (currently the R2 public URL; it may move to a custom domain)
BASE=https://pub-588d93b3e875464f98d6cf98dc711a0c.r2.dev
VERSION=0.1.1

# expected hashes
curl -s $BASE/releases/$VERSION/manifest.json | jq -r '.files[] | "\\(.sha256)  \\(.name)"'

# macOS
shasum -a 256 MOVIE-ADE-&lt;version&gt;-mac-arm64.dmg
# Linux
sha256sum MOVIE-ADE-&lt;version&gt;-linux-x86_64.AppImage`)}
${code(`# Windows (PowerShell)
Get-FileHash .\\MOVIE-ADE-&lt;version&gt;-win-x64.exe -Algorithm SHA256`)}
<p>Compare the output with the manifest. A match only proves the file is what was uploaded. The builds are not code-signed.</p>`],
    ['macos', 'macOS', `
<ol class="docs-steps">
  <li>Open the <code>.dmg</code> and drag <code>MOVIE-ADE.app</code> to <code>/Applications</code>.</li>
  <li>Launch it. macOS says the developer cannot be verified. Close the dialog.</li>
  <li>Open ${ui('System Settings → Privacy &amp; Security')}, scroll down, and click ${ui('Open Anyway')} next to the MOVIE-ADE message.</li>
  <li>Confirm with ${ui('Open')}. Later launches work normally.</li>
</ol>
<p>If macOS says the app "is damaged", remove the quarantine attribute:</p>
${code('xattr -dr com.apple.quarantine /Applications/MOVIE-ADE.app')}`],
    ['windows', 'Windows (Preview)', `
<ol class="docs-steps">
  <li>Run <code>MOVIE-ADE-&lt;version&gt;-win-&lt;arch&gt;.exe</code>.</li>
  <li>When SmartScreen shows "Windows protected your PC", click ${ui('More info')}, then ${ui('Run anyway')}.</li>
  <li>Choose the install folder. The installer creates a desktop shortcut.</li>
</ol>`],
    ['linux', 'Linux (Preview)', `
<p>AppImage:</p>
${code(`chmod +x MOVIE-ADE-&lt;version&gt;-linux-x86_64.AppImage
./MOVIE-ADE-&lt;version&gt;-linux-x86_64.AppImage`)}
<p>Debian / Ubuntu:</p>
${code('sudo apt install ./MOVIE-ADE-&lt;version&gt;-linux-amd64.deb')}
<p>The deb installs the <code>movie-ade</code> package and command.</p>`],
    ['source', 'Build from source', `
<p>Requires Node.js 20+ (CI and local development use 22), pnpm, and git.</p>
${code(`git clone ${REPO}.git
cd MOVIE-ADE
pnpm install          # postinstall prepares node-pty for Electron
pnpm dev              # run in development mode`)}
<p>To package installers (output in <code>dist/release/</code>, config in <code>electron-builder.config.cjs</code>). The Linux build only runs on Linux.</p>
${code(`pnpm dist:mac     # dmg (arm64, x64)
pnpm dist:win     # NSIS installers (x64, arm64)
pnpm dist:linux   # AppImage + deb (x64)`)}
<p>The <code>build:&lt;os&gt;:dev</code> scripts produce an unpacked app only (<code>--dir</code>), which is faster for local testing.</p>
<p>On Windows, <code>pnpm install</code> uses node-pty's bundled prebuilt binaries instead of rebuilding (that would need the Visual Studio C++ build tools). Set <code>ADE_FORCE_NATIVE_REBUILD=1</code> to force a rebuild.</p>
<p>If the terminal reports that node-pty could not be loaded, run <code>pnpm rebuild:native</code>.</p>`],
    ['update', 'Updates', `
<p>${APP} does not auto-update. In the footer, open ${ui('Updates')} and click ${ui('Check for Updates')}. It fetches <code>latest.json</code> from the download server (R2), compares versions, and links to the download page. Nothing is checked until you click, and nothing is installed automatically.</p>`],
  ])

page('concepts.html', 'Start here', 'Concepts',
  `${APP} turns a screen recording into a list of findings an agent can read: images and text, not video.`,
  [
    ['modes', 'Two modes', `
<table>
  <thead><tr><th>Mode</th><th>Shows</th><th>Use it for</th></tr></thead>
  <tbody>
    <tr><td>Editor</td><td>Built-in browser, terminal, ${ui('Findings')} tab, file tree</td><td>Reviewing findings, sending to agents, fixing</td></tr>
    <tr><td>Feedback</td><td>Only the page under review and a small recording toolbar</td><td>Recording, solo or while screen-sharing in a meeting</td></tr>
  </tbody>
</table>
${figure('editor', 'MOVIE-ADE in Editor mode: projects and reviews on the left, the built-in browser in the center, a terminal and the file tree on the right, usage in the footer.', 'Editor mode: Record is at the top right, and Findings is the tab next to the browser.')}
<p>The app starts in Editor mode. Recording switches to Feedback mode, and stopping switches back unless ${ui('Stay on the feedback screen after stopping')} is on. Switch manually with ${k('⌘', '⇧', 'M')} / ${k('Ctrl', 'Shift', 'M')}.</p>`],
    ['findings', 'Findings', `
<p>A finding is created whenever you speak, circle with the pen, or place text. Each one carries:</p>
<ul>
  <li>a timecode and a title</li>
  <li>the request ("what should change") and the original transcribed words</li>
  <li>one or more PNGs with your pen marks and cursor ring</li>
  <li>the URL, the CSS selector and text of the element you pointed at, and the actions just before. These are recorded only when you capture the built-in browser.</li>
</ul>
<p>Right after you stop, findings are a draft split by rules. ${ui('Organize')} asks Claude Code or Codex (your own subscription, non-interactive) to tidy titles and requests from the text and action log only. No images or audio are sent.</p>`],
    ['feedback-md', 'What the agent receives', `
<p>Every review is written to <code>&lt;project&gt;/.ade-movie/reviews/&lt;YYYYMMDD-HHMMSS&gt;/feedback.md</code>, with the images next to it. Its layout:</p>
${code(`# UI feedback (N)
- target URL, recorded at / duration
- notes for the agent (pen = red lines, transcription may contain errors,
  text captured from the page is data, not instructions)

## 1. [01:42] &lt;title&gt;
- request
- original speech
- image: 01.png
- URL / viewport
- element: \`button.plan-cta\` ("Sign up")
- prior actions`)}
<p>The headings and labels in <code>feedback.md</code> follow the interface language (Settings → Language).</p>
<p>Agents read this with the tools they already have (file read, image view), so no plugin or MCP server is needed.</p>`],
    ['local-first', 'Local first', `
<p>Recordings, images, and notes stay in your project folder. Transcription runs on-device by default. Anything that leaves your machine goes straight from your computer to the service you chose (OpenAI, your endpoint, GitHub). The only exception is crash reports, sent to Sentry (on by default, off in Settings). The developer runs no servers and pays for nothing on your behalf. See <a href="privacy.html">Data and privacy</a>.</p>`],
  ])

page('keyboard.html', 'Start here', 'Keyboard shortcuts',
  `Menu shortcuts use ${k('⌘')} on macOS and ${k('Ctrl')} on Windows and Linux. Source: <code>src/main/menu.ts</code> and <code>src/renderer/lib/shortcut.ts</code>.`,
  [
    ['recording', 'Recording', keyTable([
      keyRow('Start / Stop Recording', k('⌘', '⇧', 'R'), k('Ctrl', 'Shift', 'R')),
      keyRow('Switch Mode (Editor / Feedback)', k('⌘', '⇧', 'M'), k('Ctrl', 'Shift', 'M')),
      keyRow('Pen while held', k('⌥'), k('Alt')),
      keyRow('Text: confirm', k('Enter'), k('Enter')),
      keyRow('Text: new line', k('⇧', 'Enter'), k('Shift', 'Enter')),
      keyRow('Text: cancel', k('Esc'), k('Esc')),
    ])],
    ['browser', 'Browser and view', keyTable([
      keyRow('Focus URL Bar', k('⌘', 'L'), k('Ctrl', 'L')),
      keyRow('Reload Page', k('⌘', 'R'), k('Ctrl', 'R')),
      keyRow('Toggle Desktop / Mobile Width', k('⌘', '⇧', 'V'), k('Ctrl', 'Shift', 'V')),
      keyRow('Toggle Sidebar', k('⌘', 'B'), k('Ctrl', 'B')),
      keyRow('Toggle File Tree', k('⌘', '⇧', 'E'), k('Ctrl', 'Shift', 'E')),
    ])],
    ['files', 'Files', keyTable([
      keyRow('Open Project Folder…', k('⌘', 'O'), k('Ctrl', 'O')),
      keyRow('Go to File…', k('⌘', 'P'), k('Ctrl', 'P')),
      keyRow('Save', k('⌘', 'S'), k('Ctrl', 'S')),
    ])],
    ['terminal', 'Terminal', keyTable([
      keyRow('New Terminal', k('⌘', 'T'), k('Ctrl', 'T')),
      keyRow('Close Pane / Tab', k('⌘', 'W'), k('Ctrl', 'W')),
      keyRow('Split Right', k('⌘', 'D'), k('Ctrl', 'Shift', 'D')),
      keyRow('Split Down', k('⌘', '⇧', 'D'), k('Alt', 'Shift', 'D')),
    ]) + `<p>Split shortcuts work while a terminal has focus.</p>`],
    ['window', 'Window', keyTable([
      keyRow('Close Window', k('⌘', '⇧', 'W'), '—'),
    ])],
  ])

/* ───────────── Using MOVIE-ADE ───────────── */

page('projects.html', `Using ${APP}`, 'Projects and URLs',
  'A project is a folder (usually your repo root). Each project keeps its own saved URLs, so local, dev, and production are one click apart.',
  [
    ['add-project', 'Add a project', `
<ol class="docs-steps">
  <li>${ui('File → Open Project Folder…')} (${k('⌘', 'O')} / ${k('Ctrl', 'O')}), ${ui('Add Project')} in the sidebar, or ${ui('Add Project…')} in the title bar project menu.</li>
  <li>Pick the folder and click ${ui('Open')}.</li>
</ol>
<p>The name defaults to the folder name. Adding a folder that is already registered opens it instead (paths are compared case-insensitively on macOS and Windows). From the sidebar menu you can ${ui('Rename')} a project or ${ui('Remove from List')}. Removing never deletes the folder.</p>
<p>Terminals open in the project folder, and reviews are saved under <code>&lt;project&gt;/.ade-movie/</code>.</p>`],
    ['save-url', 'Save URLs', `
<ol class="docs-steps">
  <li>Open the page in the built-in browser.</li>
  <li>Click ${ui('+')} (${ui('Save current URL')}) in the browser toolbar. The current URL is pre-filled.</li>
  <li>Enter a ${ui('Name')} and click ${ui('Save')}.</li>
</ol>
<p>Only <code>http://</code> and <code>https://</code> URLs are accepted. The name is guessed from the host if you leave it as suggested:</p>
<table>
  <thead><tr><th>Host</th><th>Name</th></tr></thead>
  <tbody>
    <tr><td><code>localhost</code>, <code>127.*</code>, <code>::1</code>, <code>0.0.0.0</code>, <code>*.localhost</code></td><td><code>local</code></td></tr>
    <tr><td>contains <code>dev</code>, <code>develop</code>, <code>development</code></td><td><code>dev</code></td></tr>
    <tr><td>contains <code>stg</code>, <code>stage</code>, <code>staging</code></td><td><code>stg</code></td></tr>
    <tr><td>anything else</td><td><code>prd</code></td></tr>
  </tbody>
</table>
${shot('url-presets', 'Saved URLs in the browser toolbar')}`],
    ['switch-env', 'Open and switch environments', `
<p>Click a saved URL to open it. If the current page is under another saved URL, ${APP} keeps the path, query, and hash and swaps only the origin. For example, on <code>http://localhost:3000/pricing?plan=pro</code>, clicking <code>prd</code> opens <code>https://example.com/pricing?plan=pro</code>.</p>
<p>The chip matching the current page (longest prefix) is highlighted. Right-click a chip or use its pencil icon to edit or ${ui('Delete')} it. When a project opens and there is no previous URL, its first saved URL loads.</p>`],
  ])

page('recording.html', `Using ${APP}`, 'Recording',
  'Record the built-in browser, an entire screen, or another window. Talk, circle, and type while you use the page.',
  [
    ['target', 'Choose what to record', `
<p>In Feedback mode, click ${ui('Choose recording target')}. The ${ui('Recording Target')} dialog offers:</p>
<table>
  <thead><tr><th>Target</th><th>Captured</th></tr></thead>
  <tbody>
    <tr><td>${ui('Built-in Browser')} (default)</td><td>Video, voice, pen and text, plus URL, element selectors, clicks, and scrolls. No OS permission needed.</td></tr>
    <tr><td>${ui('Entire Screen')}</td><td>Video, voice, pen and text. No URL, element, or action log (this is noted in <code>feedback.md</code>).</td></tr>
    <tr><td>${ui('Window')}</td><td>Same as above. ${APP}'s own windows are not listed.</td></tr>
  </tbody>
</table>
<p>Your choice is remembered. On macOS, screen and window capture require Screen Recording permission (<a href="troubleshooting.html#screen-permission">how to grant it</a>).</p>`],
    ['record', 'Start, pause, stop', `
<ol class="docs-steps">
  <li>Open the page to review in the built-in browser.</li>
  <li>${ui('Record')} in the title bar, or ${k('⌘', '⇧', 'R')} / ${k('Ctrl', 'Shift', 'R')}.</li>
  <li>${ui('Pause')} stops drawing and the timer. ${ui('Resume')} continues.</li>
  <li>${ui('Stop')} or ${k('⌘', '⇧', 'R')} again.</li>
</ol>
<p>A recording is capped at 90 minutes. You get a warning near the limit, and the recording stops and saves automatically when it is reached.</p>
${shot('feedback-toolbar', 'Feedback mode toolbar')}`],
    ['pen-text', 'Pen and text', `
<ul>
  <li><strong>${ui('Pen')}</strong>: select it, or hold ${k('⌥')} / ${k('Alt')} to draw only while held (ignored while typing in a field).</li>
  <li><strong>${ui('Text')}</strong>: click the page, type, then ${k('Enter')} to place it. ${k('Shift', 'Enter')} adds a line break and ${k('Esc')} cancels.</li>
  <li><strong>${ui('Clear')}</strong>: removes the current marks.</li>
</ul>
<p>The tools are available only while recording. With the microphone off, text alone is enough to create findings.</p>`],
    ['annotations-clear', 'When marks disappear', `
<p>Marks belong to the screen they were drawn on. They are recorded into the current finding, then cleared, when:</p>
<ul>
  <li>the page navigates: a full load, or an SPA route change to a new path or query. A hash-only change keeps them.</li>
  <li>you scroll the page</li>
  <li>a spoken segment ends</li>
</ul>`],
    ['mic', 'Microphone', `
<p>The microphone is on by default. Toggle it from the footer (${ui('Turn microphone off')} / ${ui('Turn microphone on')}) or with ${ui('Record my voice')} in Settings. Choose a device under ${ui('Microphone')}.</p>
${soon(`<p>${ui('Record the other side too')} (capturing other participants in a meeting via system audio) is in beta. It has not been validated with meeting apps yet.</p>`)}`],
  ])

page('agents.html', `Using ${APP}`, 'Sending to agents',
  'Run Claude Code or Codex in the built-in terminal and hand them a review with one click. You can also copy the instruction for any other agent, or post the review to GitHub.',
  [
    ['findings', 'Review findings', `
<p>Each card in the ${ui('Findings')} tab supports:</p>
<ul>
  <li>Inline edit of the title and request</li>
  <li>${ui('Send')} / ${ui("Don't send")} toggle</li>
  <li>${ui('Watch Recording')} (seeks to that time) and ${ui('Replace Image')} (pick another frame)</li>
  <li>${ui('Confirm')} / ${ui('Mark as Needs Review')}, ${ui('Merge with Next')}, ${ui('Delete')}</li>
</ul>
<p>The header has ${ui('Undo')}, ${ui('Open Folder')}, ${ui('Copy for Agent')}, ${ui('Send to GitHub')}, ${ui('Organize')}, and ${ui('Send to Agent')}. Speech that didn't become a finding is listed under ${ui('Excluded speech')}, where ${ui('Restore as Finding')} brings it back. ${ui('Overall Note')} adds a note for the whole review.</p>
${shot('findings', 'The Findings tab')}`],
    ['terminal', 'Run agents in the built-in terminal', `
<p>When a project opens, ${APP} starts one terminal tab per enabled agent in the project folder. The defaults are:</p>
${code(`claude --dangerously-skip-permissions
codex --dangerously-bypass-approvals-and-sandbox`)}
${note(`<p>These flags let the agent edit files and run commands without asking. If you want approval prompts, clear the arguments in ${ui('Settings → Agent')} (${ui('Claude Code arguments')} / ${ui('Codex arguments')}). ${ui('Reset Commands')} restores the defaults.</p>`, 'warn', 'About the default flags')}
<p>If neither agent is enabled, a plain shell opens. The ${ui('+')} menu opens ${ui('New Terminal')}, launches Claude Code or Codex in a new tab, or jumps to ${ui('Agent settings…')}. Its search box also finds tabs, saved URLs, and files.</p>
<p>Tabs show the agent state: ${ui('Running')}, ${ui('Waiting for input')}, ${ui('Done (unread)')}, ${ui('Idle')}.</p>
${keyTable([
  keyRow('New Terminal', k('⌘', 'T'), k('Ctrl', 'T')),
  keyRow('Split Right', k('⌘', 'D'), k('Ctrl', 'Shift', 'D')),
  keyRow('Split Down', k('⌘', '⇧', 'D'), k('Alt', 'Shift', 'D')),
  keyRow('Close Pane / Tab', k('⌘', 'W'), k('Ctrl', 'W')),
])}`],
    ['send', 'Send to Agent / Copy for Agent', `
<ol class="docs-steps">
  <li>Focus a terminal tab where Claude Code or Codex is running.</li>
  <li>Click ${ui('Send to Agent')}.</li>
  <li>${APP} writes the instruction into the agent's input and submits it. Follow progress in the terminal.</li>
</ol>
<p>Nothing is sent if no agent is detected in that terminal, or if the agent is waiting for a permission answer. Answer in the terminal first.</p>
<p>${ui('Copy for Agent')} puts the same instruction on the clipboard for an agent running elsewhere (another terminal, IDE, or app). Only findings toggled to ${ui('Send')} are addressed. The video is never included.</p>`],
    ['prompt', 'Customize the instruction', `
<p>Edit ${ui('Settings → Agent → Instructions for Agent')}. Two variables are expanded:</p>
<table>
  <thead><tr><th>Variable</th><th>Expands to</th></tr></thead>
  <tbody>
    <tr><td><code>{{path}}</code></td><td>Absolute path of <code>feedback.md</code></td></tr>
    <tr><td><code>{{relpath}}</code></td><td>Path relative to the project: <code>.ade-movie/reviews/&lt;id&gt;/feedback.md</code></td></tr>
  </tbody>
</table>
<p>Leave it empty to use the default. The maximum length is 2000 characters, and ${ui('Reset Instructions')} restores the default. Example:</p>
${code('Read {{relpath}} and the PNGs next to it. Fix only findings marked to send, one commit per finding, then run the tests.')}
<p>The setting is stored as <code>agentPrompt</code> in <code>settings.json</code>.</p>`],
    ['github', 'Send to GitHub (Issue / PR comment)', `
<p>${ui('Send to GitHub')} posts the review as a new issue or as a comment on one of your open pull requests. Authentication is delegated to the <a href="https://cli.github.com/">GitHub CLI</a>. ${APP} never reads or stores a token.</p>
<ol class="docs-steps">
  <li>Install <code>gh</code>: <code>brew install gh</code> (macOS), <code>winget install --id GitHub.cli</code> (Windows), or see <a href="https://github.com/cli/cli#installation">cli/cli</a>.</li>
  <li>${ui('Settings → GitHub → Sign In in Terminal')} runs <code>gh auth login --web -h github.com</code> in the built-in terminal.</li>
  <li>Click ${ui('Send to GitHub')}, choose ${ui('Create a new issue')} or a PR, and review the ${ui('Title')} and ${ui('Body')} (editable).</li>
  <li>Tick the confirmation checkbox, then ${ui('Create Issue')} or ${ui('Post Comment')}.</li>
</ol>
<p>Details:</p>
<ul>
  <li>The repository comes from <code>git remote get-url origin</code>.</li>
  <li>${APP} runs <code>gh issue create --repo … --title … --body-file -</code> or <code>gh pr comment &lt;n&gt; --repo … --body-file -</code>.</li>
  <li>The body is <code>feedback.md</code> without the image lines (images are not uploaded), up to 60,000 characters.</li>
  <li>PR candidates are your own open PRs (up to 30).</li>
</ul>
<p>If <code>GH_TOKEN</code> or <code>GITHUB_TOKEN</code> is set, <code>gh</code> uses it first, and the settings panel warns about it.</p>`],
  ])

page('editor.html', `Using ${APP}`, 'Editor and preview',
  'Open and edit project files, and preview Markdown and Mermaid. A preview opened in the built-in browser can be recorded and reviewed like any web page.',
  [
    ['files', 'Open and edit files', `
<ul>
  <li>${ui('Files')} (the file tree): ${k('⌘', '⇧', 'E')} / ${k('Ctrl', 'Shift', 'E')}, with ${ui('Filter by file name')}, ${ui('Refresh')}, and ${ui('Collapse All')}.</li>
  <li>${ui('Go to File…')}: ${k('⌘', 'P')} / ${k('Ctrl', 'P')}.</li>
  <li>Save with ${k('⌘', 'S')} / ${k('Ctrl', 'S')}. Closing a modified file asks <q>Save changes to &lt;name&gt;?</q> with ${ui('Save')}, ${ui("Don't Save")}, and ${ui('Cancel')}.</li>
  <li>If the file changes on disk while you have unsaved edits, choose ${ui('Reload from Disk')} or ${ui('Keep My Changes')}.</li>
</ul>
<p>The editor is Monaco.</p>
${soon('<p>Creating, renaming, and deleting files from the file tree.</p>')}`],
    ['preview', 'Markdown and Mermaid preview', `
<p>Preview works for <code>.md</code>, <code>.markdown</code>, <code>.mdx</code>, <code>.mmd</code>, and <code>.mermaid</code>. Mermaid is bundled with the app, so diagrams render offline.</p>
<ul>
  <li>${ui('Open Preview to the Side')}: next to the editor</li>
  <li>${ui('Open Preview')}: in the built-in browser (<code>ade-preview://</code>), so you can record and review it</li>
</ul>`],
    ['review-docs', 'Review docs by recording', `
<ol class="docs-steps">
  <li>Open a Markdown file and click ${ui('Open Preview')}.</li>
  <li>Record as usual. Talk through the spec or design doc and circle what's wrong.</li>
  <li>Stop. Findings reference the file's project-relative path instead of a URL.</li>
  <li>${ui('Send to Agent')} to have the doc fixed.</li>
</ol>
${shot('preview', 'Markdown preview in the built-in browser')}`],
  ])

/* ───────────── Configure ───────────── */

page('transcription.html', 'Configure', 'Transcription and costs',
  'Choose on-device whisper (free), your own OpenAI key, or any OpenAI-compatible endpoint such as your own GPU box. Audio goes directly from your machine to the service you pick.',
  [
    ['cost-model', 'Who pays, and where traffic goes', note(`<ul>
  <li>The developer (Japan Marketing LLC) does not pay for, proxy, or bill any transcription or AI usage.</li>
  <li>Requests go directly from your computer to OpenAI or your endpoint, never through a developer server.</li>
  <li>OpenAI usage is billed to your own OpenAI account.</li>
  <li>${ui('Organize')} uses the Claude Code / Codex CLI you are already signed in to. It never falls back to an API key.</li>
</ul>`, 'note', 'Cost and network model')],
    ['methods', 'Methods', `
<p>Choose in ${ui('Settings → Transcription → Engine')}. The footer's ${ui('Microphone &amp; Transcription')} popover shows the current choice.</p>
<table>
  <thead><tr><th>Engine</th><th>Audio goes to</th><th>Cost</th></tr></thead>
  <tbody>
    <tr><td>${ui('On device (free)')} (default)</td><td>Nowhere</td><td>Free</td></tr>
    <tr><td>${ui('OpenAI (your key)')}</td><td>OpenAI</td><td>Your OpenAI bill: <code>gpt-transcribe</code> at $0.0045/min (about $0.27/hour)</td></tr>
    <tr><td>${ui('OpenAI-compatible (self-hosted GPU, Groq, etc.)')}</td><td>Your ${ui('Endpoint Base URL')}</td><td>Depends on the endpoint</td></tr>
  </tbody>
</table>
<p>${ui('Settings → Transcription → Language')}: ${ui('Auto')}, ${ui('Japanese')}, or ${ui('English')}. This is the spoken language, separate from the interface language.</p>`],
    ['whisper', 'On-device whisper (free)', `
<p>On-device transcription uses <a href="https://github.com/ggml-org/whisper.cpp">whisper.cpp</a>: the <code>whisper-cli</code> binary plus a GGML model.</p>
<p><strong>1. Install whisper-cli</strong>. ${APP} looks for a bundled copy (<code>resources/whisper/&lt;platform&gt;-&lt;arch&gt;/</code>), then <code>PATH</code>, then common locations such as Homebrew.</p>
${code(`# macOS
brew install whisper-cpp

# Linux: build from source, then add build/bin to PATH
git clone https://github.com/ggml-org/whisper.cpp &amp;&amp; cd whisper.cpp
cmake -B build &amp;&amp; cmake --build build -j --config Release

# Windows: download the zip from github.com/ggml-org/whisper.cpp/releases
# and add the folder containing whisper-cli.exe to PATH`)}
<p><strong>2. Get a model</strong>. With ${ui('On device (free)')} selected, pick a ${ui('Model')} and click ${ui('Download model')}. Files come straight from Hugging Face (<code>ggerganov/whisper.cpp</code>), are checked against a sha256 pinned in the app (a mismatch deletes the file), and are saved to <code>&lt;userData&gt;/models/</code>. The downloaded model is selected automatically. ${ui('Cancel')} keeps the partial file, and ${ui('Resume download')} continues from there.</p>
<table>
  <thead><tr><th>Model</th><th>Size</th><th>Notes</th></tr></thead>
  <tbody>
    <tr><td><code>large-v3-turbo</code></td><td>1.6 GB</td><td>Recommended default. Fast on Metal / GPU</td></tr>
    <tr><td><code>large-v3-turbo-q5_0</code></td><td>574 MB</td><td>Quantized. Saves disk and memory</td></tr>
    <tr><td><code>small</code></td><td>488 MB</td><td>For CPU-only machines</td></tr>
    <tr><td><code>base</code></td><td>148 MB</td><td>Light. Many errors in Japanese</td></tr>
    <tr><td><code>tiny</code></td><td>78 MB</td><td>Fastest. Not accurate enough for Japanese</td></tr>
  </tbody>
</table>
<p>Already have a model? Use ${ui('Choose a file…')} to point at any <code>ggml-*.bin</code>. Without a model, Settings shows ${ui('No model set (pen and text still work)')}: you can still record, audio is saved, and only pen and text findings are produced.</p>
<p>whisper-cli is not bundled with the app. Install it yourself as shown above. When it can't be found, Settings shows <q>whisper.cpp (whisper-cli) was not found. Install it, then reopen the settings.</q> with the same instructions.</p>`],
    ['openai', 'Your own OpenAI key', `
<ol class="docs-steps">
  <li>Set ${ui('Engine')} to ${ui('OpenAI (your key)')}.</li>
  <li>Paste a key starting with <code>sk-</code> into ${ui('OpenAI API key')} and click ${ui('Save')}.</li>
  <li>Click ${ui('Test connection')}. It sends 1 second of silence (about $0.0001).</li>
</ol>
<p>The model is fixed to <code>gpt-transcribe</code>. In development (<code>pnpm dev</code>) only, <code>OPENAI_API_KEY</code> from an ignored <code>.env</code> file is also read. Packaged builds never read <code>.env</code>.</p>`],
    ['compatible', 'OpenAI-compatible endpoints', `
<p>${APP} sends <code>POST &lt;base&gt;/v1/audio/transcriptions</code> (multipart: <code>file</code>, <code>model</code>, <code>response_format=json</code>, <code>language</code>, <code>prompt</code>), so it is designed for servers that implement the OpenAI transcription route.</p>
<ol class="docs-steps">
  <li>Set ${ui('Engine')} to ${ui('OpenAI-compatible (self-hosted GPU, Groq, etc.)')}.</li>
  <li>Fill in ${ui('Endpoint Base URL')} and ${ui('Model')} (the endpoint's model name).</li>
  <li>If the server needs one, enter ${ui('Endpoint API key (optional)')} and click ${ui('Save')}.</li>
  <li>Click ${ui('Test connection')}. Errors name the cause, e.g. a wrong Base URL (no <code>/v1/audio/transcriptions</code>), a rejected key, or an unknown model name.</li>
</ol>
<table>
  <thead><tr><th>Server</th><th>Base URL</th><th>Model (example)</th></tr></thead>
  <tbody>
    <tr><td><a href="https://github.com/speaches-ai/speaches">speaches</a> (formerly faster-whisper-server)</td><td><code>http://localhost:8000/v1</code></td><td><code>Systran/faster-whisper-small</code></td></tr>
    <tr><td><a href="https://docs.vllm.ai/">vLLM</a> (<code>vllm serve openai/whisper-large-v3</code>)</td><td><code>http://localhost:8000/v1</code></td><td><code>openai/whisper-large-v3</code></td></tr>
    <tr><td><a href="https://console.groq.com/docs/speech-to-text">Groq</a></td><td><code>https://api.groq.com/openai/v1</code></td><td><code>whisper-large-v3-turbo</code></td></tr>
  </tbody>
</table>
${note(`<p>${APP} is designed for OpenAI-compatible servers like these, but they have not been tested against ${APP} yet. The URLs and model names are the servers' own documented defaults.</p>`, 'warn')}
<ul>
  <li>A trailing <code>/v1</code> or a pasted <code>/v1/audio/transcriptions</code> is stripped when saved, so either form works.</li>
  <li>URLs containing a username or password are rejected, so keys never end up in <code>settings.json</code>.</li>
  <li>For a GPU box on your LAN or tailnet, use its address, e.g. <code>http://100.x.y.z:8000/v1</code>.</li>
</ul>`],
    ['limit', 'Cost cap', `
<p>For OpenAI and compatible endpoints, set ${ui('Cost cap')}: ${ui('None')}, or ${ui('Up to $0.10 per review')} through $0.50, $1 (default), $5, and $20. For your own GPU, ${ui('None')} makes sense. The setting is stored as <code>capture.costLimitUsd</code> (max 1000, <code>null</code> means no cap). Compatible endpoints are estimated at $0.006/min.</p>
<p>When the next chunk would exceed the cap, ${APP} stops sending and keeps the audio. Failed API calls are not retried automatically.</p>`],
    ['keys', 'Where keys are stored', `
<p>Keys are encrypted with Electron <code>safeStorage</code> and written to <code>&lt;userData&gt;/stt-keys.bin</code>. They are never written to <code>settings.json</code>.</p>
<ul>
  <li>macOS: Keychain</li>
  <li>Windows: DPAPI</li>
  <li>Linux: libsecret or KWallet. If only the <code>basic_text</code> backend is available, the key is kept in memory for the current session only (the button reads ${ui('Set for this session')}).</li>
</ul>
<p>${ui('Delete key')} removes it. For <code>&lt;userData&gt;</code> paths, see <a href="files.html#userdata">Files and environment</a>.</p>`],
  ])

page('accounts.html', 'Configure', 'Accounts and usage',
  'Switch between several Claude Code or Codex logins, and watch your rate-limit windows in the footer.',
  [
    ['accounts', 'Multiple accounts', `
<p>Accounts are optional. Add them only if you switch between several.</p>
<ol class="docs-steps">
  <li>Open ${ui('Settings → Accounts')}, or ${ui('Manage Accounts…')} from the footer usage menu.</li>
  <li>${ui('Add Account')} starts the agent's login in a built-in terminal tab.</li>
  <li>Pick the account to use. Running tabs keep their account. New tabs use the selected one.</li>
</ol>
<p>How it works: each added account gets its own config directory, <code>&lt;userData&gt;/accounts/&lt;agent&gt;/&lt;id&gt;/</code>. ${APP} launches the agent with <code>CLAUDE_CONFIG_DIR</code> (Claude Code) or <code>CODEX_HOME</code> (Codex) pointing there. ${ui('System Default')} uses your usual <code>~/.claude</code> / <code>~/.codex</code> unchanged.</p>
<p>Removing an account deletes its config directory. It does not sign you out on the server.</p>`],
    ['usage', 'Usage in the footer', `
<p>The footer shows how much of each rate-limit window is used: the 5-hour window and the weekly window, plus the per-model weekly window for Claude. Colors turn yellow at 60% and red at 80%. Values refresh every 15 minutes, or on ${ui('Refresh usage')}.</p>
<p>Display: ${ui('Detailed')} (bars, window names, and percentages) or ${ui('Compact')} (one value per agent).</p>
<p>Usage is fetched directly from Anthropic (<code>api.anthropic.com/api/oauth/usage</code>) and ChatGPT (<code>chatgpt.com/backend-api/wham/usage</code>) with the signed-in account's own credentials.</p>
${shot('usage', 'Usage in the footer')}`],
  ])

page('settings.html', 'Configure', 'Settings reference',
  `Open ${ui('Settings')} from the gear in the title bar. Settings can't be changed while recording.`,
  [
    ['microphone', 'Microphone', `
<table>
  <thead><tr><th>Setting</th><th>Default</th></tr></thead>
  <tbody>
    <tr><td>${ui('Record my voice')}</td><td>On</td></tr>
    <tr><td>${ui('Microphone')}</td><td>${ui('System Default')}</td></tr>
    <tr><td>${ui('Record the other side too')} (beta)</td><td>Off</td></tr>
  </tbody>
</table>`],
    ['transcription', 'Transcription', `
<table>
  <thead><tr><th>Setting</th><th>Default</th></tr></thead>
  <tbody>
    <tr><td>${ui('Language')} (spoken)</td><td>${ui('Auto')}</td></tr>
    <tr><td>${ui('Engine')}</td><td>${ui('On device (free)')}</td></tr>
    <tr><td>${ui('Model')} (on device)</td><td><code>large-v3-turbo</code> (recommended)</td></tr>
    <tr><td>${ui('Endpoint Base URL')} / ${ui('Model')} (compatible)</td><td>empty</td></tr>
    <tr><td>${ui('OpenAI API key')} / ${ui('Endpoint API key (optional)')}</td><td>not set</td></tr>
    <tr><td>${ui('Cost cap')}</td><td>Up to $1 per review</td></tr>
  </tbody>
</table>
<p>See <a href="transcription.html">Transcription and costs</a>.</p>`],
    ['storage', 'Storage', `
<table>
  <thead><tr><th>Setting</th><th>Default</th></tr></thead>
  <tbody>
    <tr><td>${ui('Keep recordings')}: 7 days / 30 days / ${ui('Forever')}</td><td>7 days</td></tr>
    <tr><td>${ui('Stay on the feedback screen after stopping')}</td><td>Off</td></tr>
  </tbody>
</table>`],
    ['agent', 'Agent', `
<table>
  <thead><tr><th>Setting</th><th>Default</th></tr></thead>
  <tbody>
    <tr><td>${ui('Start Claude Code')} / ${ui('Start Codex')}</td><td>Both on</td></tr>
    <tr><td>${ui('Claude Code command')} / ${ui('arguments')}</td><td><code>claude</code> / <code>--dangerously-skip-permissions</code></td></tr>
    <tr><td>${ui('Codex command')} / ${ui('arguments')}</td><td><code>codex</code> / <code>--dangerously-bypass-approvals-and-sandbox</code></td></tr>
    <tr><td>${ui('Instructions for Agent')}</td><td>Built-in text (<a href="agents.html#prompt">variables</a>)</td></tr>
  </tbody>
</table>`],
    ['other', 'Accounts, GitHub, appearance, language', `
<ul>
  <li>${ui('Accounts')}: see <a href="accounts.html">Accounts and usage</a>.</li>
  <li>${ui('GitHub')}: <code>gh</code> sign-in. See <a href="agents.html#github">Send to GitHub</a>.</li>
  <li>${ui('Appearance → Theme')}: ${ui('System')} (default), ${ui('Light')}, ${ui('Dark')}.</li>
  <li>${ui('Language → Interface')}: ${ui('System')} (default; follows the OS language: Japanese on a Japanese OS, English otherwise), English, or Japanese.</li>
</ul>
<p>From the footer: terminal position (right / bottom) and the microphone toggle.</p>`],
    ['settings-json', 'settings.json', `
<p>Everything above is stored in <code>&lt;userData&gt;/settings.json</code>. Invalid values fall back to defaults on load. Notable keys:</p>
${code(`{
  "theme": "system",                 // system | light | dark
  "locale": "system",
  "terminalDock": "right",           // right | bottom
  "viewport": "desktop",             // desktop | mobile
  "capture": {
    "captureMic": true,
    "captureSystemAudio": false,
    "transcription": "local",        // local | openai | compatible
    "language": "auto",              // auto | ja | en
    "baseUrl": "http://localhost:8000",
    "model": "Systran/faster-whisper-small",
    "costLimitUsd": 1,               // null = no cap
    "keepDays": 7,                   // 0 = keep forever
    "stayFeedbackOnStop": false
  },
  "agents": {
    "startupAgents": ["claude", "codex"],
    "launch": { "claude": { "command": "claude", "args": "--dangerously-skip-permissions" } }
  },
  "agentPrompt": "Read \\"{{path}}\\" …"
}`)}
<p>Edit it only while the app is closed. The app rewrites the file on change.</p>`],
  ])

/* ───────────── Reference ───────────── */

page('privacy.html', 'Reference', 'Data and privacy',
  'Reviews live in your project folder. App settings live in the OS user-data folder. Only crash reports reach the developer, through Sentry, and you can turn them off.',
  [
    ['reviews', 'Inside .ade-movie/reviews/', `
${code(`&lt;project&gt;/.ade-movie/reviews/20261003-104500/
├── feedback.md      # what the agent reads
├── 01.png, 02.png…  # one or more images per finding
├── session.json     # review state and edit history
├── events.jsonl     # action log (built-in browser only)
├── recording.webm   # the video
└── work/            # intermediate audio and frames`)}
<p>When recording starts, <code>.ade-movie/</code> is appended to <code>.git/info/exclude</code>. Worktrees and submodules are handled. <code>.gitignore</code> is never modified. An interrupted review can be recovered from history if its records survived. The app then warns that the last seconds may be missing.</p>`],
    ['retention', 'Retention', `
<p>${ui('Keep recordings')} (7 days by default, 30 days, or ${ui('Forever')}): on startup, completed reviews older than that lose <code>recording.webm</code> and <code>work/</code>. <code>feedback.md</code> and the finding images are kept. Incomplete reviews are never pruned. Pruning runs at launch, for the last opened project.</p>`],
    ['network', 'What leaves your machine', `
<table>
  <thead><tr><th>When</th><th>Destination</th><th>Data</th></tr></thead>
  <tbody>
    <tr><td>Transcription: ${ui('On device (free)')}</td><td>none</td><td>—</td></tr>
    <tr><td>Transcription: OpenAI / compatible</td><td>OpenAI or your Base URL</td><td>audio chunks</td></tr>
    <tr><td>Model download</td><td>Hugging Face</td><td>file request</td></tr>
    <tr><td>${ui('Organize')}</td><td>your Claude Code / Codex CLI</td><td>text and action log only (no images, audio, or video)</td></tr>
    <tr><td>${ui('Send to Agent')}</td><td>the agent in your terminal</td><td>one instruction pointing at <code>feedback.md</code></td></tr>
    <tr><td>${ui('Send to GitHub')}</td><td>GitHub via <code>gh</code></td><td>body text only (no images)</td></tr>
    <tr><td>Footer usage</td><td>Anthropic, ChatGPT</td><td>usage request with your own login</td></tr>
    <tr><td>${ui('Check for Updates')} (manual)</td><td>download server (Cloudflare R2)</td><td>request for <code>latest.json</code></td></tr>
    <tr><td>A crash or error (${ui('Send crash reports')} on)</td><td>Sentry</td><td>stack trace and OS / CPU / app versions (see <a href="#crash-reports">Crash reports</a>)</td></tr>
  </tbody>
</table>
<ul>
  <li>No analytics or usage tracking. Crash reports are the only thing sent without you asking, and you can turn them off.</li>
  <li>Secret-looking values in URLs (tokens, keys) are redacted before they are written to <code>feedback.md</code>.</li>
  <li>Text captured from the page is marked as data in <code>feedback.md</code>, so the agent is told not to follow instructions found in it.</li>
</ul>`],
    ['crash-reports', 'Crash reports', `
<p>When the app crashes or hits an unhandled error, ${APP} sends a crash report to <a href="https://sentry.io/">Sentry</a> so the bug can be fixed. It is on by default. Turn it off in ${ui('Settings → Privacy → Send crash reports')}, or with ${ui('Turn off')} on the notice shown at first launch. Turning it off takes effect at once. Turning it back on takes effect at the next launch. Development builds (<code>pnpm dev</code>) also send, tagged <code>development</code>, so the developers can fix crashes they hit while working. E2E runs and unit tests never send.</p>
<table>
  <thead><tr><th>Sent</th><th>Not sent</th></tr></thead>
  <tbody>
    <tr><td>
      <ul>
        <li>Error type and message, with home-folder paths shown as <code>~</code></li>
        <li>Stack trace (where in ${APP}'s code it happened)</li>
        <li>For native crashes: the minidump (thread stacks of the crashed process)</li>
        <li>OS name and version, CPU architecture, Electron / Chrome / Node versions, app version, screen size, memory size</li>
        <li>App lifecycle events right before the error (for example <q>app.ready</q>), and startup failures</li>
        <li>Which part of the app failed: a screen area that could not render (and its React component names), an IPC call, a terminal that could not start, a crashed or hung process, or a page of the app that failed to load</li>
      </ul>
    </td><td>
      <ul>
        <li>Your project folder path and file names (replaced with <code>&lt;project&gt;</code>)</li>
        <li>URLs opened in the built-in browser, and any other web address (replaced with <code>&lt;url&gt;</code>)</li>
        <li>Terminal output, transcripts, findings, page text, screenshots</li>
        <li>Email addresses and API keys or tokens (replaced)</li>
        <li>Your name, device name, IP address (not stored), cookies, local variables</li>
        <li>Clicks, console logs, network requests</li>
      </ul>
    </td></tr>
  </tbody>
</table>
<p>The installed app sends at most 10 reports per launch and only half of JavaScript errors (native crashes are always sent). Development builds send every error, up to 50 per launch. The same error is sent only once per launch. No performance tracing or session replay is used. The app uses Sentry's free plan. If it fills up, extra reports are dropped and nobody is charged.</p>
<p>Building ${APP} yourself? Set <code>MOVIE_ADE_SENTRY_DSN</code> to your own Sentry DSN, or to an empty string to send nothing. The code is in <code>src/main/telemetry.ts</code> and <code>src/shared/telemetry.ts</code>.</p>`],
  ])

page('files.html', 'Reference', 'Files and environment',
  `Where ${APP} keeps its own files, and the environment variables it reads or sets.`,
  [
    ['userdata', 'userData folder', `
<p>App data lives in Electron's <code>userData</code> folder. Its name is pinned to <code>ade-movie</code> (not the product name), so data survives renames. Override it with <code>--user-data-dir=&lt;path&gt;</code>.</p>
<table>
  <thead><tr><th>OS</th><th>Path</th></tr></thead>
  <tbody>
    <tr><td>macOS</td><td><code>~/Library/Application Support/ade-movie/</code></td></tr>
    <tr><td>Windows</td><td><code>%APPDATA%\\ade-movie\\</code></td></tr>
    <tr><td>Linux</td><td><code>~/.config/ade-movie/</code> (or <code>$XDG_CONFIG_HOME/ade-movie/</code>)</td></tr>
  </tbody>
</table>
${code(`settings.json       # all settings (see Settings reference)
stt-keys.bin        # API keys, encrypted with safeStorage
models/             # downloaded whisper models (ggml-*.bin)
accounts/claude/&lt;id&gt;/   # CLAUDE_CONFIG_DIR for added accounts
accounts/codex/&lt;id&gt;/    # CODEX_HOME for added accounts`)}
<p>A model you picked yourself can live anywhere. The legacy default location <code>~/.cache/ade-movie/models/ggml-small.bin</code> is still checked.</p>`],
    ['env', 'Environment variables', `
<table>
  <thead><tr><th>Variable</th><th>Effect</th></tr></thead>
  <tbody>
    <tr><td><code>CLAUDE_CONFIG_DIR</code>, <code>CODEX_HOME</code></td><td>Set by ${APP} for agent tabs when an added account is selected</td></tr>
    <tr><td><code>GH_TOKEN</code>, <code>GITHUB_TOKEN</code></td><td>Used by <code>gh</code> ahead of its own login. ${APP} warns when either is set</td></tr>
    <tr><td><code>ADE_PROJECT_DIR</code></td><td>Open (and register) this folder as the project on launch</td></tr>
    <tr><td><code>ADE_INITIAL_URL</code></td><td>Load this URL in the built-in browser on launch</td></tr>
    <tr><td><code>ADE_WHISPER_MODEL</code></td><td>Absolute path of a GGML model to use for on-device transcription, overriding the downloaded default</td></tr>
    <tr><td><code>MOVIE_ADE_SENTRY_DSN</code></td><td>Where crash reports go. Empty means none are sent (see <a href="privacy.html#crash-reports">Crash reports</a>)</td></tr>
    <tr><td><code>OPENAI_API_KEY</code></td><td>Read from <code>.env</code> in development only (<code>pnpm dev</code>), never in packaged builds</td></tr>
    <tr><td><code>PATH</code></td><td>Used to find <code>claude</code>, <code>codex</code>, <code>gh</code>, <code>git</code>, <code>whisper-cli</code>. On macOS and Linux, Homebrew, linuxbrew, and snap locations are added</td></tr>
  </tbody>
</table>`],
    ['project', 'Inside your project', `
<ul>
  <li><code>.ade-movie/reviews/&lt;id&gt;/</code>: reviews (see <a href="privacy.html#reviews">Data and privacy</a>)</li>
  <li><code>.git/info/exclude</code>: one line, <code>.ade-movie/</code>, added on first recording</li>
</ul>`],
  ])

/* ───────────── Help ───────────── */

page('troubleshooting.html', 'Help', 'Troubleshooting',
  'Common problems and fixes. The quoted messages are what the app shows in English.',
  [
    ['screen-permission', 'Screen or window capture fails (macOS)', `
<p>Message: <q>Recording the entire screen or another window requires macOS Screen Recording permission.</q></p>
<ol class="docs-steps">
  <li>In the ${ui('Recording Target')} dialog, click ${ui('Open System Settings')}.</li>
  <li>${ui('Privacy &amp; Security → Screen &amp; System Audio Recording')}: turn on MOVIE-ADE, or MOVIE-ADE Dev when running <code>pnpm dev</code>.</li>
  <li>Restart the app, then click ${ui('Check Again')}.</li>
</ol>
<p>Recording the ${ui('Built-in Browser')} needs no permission.</p>
<p>Running from source on macOS, <code>pnpm dev</code> launches a renamed, ad-hoc signed copy of Electron called MOVIE-ADE Dev (<code>scripts/prepare-dev-electron.mjs</code>). The first time it runs, macOS asks again for Screen Recording, Microphone, and Keychain (<code>ade-movie Safe Storage</code>) access. It doesn't ask again after that.</p>`],
    ['mic', 'Microphone does not open', `
<p>Message: <q>Couldn't open the microphone. Check the permission in your OS settings.</q></p>
<ul>
  <li>macOS: ${ui('System Settings → Privacy &amp; Security → Microphone')}, then turn on MOVIE-ADE (or MOVIE-ADE Dev when running <code>pnpm dev</code>).</li>
  <li>Windows: ${ui('Settings → Privacy &amp; security → Microphone')}, then allow desktop apps.</li>
</ul>
<p>You can keep working without a mic. Pen and text still create findings.</p>`],
    ['whisper', 'No on-device model / whisper-cli not found', `
<p>Message: <q>No on-device transcription model found. Audio will be saved, and only text and pen findings will be processed.</q></p>
<p>Download a model in Settings, or choose an existing <code>ggml-*.bin</code>. If Settings says <q>whisper.cpp (whisper-cli) was not found</q>, install it (<a href="transcription.html#whisper">instructions</a>), make sure it is on <code>PATH</code>, and reopen Settings. Packaged apps launched from Finder or Explorer may not see your shell's <code>PATH</code>, so install to a standard location such as Homebrew's.</p>
<p>A model download that fails its sha256 check is discarded. Retry it.</p>`],
    ['node-pty', 'Terminal: node-pty could not be loaded', `
<p>This happens when running from source and node-pty was built for a different Node or Electron ABI.</p>
${code('pnpm rebuild:native')}`],
    ['agent', "Agent not found / Send to Agent doesn't send", `
<ul>
  <li><code>command not found: claude</code> (or <code>codex</code>) in the terminal: the CLI is not installed or not on <code>PATH</code>. ${APP} shows the shell's own error and adds no hint. Check that the command works in your normal terminal, or set an absolute path in ${ui('Settings → Agent → … command')}.</li>
  <li><q>The agent is waiting for confirmation. Respond in the terminal, then send.</q> Answer the agent's prompt first.</li>
  <li><q>The agent's input isn't ready yet.</q> Wait for the agent to finish starting.</li>
  <li><q>The text was entered but not sent. Press Enter in the terminal.</q></li>
  <li><q>Open a terminal first.</q></li>
  <li><q>Can't parse launch arguments: Unclosed quote.</q> Fix the quoting in the agent's arguments.</li>
</ul>`],
    ['cannot-record', "Recording won't start", `
<ul>
  <li><q>Open a project folder first.</q></li>
  <li><q>Open a URL to review first.</q></li>
  <li><q>The page didn't load. Open a URL that displays, then record.</q> Check that the dev server is running. <q>Can't connect to the server</q> means nothing is listening on that port.</li>
</ul>`],
    ['openai', 'OpenAI key or endpoint not set', `
<p><q>No OpenAI API key is set…</q> or <q>The transcription endpoint (Base URL / model) isn't set…</q>: add it in Settings, or switch to ${ui('On device (free)')}. The audio of that recording is already saved.</p>`],
    ['github', 'GitHub errors', `
<ul>
  <li><q>GitHub CLI (gh) not found.</q> Install <code>gh</code>.</li>
  <li><q>Not signed in to GitHub.</q> ${ui('Settings → GitHub → Sign In in Terminal')}.</li>
  <li><q>No origin remote.</q> or <q>origin isn't a GitHub repository.</q> Check <code>git remote -v</code>.</li>
  <li><q>Repository not found, or you don't have access.</q> Check <code>gh auth status</code> and <code>GH_TOKEN</code>.</li>
</ul>`],
    ['report', 'Report a bug', `
<p>Open an issue at <a href="${REPO}/issues">${REPO.replace('https://', '')}/issues</a> with your OS, the app version (footer → ${ui('Updates')}), and steps to reproduce. Don't attach <code>.ade-movie/</code> contents that contain private screens.</p>`],
  ])

/* ───────────── frame ───────────── */

const GROUPS = [...new Set(pages.map((p) => p.group))]

const sprite = `<svg class="sprite" width="0" height="0" aria-hidden="true">
    <symbol id="i-github" viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></symbol>
    <symbol id="i-download" viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></symbol>
    <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></symbol>
    <symbol id="i-moon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></symbol>
    <symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></symbol>
  </svg>`

const header = `<header class="site-header">
    <div class="wrap">
      <a class="brand" href="../index.html" aria-label="${APP} home">
        <img src="../favicon.svg" alt="" width="24" height="24">${APP}
      </a>
      <nav class="site-nav" aria-label="Main">
        <a href="../index.html#features">Features</a>
        <a href="../download.html">Download</a>
        <a class="nav-keep" href="quick-start.html" aria-current="page">Docs</a>
        <a href="../download.html#versions">Changelog</a>
      </nav>
      <div class="header-actions">
        <button class="btn btn-sm btn-icon theme-toggle" type="button" data-theme-toggle aria-label="Toggle light and dark theme" title="Toggle theme">
          <svg class="icon icon-moon"><use href="#i-moon"/></svg>
          <svg class="icon icon-sun"><use href="#i-sun"/></svg>
        </button>
        <a class="btn btn-sm" href="${REPO}">
          <svg class="icon icon-fill"><use href="#i-github"/></svg><span class="btn-label">GitHub</span>
        </a>
        <a class="btn btn-sm btn-primary" href="../download.html">
          <svg class="icon"><use href="#i-download"/></svg><span class="btn-label">Download</span>
        </a>
      </div>
    </div>
  </header>`

const footer = `<footer class="site-footer">
    <div class="wrap">
      <div class="footer-grid">
        <div>
          <a class="brand" href="../index.html"><img src="../favicon.svg" alt="" width="24" height="24">${APP}</a>
          <p class="provider">Built by <a href="https://www.japan-marketing.co.jp/">Japan Marketing LLC</a></p>
        </div>
        <div>
          <h2>Product</h2>
          <ul>
            <li><a href="../download.html">Download</a></li>
            <li><a href="../download.html#versions">All versions</a></li>
            <li><a href="quick-start.html">Docs</a></li>
            <li><a href="../index.html#features">Features</a></li>
          </ul>
        </div>
        <div>
          <h2>Open source</h2>
          <ul>
            <li><a href="${REPO}">GitHub</a></li>
            <li><a href="${REPO}/issues">Issues</a></li>
            <li><a href="${REPO}/blob/main/LICENSE">MIT License</a></li>
          </ul>
        </div>
        <div>
          <h2>Privacy</h2>
          <p>This site uses no analytics and no cookies. It only stores your light/dark choice in your browser.</p>
        </div>
      </div>
      <div class="footer-bottom">
        <span>© <span data-year>2026</span> Japan Marketing LLC. ${APP} is released under the MIT License.</span>
      </div>
    </div>
  </footer>`

const sidebar = (current) => GROUPS.map((g) => `<div class="docs-nav-group">
        <p class="docs-nav-heading">${g}</p>
        <ul>
          ${pages.filter((p) => p.group === g).map((p) => `<li><a href="${p.file}"${p.file === current ? ' aria-current="page"' : ''}>${p.title}</a></li>`).join('\n          ')}
        </ul>
      </div>`).join('\n      ')

const strip = (s) => s.replace(/<[^>]+>/g, '')
const attr = (s) => strip(s).replace(/"/g, '&quot;')

function shell({ file, title, description, body, head = '' }) {
  const url = `${SITE_URL}/docs/${file === 'index.html' ? '' : file.replace(/\.html$/, '')}`
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <meta name="description" content="${attr(description)}">
  <meta name="color-scheme" content="light dark">
  <link rel="canonical" href="${url}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${APP}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${attr(description)}">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="${SITE_URL}/assets/og.png">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="../favicon.svg" type="image/svg+xml">
  <link rel="icon" href="../favicon-32.png" type="image/png" sizes="32x32">
  <script src="../js/theme.js"></script>
  <link rel="stylesheet" href="../style.css">
  <link rel="stylesheet" href="docs.css">
  <script src="docs.js" defer></script>${head ? `\n  ${head}` : ''}
</head>
<!-- Generated layout: the sidebar, header, and footer are identical on every page in site/docs/. Change them on all pages together. -->
<body data-page="docs">
  <a class="skip" href="#docs-main">Skip to content</a>
  ${sprite}

  ${header}

  ${body}

  ${footer}
</body>
</html>
`
}

function docPage(p, i) {
  const prev = pages[i - 1]
  const next = pages[i + 1]
  const sections = p.sections.map(([id, h, html]) => `<section class="docs-section" aria-labelledby="${id}">
        <h2 id="${id}"><a class="docs-anchor" href="#${id}" aria-label="Link to ${attr(h)}">#</a>${h}</h2>
        ${html.trim()}
      </section>`).join('\n\n      ')
  const body = `<div class="wrap docs-layout">
    <nav class="docs-sidebar" aria-label="Docs pages" id="docs-sidebar">
      <button class="docs-sidebar-toggle" type="button" aria-expanded="true" aria-controls="docs-nav-list" data-docs-nav-toggle>
        <svg class="icon"><use href="#i-menu"/></svg>Docs menu
      </button>
      <div class="docs-nav-list" id="docs-nav-list">
      ${sidebar(p.file)}
      </div>
    </nav>

    <main class="docs-main" id="docs-main">
      <article class="docs-content">
        <p class="docs-eyebrow">${p.group}</p>
        <h1>${p.title}</h1>
        <p class="docs-lead">${p.lead}</p>

      ${sections}

        <nav class="docs-pager" aria-label="Previous and next page">
          ${prev ? `<a class="docs-pager-prev" href="${prev.file}"><span>Previous</span>${prev.title}</a>` : '<span></span>'}
          ${next ? `<a class="docs-pager-next" href="${next.file}"><span>Next</span>${next.title}</a>` : '<span></span>'}
        </nav>
        <p class="docs-edit"><a href="${REPO}/blob/main/site/docs/${p.file}">Edit this page on GitHub</a></p>
      </article>
    </main>

    <aside class="docs-toc" aria-label="On this page">
      <p class="docs-toc-heading">On this page</p>
      <ul>
        ${p.sections.map(([id, h]) => `<li><a href="#${id}">${strip(h)}</a></li>`).join('\n        ')}
      </ul>
    </aside>
  </div>`
  return shell({ file: p.file, title: `${strip(p.title)} · ${APP} docs`, description: p.lead, body })
}

/** /docs/ は Quick start へ移すだけのページ（meta refresh は CSP の対象外） */
function indexPage() {
  return shell({
    file: 'index.html',
    title: `${APP} docs`,
    description: `${APP} documentation: install, record UI feedback, and send it to Claude Code or Codex.`,
    head: '<meta http-equiv="refresh" content="0; url=quick-start.html">',
    body: `<main class="wrap docs-redirect" id="docs-main">
    <h1>${APP} docs</h1>
    <p>Start with the <a href="quick-start.html">Quick start</a>.</p>
    <ul>
      ${pages.map((p) => `<li><a href="${p.file}">${p.title}</a></li>`).join('\n      ')}
    </ul>
  </main>`,
  })
}

/** ファイル名 → HTML。書き出しはしない（テストから使う） */
export function renderDocs() {
  const out = { 'index.html': indexPage() }
  pages.forEach((p, i) => (out[p.file] = docPage(p, i)))
  return out
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const docs = renderDocs()
  mkdirSync(DOCS_DIR, { recursive: true })
  // 消したページが残らないよう、出力に無い HTML を消す（docs.css / docs.js は残す）
  for (const f of readdirSync(DOCS_DIR)) if (f.endsWith('.html') && !(f in docs)) rmSync(join(DOCS_DIR, f))
  for (const [file, html] of Object.entries(docs)) writeFileSync(join(DOCS_DIR, file), html)
  console.log(`site/docs: ${Object.keys(docs).length} pages`)
}
