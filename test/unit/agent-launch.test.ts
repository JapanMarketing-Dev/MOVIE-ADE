/**
 * Agent起動コマンドの組み立て（Orca由来の純粋関数）と、シェルの起動ファイルの中身。
 * シェルもPTYも起動しない。
 */
import { describe, expect, it } from 'vitest'
import {
  buildAgentLaunchCommand,
  quoteStartupArg,
  startupShellForPath,
  tokenizeStartupCommand
} from '@shared/agentLaunch'
import { DEFAULT_AGENT_PREFERENCES } from '@shared/types'
import {
  STARTUP_COMMAND_ENV,
  bashStartupRcfile,
  fishStartupInitCommand,
  planStartupDelivery,
  zshStartupWrapper
} from '../../src/main/shellStartup'

describe('tokenizeStartupCommand', () => {
  it('空白で区切り、クォートの中は1語にする', () => {
    expect(tokenizeStartupCommand(`--model opus  --name "a b" 'c d'`)).toEqual({
      ok: true,
      tokens: ['--model', 'opus', '--name', 'a b', 'c d']
    })
  })

  it('クォートを抜けても語は続く', () => {
    expect(tokenizeStartupCommand(`a"b"c`)).toEqual({ ok: true, tokens: ['abc'] })
  })

  it('バックスラッシュで空白を語に含める', () => {
    expect(tokenizeStartupCommand('a\\ b')).toEqual({ ok: true, tokens: ['a b'] })
  })

  it('閉じていないクォートは失敗にする', () => {
    expect(tokenizeStartupCommand(`--x "abc`).ok).toBe(false)
  })
})

describe('quoteStartupArg', () => {
  it('posix はシングルクォートで囲み、アポストロフィとバックスラッシュは外へ出す（fishでも同じ意味）', () => {
    // 特別な意味を持たない文字だけなら引用しない
    expect(quoteStartupArg('plain', 'posix')).toBe('plain')
    expect(quoteStartupArg('--mode=auto', 'posix')).toBe('--mode=auto')
    expect(quoteStartupArg('/opt/bin/x', 'posix')).toBe('/opt/bin/x')
    expect(quoteStartupArg('=cmd', 'posix')).toBe(`'=cmd'`)
    expect(quoteStartupArg('a b', 'posix')).toBe(`'a b'`)
    expect(quoteStartupArg('~/x', 'posix')).toBe(`'~/x'`)
    expect(quoteStartupArg('%self', 'posix')).toBe(`'%self'`)
    expect(quoteStartupArg('*', 'posix')).toBe(`'*'`)
    expect(quoteStartupArg(`it's`, 'posix')).toBe(`'it'"'"'s'`)
    expect(quoteStartupArg('a\\b', 'posix')).toBe(`'a'"\\\\"'b'`)
    expect(quoteStartupArg('', 'posix')).toBe(`''`)
    expect(quoteStartupArg('$HOME `x`', 'posix')).toBe(`'$HOME \`x\`'`)
  })

  it('PowerShell はシングルクォートを二重にする', () => {
    expect(quoteStartupArg(`it's`, 'powershell')).toBe(`'it''s'`)
  })

  it('cmd はダブルクォートで囲む（中の ^ は普通の文字なので付けない）', () => {
    expect(quoteStartupArg('a&b', 'cmd')).toBe(`"a&b"`)
    expect(quoteStartupArg('C:\\Program Files (x86)\\x', 'cmd')).toBe(`"C:\\Program Files (x86)\\x"`)
    expect(quoteStartupArg('say "hi"', 'cmd')).toBe(`"say ""hi"""`)
    expect(quoteStartupArg('C:\\dir\\', 'cmd')).toBe(`"C:\\dir\\\\"`)
    expect(quoteStartupArg('100%', 'cmd')).toBe(`"100"^%""`)
  })

  it('Windows のシェルではバックスラッシュをパスとして残す', () => {
    expect(buildAgentLaunchCommand('claude', { command: 'claude', args: '--config C:\\Users\\dev\\x.toml' }, 'cmd'))
      .toEqual({ ok: true, command: 'claude "--config" "C:\\Users\\dev\\x.toml"' })
    expect(buildAgentLaunchCommand('claude', { command: 'claude', args: '--config "C:\\Program Files\\x.toml"' }, 'powershell'))
      .toEqual({ ok: true, command: `claude '--config' 'C:\\Program Files\\x.toml'` })
    expect(buildAgentLaunchCommand('claude', { command: 'claude', args: 'a\\ b' }, 'posix')).toEqual({ ok: true, command: `claude 'a b'` })
  })
})

describe('startupShellForPath', () => {
  it('シェルのパスから書き方を決める', () => {
    expect(startupShellForPath('/bin/zsh')).toBe('posix')
    expect(startupShellForPath('/opt/homebrew/bin/fish')).toBe('posix')
    expect(startupShellForPath('C:\\Windows\\System32\\cmd.exe')).toBe('cmd')
    expect(startupShellForPath('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('powershell')
  })
})

describe('buildAgentLaunchCommand', () => {
  it('既定の設定は権限確認を省く引数なしで起動する（security-3 [1]。Orca と違う）', () => {
    expect(buildAgentLaunchCommand('claude', DEFAULT_AGENT_PREFERENCES.launch.claude, 'posix')).toEqual({ ok: true, command: 'claude' })
    expect(buildAgentLaunchCommand('codex', DEFAULT_AGENT_PREFERENCES.launch.codex, 'posix')).toEqual({ ok: true, command: 'codex' })
  })

  it('コマンド本体は書いたまま使い、引数だけクォートし直す', () => {
    expect(
      buildAgentLaunchCommand('claude', { command: 'npx -y claude', args: `--append "it's ok"` }, 'posix')
    ).toEqual({ ok: true, command: `npx -y claude --append 'it'"'"'s ok'` })
  })

  it('引数が空ならコマンドだけ、コマンドが空なら既定のコマンド', () => {
    expect(buildAgentLaunchCommand('codex', { command: 'codex', args: '' }, 'posix')).toEqual({
      ok: true,
      command: 'codex'
    })
    expect(buildAgentLaunchCommand('codex', { command: '  ', args: '' }, 'posix')).toEqual({
      ok: true,
      command: 'codex'
    })
  })

  it('引数の書き方が壊れていれば理由を返す', () => {
    const result = buildAgentLaunchCommand('claude', { command: 'claude', args: `"oops` }, 'posix')
    expect(result.ok).toBe(false)
  })
})

describe('シェルの起動ファイル', () => {
  it('zsh は ZDOTDIR を返してから利用者の .zshenv を読み、最初の行入力で起動コマンドを実行する', () => {
    const text = zshStartupWrapper()
    expect(text.indexOf('ADE_ORIG_ZDOTDIR')).toBeLessThan(text.indexOf('source -- "$_ade_user_zshenv"'))
    expect(text).toContain(`BUFFER="$${STARTUP_COMMAND_ENV}"`)
    expect(text).toContain('zle accept-line')
    expect(text).toContain('zle -N zle-line-init __ade_line_init')
  })

  it('bash はログイン相当の起動ファイルを読み、PROMPT_COMMAND で一度だけ実行する', () => {
    const text = bashStartupRcfile()
    expect(text).toContain('source "$HOME/.bash_profile"')
    expect(text).toContain(`unset ${STARTUP_COMMAND_ENV}`)
    expect(text).toContain('__ade_run_startup_command')
  })

  it('fish は最初のプロンプトで実行して自分を消す', () => {
    const text = fishStartupInitCommand()
    expect(text).toContain('--on-event fish_prompt')
    expect(text).toContain('functions -e __ade_startup_command')
  })

  it('シェルごとに渡し方を選ぶ', () => {
    const zsh = planStartupDelivery({ file: '/bin/zsh', args: ['-l'] }, 'claude', '/Users/me/.config/zsh')
    expect(zsh.kind).toBe('shell-hook')
    expect(zsh.shell.args).toEqual(['-l'])
    expect(zsh.env[STARTUP_COMMAND_ENV]).toBe('claude')
    expect(zsh.env.ZDOTDIR).toMatch(/ade-shell-.*[\\/]zsh$/)
    expect(zsh.env.ADE_ORIG_ZDOTDIR).toBe('/Users/me/.config/zsh')

    const bash = planStartupDelivery({ file: '/bin/bash', args: ['-l'] }, 'codex')
    expect(bash.kind).toBe('shell-hook')
    expect(bash.shell.args[0]).toBe('--rcfile')

    const fish = planStartupDelivery({ file: '/usr/bin/fish', args: ['-l'] }, 'codex')
    expect(fish.shell.args).toContain('--init-command')

    expect(planStartupDelivery({ file: '/bin/sh', args: ['-l'] }, 'codex').kind).toBe('write')
    expect(planStartupDelivery({ file: 'cmd.exe', args: [] }, 'codex').kind).toBe('write')
  })
})
