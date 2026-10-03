/**
 * 実際の `claude`（2.1.287）と `codex`（0.155.1）を pty で起動して採取した出力。
 * 2026-10-02、各1回だけ起動。APIキーの環境変数は掃除して実行した。
 *
 * **そのまま貼ってある。** 単語の区切りに空白が無く、カーソル移動（`\x1b[8G` など）で
 * 桁を動かしているのが要点で、整形の仕方を変えるとここで気づける。
 */

/** claude: 起動直後のフォルダ信頼ダイアログ（＝権限の確認待ち） */
export const CLAUDE_TRUST_DIALOG = "here.\r\r\n\r\r\n\u001b[2G\u001b]8;id=zaxmda;https://code.claude.com/docs/en/security\u0007\u001b[38;2;153;153;153mSecurity guide\u001b[39m\u001b]8;;\u0007\r\r\n\r\r\n\u001b[2G\u001b[38;2;177;185;249m❯\u001b[4GNo,\u001b[8Gexit\u001b[39m\r\r\n\u001b[4GYes,\u001b[9GI\u001b[11Gtrust\u001b[17Gthis\u001b[22Gfolder\r\r\n\r\r\n\u001b[2G\u001b[38;2;153;153;153mEnter\u001b[8Gto\u001b[11Gconfirm\u001b[19G·\u001b[21GEsc\u001b[25Gto\u001b[28Gcancel\u001b[39m\r\r\n\u001b[1C\u001b[4A\u001b[?2026l\u001b[>0q\u001b[?u\u001b[c"

/** codex: 起動直後の更新メニュー（Enter を取られるので送ってはいけない） */
export const CODEX_UPDATE_MENU = "\u001b]8;;https://github.com/openai/codex/releases/latest\u0007https://github.com/openai/codex/releases/latest\u001b]8;;\u0007\u001b[6;1H\u001b[24m\u001b[22m\u001b[38;5;6;49m› 1. Update now (runs `npm install -g @openai/codex`)\u001b[7;3H\u001b[39;49m2.\u001b[7;6HSkip\u001b[8;3H3.\u001b[8;6HSkip\u001b[8;11Huntil\u001b[8;17Hnext\u001b[8;22Hversion\u001b[10;3H\u001b[2mPress enter to continue\u001b[39m\u001b[49m\u001b[0m\u001b[?25l\u001b[?2026l"

/** claude: 起動直後の先頭。準備完了のしるしを含む */
export const CLAUDE_STARTUP_HEAD = "\u001b7\u001b[r\u001b8\u001b[?25h\u001b[?25l\u001b[?2004h\u001b[?2031h\u001b[?1004h\u001b[?2026h\r\r\n\u001b[38;2;255;193;7m────────────────────────────────────────────────────────────────────────────────────────────────────\u001b[39m\r\r\n\u001b[2G\u001b[38;2;255;193;7m"

/** codex: 起動直後の先頭 */
export const CODEX_STARTUP_HEAD = "\u001b[?2004h\u001b[>4;0m\u001b[>7u\u001b[?1004h\u001b[6n\u001b]10;?\u001b\\\u001b]11;?\u001b\\\u001b[?u\u001b[c\u001b[?2026h\u001b[1;1H\u001b[J\u001b[1;42H\u001b[0m\u001b[49m\u001b[K\u001b[2;42H\u001b[0m\u001b[49m\u001b[K\u001b[3;42H\u001b[0m\u001b[49m\u001b[K\u001b[4;42H\u001b[0m\u001b[49m\u001b[K\u001b[5;42H\u001b[0m\u001b[49m\u001b[K\u001b[6;42H\u001b[0m\u001b[49m\u001b[K\u001b[7;2H\u001b[0m\u001b[49"
