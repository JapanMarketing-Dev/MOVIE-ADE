; Windows のインストーラ（NSIS・oneClick・ユーザーごと）に足す処理。electron-builder.config.cjs の nsis.include で読む。
;
; 旧版（oneClick: false のころ）は、入れるときに「すべてのユーザー」を選べた。そう入れた人は HKLM に登録があり、
; 今のインストーラ（HKCU だけを見て旧版を消す）では消えずに2つ並ぶ。ここで HKLM の旧版を見つけたら、先にそのアンインストーラを走らせる。
;   - 旧版のアンインストーラは /allusers を受けると自分で管理者に上がる（UAC の確認が1回出る）
;   - electron-builder の uninstallOldVersion と同じく、一時フォルダへ写してから _?= で元の場所を渡し、終わるまで待つ
;   - 断られた・失敗したときは、インストールは続け、1行のメッセージで「設定 → アプリ」から消せることを伝える
; customInit は .onInit の中で、check64BitAndSetRegView（64 ビットのレジストリを見る）と initMultiUser のあとに入る。
; UNINSTALL_REGISTRY_KEY・INSTALL_REGISTRY_KEY は multiUser.nsh、GetInQuotes は installUtil.nsh（どちらも electron-builder のテンプレート）。

!macro customInit
  ReadRegStr $R0 HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${if} $R0 != ""
    Push $R0
    Call GetInQuotes
    Pop $R1
    ReadRegStr $R2 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $R2 == ""
    ${andIf} $R1 != ""
      Push $R1
      Call GetFileParent
      Pop $R2
    ${endIf}
    ${if} $R1 != ""
    ${andIf} ${FileExists} "$R1"
      InitPluginsDir
      ClearErrors
      CopyFiles /SILENT "$R1" "$PLUGINSDIR\old-machine-uninstaller.exe"
      ${ifNot} ${Errors}
        ExecWait '"$PLUGINSDIR\old-machine-uninstaller.exe" /S /KEEP_APP_DATA /allusers --updated _?=$R2' $R3
      ${endIf}
    ${endIf}
    ReadRegStr $R0 HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ${if} $R0 != ""
      MessageBox MB_OK|MB_ICONINFORMATION "An earlier ${PRODUCT_NAME} installed for all users is still on this PC. You can remove it in Settings → Apps." /SD IDOK
    ${endIf}
  ${endIf}
!macroend
