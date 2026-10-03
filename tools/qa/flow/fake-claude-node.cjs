#!/usr/bin/env node
/**
 * 通し確認（tools/qa/flow-check.mjs --claude-node）用の偽の Claude Code。npm 版と同じく node で動く。
 * 本物と同じく MCP サーバーとして codex を子に起動するので、「子孫に Agent が2種類いる」状況を再現できる。
 * 受け取った入力は FAKE_AGENT_LOG に追記する。
 */
// 拡張子なしの「claude」として置くので CommonJS で書く（import は使えない）
const { spawn } = require('node:child_process')
const { appendFileSync } = require('node:fs')

// 本物の MCP サーバーの代わり（偽の codex を「mcp-server」で起動して置いておくだけ）
const mcp = spawn('codex', ['mcp-server'], { stdio: 'ignore' })
const log = process.env.FAKE_AGENT_LOG
const out = (s) => process.stdout.write(s)
const prompt = '\r\n❯ \r\n'

process.stdin.setRawMode?.(true)
out('\x1b]0;✳ Claude Code\x07')
out('Claude Code (fake npm/node for QA)\r\n\x1b[?2004h\x1b[?25h')
out(prompt)
process.stdin.on('data', (buf) => {
  const text = buf.toString('utf8')
  if (log) appendFileSync(log, `claude:${text}\n`)
  if (text.includes('\x03') || text.includes('\x04')) {
    mcp.kill()
    process.exit(0)
  }
  if (text.includes('\r')) out(`\r\n(received)${prompt}`)
})
