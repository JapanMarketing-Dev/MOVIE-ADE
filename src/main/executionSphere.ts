import type { SshTarget } from '@shared/sshCommand'

/**
 * タブのシェルをどこで動かすか（security-5 [3]）。
 *
 * SSH のプロジェクトを開いているとき、ふつうのタブと Agent はリモートのプロジェクトのフォルダで動かす。
 * アカウントのログインは、Ferret の手元のアカウント（CLAUDE_CONFIG_DIR / CODEX_HOME）に結び付くものなので、
 * 開いているプロジェクトに関係なく必ず手元のホームで動かす。リモートのホストやプロジェクトで認証させない。
 * リモートでのログインの流れは用意しない（必要になったら、別の同意を取る流れとして作る）。
 */
export type ExecutionSphere = { kind: 'local' } | { kind: 'ssh'; target: SshTarget }

export function executionSphere(input: { accountLogin: boolean; remote: SshTarget | null }): ExecutionSphere {
  if (input.accountLogin || !input.remote) return { kind: 'local' }
  return { kind: 'ssh', target: input.remote }
}
