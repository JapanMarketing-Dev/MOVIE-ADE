/*
 * 通し確認（tools/qa/flow-check.mjs）用の偽の Claude Code / Codex。
 *
 * 本物はログインが要るので使わない。本物と同じ見え方だけを真似る:
 * - claude: 公式インストーラと同じく ~/.local/share/claude/versions/<版> の実体を
 *   claude というシンボリックリンクから起動する（前面プロセス名が「2.1.288」のような版番号になる）。
 *   タイトル「✳ Claude Code」と入力欄「❯」を出す。
 * - codex: 入力欄「› Ask Codex to do anything」を出す。
 * 受け取った入力はそのまま FAKE_AGENT_LOG のファイルへ追記する（送られた本文を検査するため）。
 */
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
        out("\r\n(received)");
        out(prompt);
      }
    }
  }
  return 0;
}
