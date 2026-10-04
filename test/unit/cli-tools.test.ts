import { describe, expect, it } from 'vitest'
import {
  CLI_TOOL_IDS,
  CLI_TOOLS,
  cliDetectCommands,
  cliInstallCommand,
  cliLoginCommand,
  cliToolForInstallUrl,
  isKnownCliInstallCommand,
  parseCliVersion
} from '@shared/cliTools'

describe('CLI の一覧', () => {
  it('一覧の順に全部が並び、重なりが無い', () => {
    expect(new Set(CLI_TOOL_IDS).size).toBe(CLI_TOOL_IDS.length)
    expect([...CLI_TOOL_IDS].sort()).toEqual(Object.keys(CLI_TOOLS).sort())
  })

  it('案内のページは https', () => {
    for (const id of CLI_TOOL_IDS) expect(CLI_TOOLS[id].homepageUrl).toMatch(/^https:\/\//)
  })

  it('コマンドは1行で、改行や外から差し込む場所（{{…}}・${…} の展開）を持たない', () => {
    for (const id of CLI_TOOL_IDS) {
      const commands = [...Object.values(CLI_TOOLS[id].install), CLI_TOOLS[id].login].filter((c): c is string => !!c)
      for (const command of commands) {
        expect(command).not.toMatch(/[\r\n]/)
        expect(command).not.toMatch(/\{\{|\$\{|`/)
      }
    }
  })
})

describe('OS ごとのインストールコマンド', () => {
  it('gh は macOS が Homebrew、Linux は Homebrew か公式の apt / dnf、Windows が winget', () => {
    expect(cliInstallCommand('gh', 'darwin')).toBe('brew install gh')
    const linux = cliInstallCommand('gh', 'linux') ?? ''
    expect(linux.startsWith("bash -c 'if type -p brew >/dev/null; then brew install gh; elif type -p apt")).toBe(true)
    expect(linux).toContain('https://cli.github.com/packages')
    expect(linux).toContain('sudo dnf install -y gh')
    // 単一引用符で包むので、中に単一引用符が無い
    expect(linux.slice("bash -c '".length, -1)).not.toContain("'")
    expect(cliInstallCommand('gh', 'win32')).toBe('winget install --id GitHub.cli -e')
  })

  it('npm のものは OS に関係なく同じ', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(cliInstallCommand('wrangler', platform)).toBe('npm install -g wrangler')
      expect(cliInstallCommand('vercel', platform)).toBe('npm install -g vercel')
      expect(cliInstallCommand('firebase', platform)).toBe('npm install -g firebase-tools')
    }
  })

  it('Windows の PowerShell の手順は cmd.exe から動くよう powershell -Command で包む', () => {
    expect(cliInstallCommand('ollama', 'win32')).toBe('powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://ollama.com/install.ps1 | iex"')
    expect(cliInstallCommand('aws', 'win32')).toMatch(/^powershell .* -Command "irm https:\/\/awscli\.amazonaws\.com\/v2\/install\.ps1 \| iex"$/)
    for (const id of CLI_TOOL_IDS) {
      const command = cliInstallCommand(id, 'win32')
      if (!command) continue
      // POSIX のシェルや Homebrew の手順を Windows に出さない
      expect(command).not.toMatch(/\|\s*(ba|z)?sh\b|^brew\s/)
    }
  })

  it('macOS・Linux は公式のスクリプト（Ollama・AWS）', () => {
    expect(cliInstallCommand('ollama', 'darwin')).toBe('curl -fsSL https://ollama.com/install.sh | sh')
    expect(cliInstallCommand('aws', 'linux')).toBe('curl -fsSL https://awscli.amazonaws.com/v2/install.sh | bash')
  })

  it('公式の1行の手順が無い OS は undefined（リンクだけ）', () => {
    expect(cliInstallCommand('docker', 'darwin')).toBeUndefined()
    expect(cliInstallCommand('docker', 'win32')).toBeUndefined()
    expect(cliInstallCommand('docker', 'linux')).toMatch(/get\.docker\.com/)
  })

  it('Linux 以外の Unix は Linux の手順を使う', () => {
    expect(cliInstallCommand('gh', 'freebsd')).toBe(cliInstallCommand('gh', 'linux'))
  })
})

describe('ログインと検出', () => {
  it('ログインのコマンド（Ollama・Docker は無し）', () => {
    expect(cliLoginCommand('gh')).toBe('gh auth login --web -h github.com')
    expect(cliLoginCommand('glab')).toBe('glab auth login')
    expect(cliLoginCommand('wrangler')).toBe('wrangler login')
    expect(cliLoginCommand('ollama')).toBeUndefined()
    expect(cliLoginCommand('docker')).toBeUndefined()
  })

  it('別名も検出に使う', () => {
    expect(cliDetectCommands('flyctl')).toEqual(['flyctl', 'fly'])
    expect(cliDetectCommands('gh')).toEqual(['gh'])
  })
})

describe('parseCliVersion', () => {
  it('よくある出力から版を読む', () => {
    expect(parseCliVersion('gh version 2.81.0 (2026-09-01)\nhttps://github.com/cli/cli/releases/tag/v2.81.0')).toBe('2.81.0')
    expect(parseCliVersion(' ⛅️ wrangler 4.42.0\n')).toBe('4.42.0')
    expect(parseCliVersion('aws-cli/2.32.1 Python/3.13.7 Darwin/25.0.0 exe/arm64')).toBe('2.32.1')
    expect(parseCliVersion('ollama version is 0.12.3')).toBe('0.12.3')
    expect(parseCliVersion('flyctl v0.3.190 darwin/arm64 Commit: abc')).toBe('0.3.190')
    expect(parseCliVersion('Google Cloud SDK 540.0.0\nbq 2.1.22')).toBe('540.0.0')
  })

  it('版が無ければ null', () => {
    expect(parseCliVersion('')).toBeNull()
    expect(parseCliVersion('command not found')).toBeNull()
  })
})

describe('isKnownCliInstallCommand（E2E で本物を走らせないための見分け）', () => {
  it('表のインストールコマンドだけ true', () => {
    expect(isKnownCliInstallCommand('brew install gh')).toBe(true)
    expect(isKnownCliInstallCommand('  npm install -g wrangler  ')).toBe(true)
    expect(isKnownCliInstallCommand(cliInstallCommand('ollama', 'win32')!)).toBe(true)
    expect(isKnownCliInstallCommand('gh auth login --web -h github.com')).toBe(false)
    expect(isKnownCliInstallCommand('ls')).toBe(false)
    expect(isKnownCliInstallCommand('')).toBe(false)
  })
})

describe('cliToolForInstallUrl', () => {
  it('Ollama のダウンロードページは ollama の CLI に当てる', () => {
    expect(cliToolForInstallUrl('https://ollama.com/download')).toBe('ollama')
    expect(cliToolForInstallUrl('https://www.ollama.com/download')).toBe('ollama')
  })

  it('当てられないものは null（リンクのまま）', () => {
    expect(cliToolForInstallUrl('https://lmstudio.ai/download')).toBeNull()
    expect(cliToolForInstallUrl('https://evil.example/ollama.com')).toBeNull()
    expect(cliToolForInstallUrl('not a url')).toBeNull()
    expect(cliToolForInstallUrl(undefined)).toBeNull()
  })
})

describe('setupCliTool（AI の接続先の欄に出す CLI）', () => {
  it('Account ID が要る Cloudflare は wrangler、端末内の Ollama は ollama、ほかは無し', async () => {
    const { setupCliTool } = await import('@shared/cliSetup')
    expect(setupCliTool({ needsAccountId: true })).toBe('wrangler')
    expect(setupCliTool({ local: true, installUrl: 'https://ollama.com/download' })).toBe('ollama')
    expect(setupCliTool({ local: true, installUrl: 'https://lmstudio.ai/download' })).toBeNull()
    expect(setupCliTool({})).toBeNull()
  })
})

describe('runCliAction（ボタンから内蔵ターミナルへ）', () => {
  it('ターミナルが受け取れば、その OS のカタログのコマンドとタブ名を渡す', async () => {
    const { runCliAction } = await import('../../src/renderer/lib/cliTools')
    const requests: Array<{ command: string; title?: string }> = []
    const r = await runCliAction('wrangler', 'login', 'Sign in: Wrangler', { request: (req) => { requests.push(req); return true }, platform: 'darwin' })
    expect(r).toEqual({ result: 'terminal', command: 'wrangler login' })
    expect(requests).toEqual([{ command: 'wrangler login', title: 'Sign in: Wrangler' }])
    const w = await runCliAction('gh', 'install', 'x', { request: () => true, platform: 'win32' })
    expect(w.command).toBe('winget install --id GitHub.cli -e')
  })

  it('ターミナルが無ければコマンドを写す。写せなければ failed', async () => {
    const { runCliAction } = await import('../../src/renderer/lib/cliTools')
    const copied: string[] = []
    expect(await runCliAction('gh', 'install', 'x', { request: () => false, copy: async (t) => { copied.push(t) }, platform: 'darwin' }))
      .toEqual({ result: 'copied', command: 'brew install gh' })
    expect(copied).toEqual(['brew install gh'])
    expect((await runCliAction('gh', 'install', 'x', { request: () => false, copy: async () => { throw new Error('denied') }, platform: 'darwin' })).result).toBe('failed')
  })

  it('その OS にコマンドが無ければ何も送らない', async () => {
    const { runCliAction } = await import('../../src/renderer/lib/cliTools')
    let called = false
    const r = await runCliAction('docker', 'install', 'x', { request: () => { called = true; return true }, platform: 'darwin' })
    expect(r.result).toBe('failed')
    expect(called).toBe(false)
    expect((await runCliAction('ollama', 'login', 'x', { request: () => { called = true; return true } })).result).toBe('failed')
    expect(called).toBe(false)
  })
})
