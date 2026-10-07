/**
 * プロジェクトの右クリックの「GitHub で private リポジトリを作る」（src/main/github/createRepo.ts）の純粋な部分。
 * main と画面の両方が読む。
 *
 * - 作るリポジトリは必ず private（ここで組み立てる gh の引数は --private だけを付ける）
 * - 置き場（owner）は設定の github.defaultOwner か、自分のアカウント・所属する組織から選ぶ
 * - 最初のコミットには、.gitignore の対象と、秘密を含みうるファイル（.env・鍵など）を入れない
 */

/** settings.json の github */
export interface GithubPreferences {
  /** 新しいリポジトリを作る既定の置き場（自分のアカウント名か組織名）。省略時は自分のアカウント */
  defaultOwner?: string
}

/** GitHub のユーザー名・組織名（英数字とハイフン、先頭と末尾はハイフン以外、39字まで） */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

export function isValidOwner(value: unknown): value is string {
  return typeof value === 'string' && OWNER.test(value)
}

export function sanitizeGithubPreferences(raw: unknown): GithubPreferences | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const owner = (raw as Record<string, unknown>).defaultOwner
  return isValidOwner(owner) ? { defaultOwner: owner } : undefined
}

/** リポジトリ名に使える文字（GitHub の決まり: 英数字・. _ -、100字まで、. と .. だけは不可） */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/

export function isValidRepoName(value: unknown): value is string {
  return typeof value === 'string' && REPO_NAME.test(value) && value !== '.' && value !== '..' && !value.endsWith('.git')
}

/**
 * フォルダ名から既定のリポジトリ名を作る。使えない文字（空白・日本語など）は - にし、続いた - は1つにまとめ、
 * 先頭と末尾の - . を落とす。何も残らなければ project
 */
export function suggestRepoName(folderName: string): string {
  const name = folderName
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .replace(/\.git$/i, '')
    .slice(0, 100)
    .replace(/[-.]+$/g, '')
  return isValidRepoName(name) ? name : 'project'
}

/** 雛形として配る .env（中身は秘密でない） */
const ENV_TEMPLATE = /\.(example|sample|template|dist|defaults?|schema)$/i
/** 名前だけで秘密を含みうると分かるもの（パスの最後の部分で見る） */
const SECRET_NAMES: readonly RegExp[] = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|p8|ppk|asc|gpg|kdbx)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.?(netrc|npmrc|pypirc|htpasswd)$/i,
  /^credentials(\.json)?$/i,
  /^(service[-_]?account|client[-_]secret)[^/]*\.json$/i,
  /^secrets?\.(json|ya?ml|toml|env|txt)$/i,
  /\.tfstate(\.backup)?$/i
]

/**
 * 最初のコミットから外すファイルか（.env・鍵・認証情報の形）。.env.example などの雛形と、
 * 公開鍵（id_*.pub）は入れてよいが、公開鍵は id_rsa と並べて置くことが多いので一緒に外す
 */
export function isSecretLikePath(relPath: string): boolean {
  const name = relPath.split('/').pop() ?? relPath
  if (/^\.env(\..+)?$/i.test(name) && ENV_TEMPLATE.test(name)) return false
  return SECRET_NAMES.some((pattern) => pattern.test(name))
}

/** 最初のコミットに入れるもの（.gitignore の対象を除いた一覧から、秘密を含みうるものを外す） */
export function splitInitialCommitFiles(files: readonly string[]): { included: string[]; excluded: string[] } {
  const included: string[] = []
  const excluded: string[] = []
  for (const file of files) (isSecretLikePath(file) ? excluded : included).push(file)
  return { included, excluded }
}

/** 画面に出す下調べの結果（main の repoCreateInfo） */
export interface RepoCreateInfo {
  /** gh が入っていて、ログインしているか。違えば reason に理由（画面に出す文） */
  ready: boolean
  reason?: string
  /** 自分のアカウント名と、所属する組織（置き場の候補） */
  login: string | null
  orgs: string[]
  /** 既定の置き場（設定の defaultOwner。候補に無ければ自分のアカウント） */
  defaultOwner: string | null
  suggestedName: string
  /** フォルダが git のリポジトリか・コミットがあるか・origin があるか */
  isGit: boolean
  hasCommits: boolean
  hasOrigin: boolean
  /** コミットが無いとき、最初のコミットに入るファイルの数と、外す秘密らしいファイル（最大 20 件の名前） */
  initialFiles: number
  excludedSecrets: string[]
}

export interface RepoCreateRequest {
  owner: string
  name: string
  description?: string
  /** コミットが無いとき、最初のコミットを作って push するか */
  initialCommit: boolean
}

export interface RepoCreateResult {
  /** 作ったリポジトリの URL（https://github.com/<owner>/<name>） */
  url: string
  /** push したか */
  pushed: boolean
  /** 最初のコミットから外したファイルの数 */
  excluded: number
}

/** 説明は1行・350字まで（GitHub の上限） */
export function sanitizeDescription(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 350) : ''
}

/**
 * gh repo create の引数。必ず --private。--source でこのフォルダを origin につなぎ、push するときだけ --push。
 * 値は配列で渡し、シェルを通さない
 */
export function buildRepoCreateArgs(request: { owner: string; name: string; description?: string }, folder: string, push: boolean): string[] {
  if (!isValidOwner(request.owner)) throw new Error('invalid owner')
  if (!isValidRepoName(request.name)) throw new Error('invalid repository name')
  const description = sanitizeDescription(request.description)
  return [
    'repo', 'create', `${request.owner}/${request.name}`,
    '--private',
    '--source', folder,
    '--remote', 'origin',
    ...(description ? ['--description', description] : []),
    ...(push ? ['--push'] : [])
  ]
}
