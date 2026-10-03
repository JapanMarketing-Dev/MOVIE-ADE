import { describe, expect, it, vi } from 'vitest'
import { exitWhenDoneCommand, installOutcome, requiredInstallTool } from '@shared/agentInstall'
import { AgentInstallController, isInstallBusy, type InstallDeps, type InstallState } from '../../src/renderer/onboarding/agentInstallController'
import { agentInstallCommand } from '../../src/renderer/onboarding/agentInstall'

/** PTY の代わり。create は呼ばれた順に id を返し、exit で終了を届ける */
function fakeDeps(options: { detected?: boolean; failCreate?: boolean } = {}) {
  let listener: ((ptyId: string, exitCode: number) => void) | null = null
  const pending: Array<(id: string) => void> = []
  let seq = 0
  const deps = {
    create: vi.fn((_command: string, _run: number) => options.failCreate
      ? Promise.reject(new Error('spawn failed'))
      : new Promise<string>((resolve) => pending.push(resolve))),
    close: vi.fn((_ptyId: string) => undefined),
    onExit: vi.fn((fn: (ptyId: string, exitCode: number) => void) => { listener = fn; return () => { listener = null } }),
    refresh: vi.fn(async () => options.detected ?? true)
  } satisfies InstallDeps
  return {
    deps,
    /** 作っている途中の create を終わらせる */
    async resolveCreate(): Promise<string> {
      const id = `pty${++seq}`
      pending.shift()?.(id)
      await flush()
      return id
    },
    exit(ptyId: string, code: number) { listener?.(ptyId, code) },
    get listening() { return listener !== null }
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('exitWhenDoneCommand（終わったらその終了コードでシェルを閉じる）', () => {
  it('zsh / bash は $?、fish は $status', () => {
    expect(exitWhenDoneCommand('npm i -g x', '/bin/zsh')).toBe('npm i -g x; exit $?')
    expect(exitWhenDoneCommand(' npm i -g x ', '/usr/local/bin/bash')).toBe('npm i -g x; exit $?')
    expect(exitWhenDoneCommand('npm i -g x', '/opt/homebrew/bin/fish')).toBe('npm i -g x; exit $status')
  })

  it('PowerShell と cmd.exe', () => {
    expect(exitWhenDoneCommand('npm i -g x', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toMatch(/^npm i -g x; if \(\$\?\) \{ exit 0 \}/)
    expect(exitWhenDoneCommand('npm i -g x', 'C:\\Windows\\System32\\cmd.exe')).toBe('npm i -g x & call exit %^errorlevel%')
  })
})

describe('installOutcome（終了コードの読み方）', () => {
  it('0 は成功、127 / 9009 は道具が無い、それ以外は失敗', () => {
    expect(installOutcome(0)).toBe('success')
    expect(installOutcome(127)).toBe('missingTool')
    expect(installOutcome(9009)).toBe('missingTool')
    expect(installOutcome(1)).toBe('failed')
    expect(installOutcome(null)).toBe('failed')
  })

  it('道具はコマンドの先頭の語', () => {
    expect(requiredInstallTool('  npm install -g @openai/codex')).toBe('npm')
    expect(requiredInstallTool('brew install aider')).toBe('brew')
  })
})

describe('AgentInstallController', () => {
  it('作っただけでは何も実行しない（自動では動かさない）', async () => {
    const fake = fakeDeps()
    const controller = new AgentInstallController('npm i -g x', fake.deps)
    await flush()
    expect(fake.deps.create).not.toHaveBeenCalled()
    expect(controller.state.phase).toBe('idle')
  })

  it('成功（exit 0）→ 検出し直し、見つかれば detected: true', async () => {
    const fake = fakeDeps({ detected: true })
    const states: InstallState[] = []
    const controller = new AgentInstallController('echo installing && exit 0', fake.deps, (s) => states.push(s))
    controller.start()
    expect(controller.state.phase).toBe('starting')
    expect(fake.deps.create).toHaveBeenCalledWith('echo installing && exit 0', 1)
    const id = await fake.resolveCreate()
    expect(controller.state).toMatchObject({ phase: 'running', ptyId: id })
    fake.exit(id, 0)
    expect(controller.state).toMatchObject({ phase: 'done', outcome: 'success', exitCode: 0, detected: null })
    await flush()
    expect(fake.deps.refresh).toHaveBeenCalledTimes(1)
    expect(controller.state).toMatchObject({ phase: 'done', detected: true })
    expect(states.map((s) => s.phase)).toEqual(['starting', 'running', 'done', 'done'])
  })

  it('成功しても PATH に見つからなければ detected: false', async () => {
    const fake = fakeDeps({ detected: false })
    const controller = new AgentInstallController('x', fake.deps)
    controller.start()
    const id = await fake.resolveCreate()
    fake.exit(id, 0)
    await flush()
    expect(controller.state).toMatchObject({ phase: 'done', outcome: 'success', detected: false })
  })

  it('失敗（exit 1）は検出し直さず、もう一度で次の実行になる', async () => {
    const fake = fakeDeps()
    const controller = new AgentInstallController('x', fake.deps)
    controller.start()
    const id = await fake.resolveCreate()
    fake.exit(id, 1)
    await flush()
    expect(controller.state).toMatchObject({ phase: 'done', outcome: 'failed', exitCode: 1 })
    expect(fake.deps.refresh).not.toHaveBeenCalled()
    controller.start()
    expect(controller.state).toMatchObject({ phase: 'starting', run: 2 })
  })

  it('道具が無い（exit 127）', async () => {
    const fake = fakeDeps()
    const controller = new AgentInstallController('npm i -g x', fake.deps)
    controller.start()
    fake.exit(await fake.resolveCreate(), 127)
    expect(controller.state).toMatchObject({ phase: 'done', outcome: 'missingTool' })
  })

  it('動いている間の start は無視する（1枚につき1つだけ）', async () => {
    const fake = fakeDeps()
    const controller = new AgentInstallController('x', fake.deps)
    controller.start()
    controller.start()
    await fake.resolveCreate()
    controller.start()
    expect(fake.deps.create).toHaveBeenCalledTimes(1)
    expect(isInstallBusy(controller.state)).toBe(true)
  })

  it('ほかの PTY の終了は無視する', async () => {
    const fake = fakeDeps()
    const controller = new AgentInstallController('x', fake.deps)
    controller.start()
    await fake.resolveCreate()
    fake.exit('someone-else', 0)
    expect(controller.state.phase).toBe('running')
  })

  it('作り終わる前に終了が届いても取りこぼさない（短いコマンド）', async () => {
    const fake = fakeDeps()
    const controller = new AgentInstallController('x', fake.deps)
    controller.start()
    fake.exit('pty1', 0)
    await fake.resolveCreate()
    expect(controller.state).toMatchObject({ phase: 'done', outcome: 'success' })
  })

  it('中止すると PTY を閉じ、あとから届く終了は無視する', async () => {
    const fake = fakeDeps()
    const controller = new AgentInstallController('x', fake.deps)
    controller.start()
    const id = await fake.resolveCreate()
    controller.cancel()
    expect(fake.deps.close).toHaveBeenCalledWith(id)
    expect(controller.state.phase).toBe('cancelled')
    fake.exit(id, 130)
    expect(controller.state.phase).toBe('cancelled')
    expect(fake.deps.refresh).not.toHaveBeenCalled()
  })

  it('作っている途中に中止したら、できた PTY をすぐ閉じる', async () => {
    const fake = fakeDeps()
    const controller = new AgentInstallController('x', fake.deps)
    controller.start()
    controller.cancel()
    const id = await fake.resolveCreate()
    expect(fake.deps.close).toHaveBeenCalledWith(id)
    expect(controller.state.phase).toBe('cancelled')
  })

  it('外す（dispose）と動いている PTY を閉じ、終了の購読もやめる', async () => {
    const fake = fakeDeps()
    const onChange = vi.fn()
    const controller = new AgentInstallController('x', fake.deps, onChange)
    controller.start()
    const id = await fake.resolveCreate()
    onChange.mockClear()
    controller.dispose()
    expect(fake.deps.close).toHaveBeenCalledWith(id)
    expect(fake.listening).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
    controller.start()
    expect(fake.deps.create).toHaveBeenCalledTimes(1)
  })

  it('作っている途中に外されたら、できた PTY を閉じる', async () => {
    const fake = fakeDeps()
    const controller = new AgentInstallController('x', fake.deps)
    controller.start()
    controller.dispose()
    const id = await fake.resolveCreate()
    expect(fake.deps.close).toHaveBeenCalledWith(id)
  })

  it('シェルを作れなければ error（もう一度押せる）', async () => {
    const fake = fakeDeps({ failCreate: true })
    const controller = new AgentInstallController('x', fake.deps)
    controller.start()
    await flush()
    expect(controller.state).toMatchObject({ phase: 'error', message: 'spawn failed' })
    expect(isInstallBusy(controller.state)).toBe(false)
  })
})

describe('AgentInstallController の失敗の文', () => {
  it('シェルを作れなかった IPC の失敗は、包みを外して本文だけを出す', async () => {
    const fake = fakeDeps()
    fake.deps.create.mockImplementationOnce(() => Promise.reject(new Error("Error invoking remote method 'terminal:create': Error: ターミナルの準備ができていません")))
    const controller = new AgentInstallController('x', fake.deps)
    controller.start()
    await flush()
    expect(controller.state).toMatchObject({ phase: 'error', message: 'ターミナルの準備ができていません' })
  })
})

describe('agentInstallCommand', () => {
  it('1行で入れられるものはコマンド、無いものは undefined（リンクだけ）', () => {
    expect(agentInstallCommand('codex')).toMatch(/codex/)
    expect(agentInstallCommand('devin')).toBe('curl -fsSL https://cli.devin.ai/install.sh | bash')
    // ソースから入れるしかないもの
    expect(agentInstallCommand('zcode')).toBeUndefined()
  })
})

describe('agentInstallCommand の OS ごとの出し分け', () => {
  it('Windows では公式の Windows の手順を出す（Claude Code は CMD、Cursor・Devin は PowerShell）', () => {
    expect(agentInstallCommand('claude', 'win32')).toBe('curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd')
    expect(agentInstallCommand('cursor', 'win32')).toMatch(/^powershell -NoProfile -Command "irm 'https:\/\/cursor\.com\/install\?win32=true' \| iex"$/)
    expect(agentInstallCommand('devin', 'win32')).toBe('powershell -NoProfile -Command "irm https://static.devin.ai/cli/setup.ps1 | iex"')
    expect(agentInstallCommand('opencode', 'win32')).toBe('npm install -g opencode-ai')
  })

  it('Windows の手順が分からず、POSIX のシェル向けしか無いものはリンクだけ（undefined）', () => {
    expect(agentInstallCommand('amp', 'win32')).toBeUndefined()
    expect(agentInstallCommand('grok', 'win32')).toBeUndefined()
    // Homebrew（Windows に無い）と sh -c "$(curl …)" も同じ扱い
    expect(agentInstallCommand('crush', 'win32')).toBeUndefined()
    expect(agentInstallCommand('crush', 'darwin')).toBe('brew install charmbracelet/tap/crush')
    expect(agentInstallCommand('trae', 'win32')).toBeUndefined()
  })

  it('Windows でも npm などの OS に関係ないコマンドはそのまま出す', () => {
    expect(agentInstallCommand('codex', 'win32')).toMatch(/^npm (i|install) -g /)
  })

  it('macOS・Linux は curl … | bash の公式の手順のまま', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(agentInstallCommand('claude', platform)).toBe('curl -fsSL https://claude.ai/install.sh | bash')
      expect(agentInstallCommand('devin', platform)).toBe('curl -fsSL https://cli.devin.ai/install.sh | bash')
    }
  })

  it('OS を渡さなければ、画面の OS（window.ade.platform）で選ぶ', () => {
    const g = globalThis as { window?: unknown }
    const before = g.window
    try {
      g.window = { ade: { platform: 'win32' } }
      expect(agentInstallCommand('claude')).toMatch(/install\.cmd/)
      g.window = { ade: { platform: 'linux' } }
      expect(agentInstallCommand('claude')).toMatch(/install\.sh \| bash$/)
    } finally {
      g.window = before
    }
  })

  it('Windows では、カタログのどの Agent にも POSIX のシェル向けの手順を出さない', async () => {
    const { BUILTIN_AGENTS } = await import('@shared/agentCatalog')
    const { isPosixOnlyInstall } = await import('../../src/renderer/onboarding/agentInstall')
    for (const agent of BUILTIN_AGENTS) {
      const command = agentInstallCommand(agent, 'win32')
      if (command) expect(isPosixOnlyInstall(command), agent).toBe(false)
    }
  })
})
