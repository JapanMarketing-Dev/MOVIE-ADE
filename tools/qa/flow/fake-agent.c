/*
 * 通し確認（tools/qa/flow-check.mjs）用の偽の Claude Code / Codex。
 *
 * 本物はログインが要るので使わない。本物と同じ見え方だけを真似る:
 * - claude: 公式インストーラと同じく ~/.local/share/claude/versions/<版> の実体を
 *   claude というシンボリックリンクから起動する（前面プロセス名が「2.1.288」のような版番号になる）。
 *   タイトル「✳ Claude Code」と入力欄「❯」を出す。
 * - codex: 入力欄「› Ask Codex to do anything」を出す。
 * 受け取った入力はそのまま FAKE_AGENT_LOG のファイルへ追記する（送られた本文を検査するため）。
 * 起動の引数も「<agent>-argv:」の行で追記する（上限での切り替えの、会話の再開の引数を検査するため）。
 * FAKE_AGENT_LIMITED に「codex:system」「codex:<アカウントの id>」「claude:*」のように並べたものは、
 * Enter を受け取るたびに、本物と同じ文言の上限の知らせを出す。アカウントは CODEX_HOME / CLAUDE_CONFIG_DIR が
 * 本システムの管理フォルダ（…/accounts/<agent>/<id>）ならその id、それ以外は system。
 * FAKE_AGENT_WRITE_HANDOFF=1 なら、「handoff.md」を含む依頼には上限の知らせを出さず、作業中のタイトルを出してから
 * 今のフォルダの .ferret/handoff.md を書き、待機に戻る（引き継ぎのファイルを自分で更新できる Agent の代わり）。
 */
#include <sys/stat.h>
#include <libgen.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>

static void out(const char *s) { (void)!write(1, s, strlen(s)); }

int main(int argc, char **argv) {
  char name[256];
  strncpy(name, argv[0], sizeof name - 1);
  name[sizeof name - 1] = 0;
  const char *base = basename(name);
  int codex = strstr(base, "codex") != NULL;
  /* gemini: Claude Code / Codex 以外の Agent の代わり。タイトルの「◇」で待機中を表す（Gemini CLI と同じ合図） */
  int gemini = strstr(base, "gemini") != NULL;
  const char *log = getenv("FAKE_AGENT_LOG");
  const char *kind = codex ? "codex" : gemini ? "gemini" : "claude";
  /* 上限の知らせを出すアカウントか */
  char account[256] = "system";
  const char *home = getenv(codex ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR");
  if (home && strstr(home, codex ? "/accounts/codex/" : "/accounts/claude/")) {
    char copy[1024];
    strncpy(copy, home, sizeof copy - 1);
    copy[sizeof copy - 1] = 0;
    strncpy(account, basename(copy), sizeof account - 1);
  }
  int limited = 0;
  const char *limits = getenv("FAKE_AGENT_LIMITED");
  if (limits) {
    char me[300], all[300];
    snprintf(me, sizeof me, "%s:%s", kind, account);
    snprintf(all, sizeof all, "%s:*", kind);
    char list[2048];
    strncpy(list, limits, sizeof list - 1);
    list[sizeof list - 1] = 0;
    for (char *tok = strtok(list, ","); tok; tok = strtok(NULL, ",")) {
      if (strcmp(tok, me) == 0 || strcmp(tok, all) == 0) limited = 1;
    }
  }
  /* claude が子に起動する MCP サーバーの代わり。何もせず居続ける */
  if (argc > 1 && strcmp(argv[1], "mcp-server") == 0) {
    for (;;) sleep(60);
  }

  struct termios raw;
  if (tcgetattr(0, &raw) == 0) {
    cfmakeraw(&raw);
    tcsetattr(0, TCSANOW, &raw);
  }

  const char *prompt = codex ? "\r\n\xe2\x80\xba Ask Codex to do anything\r\n" : gemini ? "\r\n> Type your message\r\n" : "\r\n\xe2\x9d\xaf \r\n";
  if (gemini) out("\x1b]0;\xe2\x97\x87  Ready (project)\x07");
  else if (!codex) out("\x1b]0;\xe2\x9c\xb3 Claude Code\x07");
  out(codex ? "OpenAI Codex (fake for QA)\r\n" : gemini ? "Gemini CLI (fake for QA)\r\n" : "Claude Code (fake for QA)\r\n");
  out("\x1b[?2004h\x1b[?25h");
  out(prompt);

  if (log) {
    FILE *f = fopen(log, "ab");
    if (f) {
      fprintf(f, "%s-argv:%s", kind, account);
      for (int i = 1; i < argc; i++) fprintf(f, " %s", argv[i]);
      fputc('\n', f);
      fclose(f);
    }
  }

  const char *limit_line = codex
    ? "\r\n\xe2\x96\xa0 You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again in 3 hours 2 minutes.\r\n"
    : gemini ? "\r\nQuota exceeded for quota metric 'Requests per day'\r\n"
    : "\r\n\xe2\x8e\xbf  5-hour limit reached \xe2\x88\x99 resets 3pm\r\n";

  int write_handoff = getenv("FAKE_AGENT_WRITE_HANDOFF") != NULL;
  char acc[65536];
  size_t acc_len = 0;

  char buf[4096];
  for (;;) {
    ssize_t n = read(0, buf, sizeof buf);
    if (n <= 0) break;
    if (log) {
      FILE *f = fopen(log, "ab");
      if (f) {
        fprintf(f, "%s:", codex ? "codex" : gemini ? "gemini" : "claude");
        fwrite(buf, 1, (size_t)n, f);
        fputc('\n', f);
        fclose(f);
      }
    }
    for (ssize_t i = 0; i < n; i++) {
      if (buf[i] == 3 || buf[i] == 4) return 0; /* Ctrl+C / Ctrl+D */
      if (buf[i] == '\r') {
        acc[acc_len] = 0;
        if (write_handoff && strstr(acc, "handoff.md")) {
          /* 作業中（スピナーのタイトル）→ ファイルを書く → 待機に戻る */
          out(codex ? "\x1b]0;\xe2\xa0\x8b Codex\x07" : "\x1b]0;\xe2\xa0\x8b Claude Code\x07");
          sleep(2);
          mkdir(".ferret", 0755);
          FILE *h = fopen(".ferret/handoff.md", "w");
          if (h) {
            fputs("# Handoff\n\n- [ ] remaining work (written by the fake agent)\n", h);
            fclose(h);
          }
          out(codex ? "\x1b]0;Codex\x07" : "\x1b]0;\xe2\x9c\xb3 Claude Code\x07");
          out("\r\n(updated handoff)");
        } else {
          out(limited ? limit_line : "\r\n(received)");
        }
        out(prompt);
        acc_len = 0;
      } else if (acc_len < sizeof acc - 1) {
        acc[acc_len++] = buf[i];
      }
    }
  }
  return 0;
}
