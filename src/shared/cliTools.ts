import type { PlatformName } from './types'

/**
 * よく使うサービスの CLI（GitHub・GitLab・Cloudflare・Ollama・クラウド・デプロイ先）の一覧と、
 * OS ごとのインストール・ログインのコマンド（main・renderer・単体テストで共有する純粋なデータと関数）。
 *
 * 設定の「CLI」の一覧と、判定モデル・文字起こし・整理の「Agent に設定を頼む」から使う。
 * ボタンを押すと内蔵ターミナルの新しいタブでこの表のコマンドをそのまま走らせる。
 * 画面や外部から受け取った文字をコマンドに混ぜない（引数はすべてこの表の固定の文字列。シェル注入にならない）。
 *
 * コマンドは 2026-10 に各公式ドキュメントで確かめた（homepageUrl）。公式が1行の手順を出していない OS は省く
 * （その OS ではコマンドを出さず、公式ページへのリンクだけにする）。
 * Windows の内蔵ターミナルは cmd.exe なので、PowerShell の手順は powershell -Command で包む。
 */

export type CliToolId =
  | 'gh'
  | 'glab'
  | 'wrangler'
  | 'ollama'
  | 'stripe'
  | 'gcloud'
  | 'aws'
  | 'az'
  | 'vercel'
  | 'netlify'
  | 'supabase'
  | 'firebase'
  | 'flyctl'
  | 'heroku'
  | 'railway'
  | 'docker'

export type CliToolCategory = 'git' | 'ai' | 'cloud' | 'deploy'

export interface CliToolEntry {
  label: string
  category: CliToolCategory
  /** PATH 上にあればインストール済みとみなすコマンド */
  detectCmd: string
  /** 同じ CLI の別名（fly など） */
  aliases?: readonly string[]
  /** 版を出す引数（1つ）。出力の最初の版らしい数字を読む */
  versionArg: string
  /** OS ごとの公式の入れ方（1行）。無い OS は公式ページへのリンクだけ */
  install: Partial<Record<'darwin' | 'linux' | 'win32', string>>
  /** ログイン（ブラウザで認証する対話のコマンド）。要らないものは無し */
  login?: string
  /** PATH に入っていないことがある公式のインストール先（ホームからの相対） */
  homeBinDirs?: readonly string[]
  /** 公式の入れ方のページ */
  homepageUrl: string
}

const npm = (pkg: string) => `npm install -g ${pkg}`
/** cmd.exe から PowerShell の1行を走らせる（公式の手順が PowerShell のもの） */
const powershell = (script: string) => `powershell -NoProfile -ExecutionPolicy Bypass -Command "${script}"`
const allOs = (command: string) => ({ darwin: command, linux: command, win32: command })
/**
 * Linux は利用者のシェル（fish のこともある）に関係なく動くよう bash -c で包み、入っているパッケージ管理で分ける。
 * 中身は単一引用符で包むので、中に単一引用符を書かない（括弧などは \ でエスケープする）
 */
const bashBranches = (branches: ReadonlyArray<readonly [test: string, command: string]>, fallback: string) =>
  `bash -c '${branches.map(([test, command], i) => `${i === 0 ? 'if' : 'elif'} ${test}; then ${command}`).join('; ')}; else ${fallback}; fi'`
const has = (bin: string) => `type -p ${bin} >/dev/null`

/**
 * gh の Linux（github.com/cli/cli/blob/trunk/docs/install_linux.md、2026-10 確認）。
 * Homebrew があればそれ、無ければ公式の apt の手順・dnf（dnf5 と dnf4 の両方）の手順
 */
const GH_LINUX = bashBranches([
  [has('brew'), 'brew install gh'],
  [has('apt'), '(type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y))'
    + ' && sudo mkdir -p -m 755 /etc/apt/keyrings'
    + ' && out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg'
    + ' && cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null'
    + ' && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg'
    + ' && sudo mkdir -p -m 755 /etc/apt/sources.list.d'
    + ' && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main"'
    + ' | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null'
    + ' && sudo apt update && sudo apt install gh -y'],
  [has('dnf'), '(sudo dnf install -y dnf5-plugins && sudo dnf config-manager addrepo --from-repofile=https://cli.github.com/packages/rpm/gh-cli.repo'
    + ' || (sudo dnf install -y dnf-command\\(config-manager\\) && sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo))'
    + ' && sudo dnf install -y gh']
], 'echo "See https://github.com/cli/cli/blob/trunk/docs/install_linux.md" && false')

/**
 * glab の Linux（gitlab.com/gitlab-org/cli/-/blob/main/docs/installation_options.md、2026-10 確認）。
 * 公式に支えるのは Homebrew。無ければ同じページに載る snap・dnf・pacman
 */
const GLAB_LINUX = bashBranches([
  [has('brew'), 'brew install glab'],
  [has('snap'), 'sudo snap install glab'],
  [has('dnf'), 'sudo dnf install -y glab'],
  [has('pacman'), 'sudo pacman -S --noconfirm glab']
], 'echo "See https://gitlab.com/gitlab-org/cli/-/releases" && false')

/** 一覧の順（種類ごと、よく使うものを先に） */
export const CLI_TOOL_IDS: readonly CliToolId[] = [
  'gh', 'glab',
  'wrangler', 'ollama',
  'vercel', 'netlify', 'supabase', 'firebase', 'flyctl', 'railway', 'heroku',
  'stripe', 'gcloud', 'aws', 'az', 'docker'
]

export const CLI_TOOLS: Record<CliToolId, CliToolEntry> = {
  gh: {
    label: 'GitHub CLI', category: 'git', detectCmd: 'gh', versionArg: '--version',
    // github.com/cli/cli#installation
    install: { darwin: 'brew install gh', linux: GH_LINUX, win32: 'winget install --id GitHub.cli -e' },
    login: 'gh auth login --web -h github.com',
    homepageUrl: 'https://github.com/cli/cli#installation'
  },
  glab: {
    label: 'GitLab CLI', category: 'git', detectCmd: 'glab', versionArg: 'version',
    // gitlab.com/gitlab-org/cli（Homebrew が公式に支える入れ方。Windows は winget）
    install: { darwin: 'brew install glab', linux: GLAB_LINUX, win32: 'winget install --id glab.glab -e' },
    login: 'glab auth login',
    homepageUrl: 'https://gitlab.com/gitlab-org/cli#installation'
  },
  wrangler: {
    label: 'Cloudflare Wrangler', category: 'ai', detectCmd: 'wrangler', versionArg: '--version',
    // npm のパッケージ（Cloudflare の資料はプロジェクトごとの導入を勧めるが、Account ID を調べる・ログインする用途には全体に入れる）
    install: allOs(npm('wrangler')),
    login: 'wrangler login',
    homepageUrl: 'https://developers.cloudflare.com/workers/wrangler/install-and-update/'
  },
  ollama: {
    label: 'Ollama', category: 'ai', detectCmd: 'ollama', versionArg: '--version',
    // ollama.com/download/mac・linux・windows
    install: {
      darwin: 'curl -fsSL https://ollama.com/install.sh | sh',
      linux: 'curl -fsSL https://ollama.com/install.sh | sh',
      win32: powershell('irm https://ollama.com/install.ps1 | iex')
    },
    homepageUrl: 'https://ollama.com/download'
  },
  vercel: {
    label: 'Vercel CLI', category: 'deploy', detectCmd: 'vercel', versionArg: '--version',
    install: allOs(npm('vercel')), login: 'vercel login', homepageUrl: 'https://vercel.com/docs/cli'
  },
  netlify: {
    label: 'Netlify CLI', category: 'deploy', detectCmd: 'netlify', versionArg: '--version',
    install: allOs(npm('netlify-cli')), login: 'netlify login',
    homepageUrl: 'https://docs.netlify.com/api-and-cli-guides/cli-guides/get-started-with-cli/'
  },
  supabase: {
    label: 'Supabase CLI', category: 'deploy', detectCmd: 'supabase', versionArg: '--version',
    // supabase.com/docs/guides/local-development/cli/getting-started（Windows は Scoop）
    install: {
      darwin: 'brew install supabase/tap/supabase',
      linux: 'brew install supabase/tap/supabase',
      win32: 'scoop bucket add supabase https://github.com/supabase/scoop-bucket.git && scoop install supabase'
    },
    login: 'supabase login',
    homepageUrl: 'https://supabase.com/docs/guides/local-development/cli/getting-started'
  },
  firebase: {
    label: 'Firebase CLI', category: 'deploy', detectCmd: 'firebase', versionArg: '--version',
    install: allOs(npm('firebase-tools')), login: 'firebase login', homepageUrl: 'https://firebase.google.com/docs/cli'
  },
  flyctl: {
    label: 'Fly.io (flyctl)', category: 'deploy', detectCmd: 'flyctl', aliases: ['fly'], versionArg: 'version',
    // fly.io/docs/flyctl/install（スクリプトは ~/.fly/bin に入れる）
    install: {
      darwin: 'curl -L https://fly.io/install.sh | sh',
      linux: 'curl -L https://fly.io/install.sh | sh',
      win32: powershell('iwr https://fly.io/install.ps1 -useb | iex')
    },
    login: 'flyctl auth login',
    homeBinDirs: ['.fly/bin'],
    homepageUrl: 'https://fly.io/docs/flyctl/install/'
  },
  railway: {
    label: 'Railway CLI', category: 'deploy', detectCmd: 'railway', versionArg: '--version',
    install: allOs(npm('@railway/cli')), login: 'railway login', homepageUrl: 'https://docs.railway.com/guides/cli'
  },
  heroku: {
    label: 'Heroku CLI', category: 'deploy', detectCmd: 'heroku', versionArg: '--version',
    // devcenter.heroku.com/articles/heroku-cli（Windows は公式が支える npm）
    install: {
      darwin: 'brew install heroku/brew/heroku',
      linux: 'curl https://cli-assets.heroku.com/install.sh | sh',
      win32: npm('heroku')
    },
    login: 'heroku login',
    homepageUrl: 'https://devcenter.heroku.com/articles/heroku-cli'
  },
  stripe: {
    label: 'Stripe CLI', category: 'cloud', detectCmd: 'stripe', versionArg: '--version',
    // docs.stripe.com/stripe-cli/install は npm を案内し、github.com/stripe/stripe-cli#installation は macOS に Homebrew・
    // Windows に WinGet を挙げる（2026-10 確認）。Linux の apt・yum は複数行の手順なので npm
    install: { darwin: 'brew install stripe', linux: npm('@stripe/cli'), win32: 'winget install --id Stripe.StripeCLI -e' },
    login: 'stripe login',
    homepageUrl: 'https://docs.stripe.com/stripe-cli/install'
  },
  gcloud: {
    label: 'Google Cloud CLI', category: 'cloud', detectCmd: 'gcloud', versionArg: '--version',
    // docs.cloud.google.com/sdk/docs/downloads-interactive（Windows は公式のインストーラを落として開く）
    install: {
      darwin: 'curl https://sdk.cloud.google.com | bash',
      linux: 'curl https://sdk.cloud.google.com | bash',
      win32: powershell("$f = Join-Path $env:Temp 'GoogleCloudSDKInstaller.exe'; (New-Object Net.WebClient).DownloadFile('https://dl.google.com/dl/cloudsdk/channels/rapid/GoogleCloudSDKInstaller.exe', $f); & $f")
    },
    login: 'gcloud auth login',
    homeBinDirs: ['google-cloud-sdk/bin'],
    homepageUrl: 'https://cloud.google.com/sdk/docs/install'
  },
  aws: {
    label: 'AWS CLI', category: 'cloud', detectCmd: 'aws', versionArg: '--version',
    // docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html（公式が勧めるインストールスクリプト）
    install: {
      darwin: 'curl -fsSL https://awscli.amazonaws.com/v2/install.sh | bash',
      linux: 'curl -fsSL https://awscli.amazonaws.com/v2/install.sh | bash',
      win32: powershell('irm https://awscli.amazonaws.com/v2/install.ps1 | iex')
    },
    // コンソールの資格情報でログインする（AWS CLI 2.32 以降）
    login: 'aws login',
    homepageUrl: 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html'
  },
  az: {
    label: 'Azure CLI', category: 'cloud', detectCmd: 'az', versionArg: '--version',
    // learn.microsoft.com/cli/azure/install-azure-cli（Linux の1行は Debian / Ubuntu 向け）
    install: {
      darwin: 'brew install azure-cli',
      linux: "curl -fsSL 'https://azurecliprod.blob.core.windows.net/$root/deb_install.sh' | sudo bash",
      win32: 'winget install --exact --id Microsoft.AzureCLI'
    },
    login: 'az login',
    homepageUrl: 'https://learn.microsoft.com/en-us/cli/azure/install-azure-cli'
  },
  docker: {
    label: 'Docker', category: 'cloud', detectCmd: 'docker', versionArg: '--version',
    // docs.docker.com。macOS・Windows は Docker Desktop のインストーラ（1行の公式手順が無い）。Linux は公式の便利スクリプト
    install: { linux: 'curl -fsSL https://get.docker.com -o get-docker.sh && sudo sh get-docker.sh' },
    homepageUrl: 'https://docs.docker.com/get-started/get-docker/'
  }
}

export function isCliToolId(value: unknown): value is CliToolId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CLI_TOOLS, value)
}

function osKey(platform: PlatformName): 'darwin' | 'linux' | 'win32' {
  return platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux'
}

/** その OS のインストールコマンド。公式の1行の手順が無ければ undefined（公式ページへのリンクだけを出す） */
export function cliInstallCommand(id: CliToolId, platform: PlatformName): string | undefined {
  return CLI_TOOLS[id].install[osKey(platform)]?.trim() || undefined
}

/** ログインのコマンド（OS に関係ない）。要らないものは undefined */
export function cliLoginCommand(id: CliToolId): string | undefined {
  return CLI_TOOLS[id].login?.trim() || undefined
}

/** 検出に使うコマンド名（本体と別名） */
export function cliDetectCommands(id: CliToolId): string[] {
  const entry = CLI_TOOLS[id]
  return [entry.detectCmd, ...(entry.aliases ?? [])]
}

/** `<cli> --version` の出力から版（2.32.0 など）を読む。読めなければ null */
export function parseCliVersion(output: string): string | null {
  const match = /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/.exec(output)
  return match ? match[1]! : null
}

/** 検出の結果（main の cliTools:list が返す） */
export interface CliToolStatus {
  id: CliToolId
  installed: boolean
  /** 版（読めなければ null） */
  version: string | null
}

/**
 * この表のどれかのインストールコマンドか（全 OS）。E2E では本物を走らせないよう main がこれで見分けて差し替える
 */
export function isKnownCliInstallCommand(command: string): boolean {
  const line = command.trim()
  if (!line) return false
  return CLI_TOOL_IDS.some((id) => Object.values(CLI_TOOLS[id].install).some((c) => c?.trim() === line))
}

/** 設定の画面の「インストール」リンク（判定モデルの Ollama など）の URL に当たる CLI。無ければ null */
export function cliToolForInstallUrl(url: string | undefined): CliToolId | null {
  if (!url) return null
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    if (host === 'ollama.com') return 'ollama'
  } catch {
    // URL でない（想定内。リンクのまま）
  }
  return null
}
