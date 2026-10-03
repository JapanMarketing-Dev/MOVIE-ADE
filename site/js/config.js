// サイトの設定。配布元を独自ドメインへ移すときは DOWNLOAD_BASE の1行だけを書き換える。

/** 配布ファイルと索引（versions.json / latest.json / releases/<version>/manifest.json）を置く Cloudflare R2 の公開 URL */
export const DOWNLOAD_BASE = 'https://pub-588d93b3e875464f98d6cf98dc711a0c.r2.dev'

/**
 * サイトの公開 URL（末尾の / なし）。og:image・og:url・canonical の絶対 URL はここから作る。
 * HTML はビルドしないので、書き換えたら `pnpm site:meta` で各ページの meta へ反映する（単体テストがずれを検出する）。
 */
export const SITE_URL = 'https://ferretade.dev'

export const REPO_URL = 'https://github.com/JapanMarketing-Dev/ferret'
