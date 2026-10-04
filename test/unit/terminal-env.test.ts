import { describe, expect, it } from 'vitest'
import { defaultLocaleEnv, isHostTerminalEnv, stripAppImagePaths } from '../../src/main/terminalEnv'

describe('内蔵ターミナルに渡さない環境変数（Orca #10613 #19792 #9057 #7022）', () => {
  it('Ferret を起動した端末の名乗り・Crashpad・NODE_ENV・AppImage の変数は渡さない', () => {
    for (const key of ['TERM_PROGRAM', 'GHOSTTY_RESOURCES_DIR', 'WT_SESSION', 'TMUX', 'ITERM_SESSION_ID', 'CHROME_CRASHPAD_PIPE_NAME', 'NODE_ENV', 'APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']) {
      expect(isHostTerminalEnv(key), key).toBe(true)
    }
  })

  it('ふつうの変数は渡す', () => {
    for (const key of ['PATH', 'HOME', 'LANG', 'SHELL', 'TERM', 'CLAUDE_CONFIG_DIR', 'TERMINFO', 'WINDOW']) {
      expect(isHostTerminalEnv(key), key).toBe(false)
    }
  })

  it('AppImage の中のフォルダを PATH・LD_LIBRARY_PATH から外す（ほかの項目と順は残す）', () => {
    const env: Record<string, string> = {
      PATH: '/tmp/.mount_FerretX/usr/bin:/usr/local/bin:/tmp/.mount_FerretX:/usr/bin',
      LD_LIBRARY_PATH: '/tmp/.mount_FerretX/usr/lib/'
    }
    stripAppImagePaths(env, '/tmp/.mount_FerretX/', ':')
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin')
    expect(env.LD_LIBRARY_PATH).toBeUndefined()
  })

  it('APPDIR が無い・絶対パスでないときは何もしない（似た名前のフォルダも残す）', () => {
    const env: Record<string, string> = { PATH: '/tmp/.mount_FerretXY/bin:/usr/bin' }
    stripAppImagePaths(env, undefined, ':')
    stripAppImagePaths(env, 'relative', ':')
    stripAppImagePaths(env, '/tmp/.mount_FerretX', ':')
    expect(env.PATH).toBe('/tmp/.mount_FerretXY/bin:/usr/bin')
  })

  it('macOS で言語の変数が1つも無いときだけ LANG=en_US.UTF-8 を補う', () => {
    expect(defaultLocaleEnv({}, 'darwin')).toEqual({ LANG: 'en_US.UTF-8' })
    expect(defaultLocaleEnv({ LANG: 'ja_JP.UTF-8' }, 'darwin')).toEqual({})
    expect(defaultLocaleEnv({ LC_CTYPE: 'UTF-8' }, 'darwin')).toEqual({})
    expect(defaultLocaleEnv({}, 'linux')).toEqual({})
    expect(defaultLocaleEnv({}, 'win32')).toEqual({})
  })
})
