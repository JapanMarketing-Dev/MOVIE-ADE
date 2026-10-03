/**
 * CLI がよく置かれるフォルダ（OSごと）。
 *
 * Finder・Dock・デスクトップのランチャーから起動すると、シェルの PATH（Homebrew、nvm など）を引き継がない。
 * PATH で見つからないときに、ここを順に探す。
 */
export function commonBinaryDirs(platform: NodeJS.Platform, home: string): string[] {
  if (platform === 'win32') {
    // Windows はインストーラが PATH を登録するので、PATH に無ければ探さない
    return []
  }
  if (platform === 'darwin') {
    return ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', ...homeDirs(home)]
  }
  // Linux: Homebrew on Linux・snap・pipx などの利用者ごとの置き場
  return ['/usr/local/bin', '/usr/bin', '/home/linuxbrew/.linuxbrew/bin', '/snap/bin', ...homeDirs(home)]
}

function homeDirs(home: string): string[] {
  return home ? [`${home.replace(/\/+$/, '')}/.local/bin`] : []
}
