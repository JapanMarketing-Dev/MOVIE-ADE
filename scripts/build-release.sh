#!/usr/bin/env bash
# 3つのOSの配布物（6本）を、この Mac で作り直して dist/release/ に集める。R2 へは上げない。
#
#   pnpm release:build            # package.json の version で作る
#   SKIP_LINUX=1 pnpm release:build   # Linux を飛ばす（コンテナが使えないとき）
#
# 続けて: pnpm release:r2 stage --preview win,linux → 確認 → pnpm release:r2 promote --version <version>
#
# 手順:
#   1. 作業ツリーを一時フォルダへ複製する（APFS の複製なので速く、場所も取らない）。
#      動いている dev サーバーが使う out/ を上書きしないため、ビルドはすべて複製の中で行う
#   2. 複製の中で pnpm typecheck と pnpm test:unit を流す。1件でも落ちたら止める。
#      続けて pnpm build:release（ビルド＋ソースマップの送信。scripts/sentry-sourcemaps.mjs）
#   3. macOS: dmg（arm64 / x64）
#   4. Windows: 展開済みのアプリ（x64 / arm64）を作り、NSIS だけはこのリポジトリの dist/release で作る
#      （Mac の makensis は、深いパスの下では uninstaller を作るところで落ちる）
#   5. Linux: node-pty の Linux 用バイナリが同梱されていないので、x64 の Linux コンテナ（podman か docker）の中で
#      pnpm install をやり直し（out/ は手順 2 で作ったものを使う）、AppImage / deb を作る。パッケージに入った node-pty で PTY が開けることも確かめる
#
# 必要なもの: macOS、pnpm、podman（または docker）。未署名で作る。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('${REPO}/package.json').version")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ferret-release.XXXXXX")"
SRC="${WORK}/src"
OUT="${REPO}/dist/release"
export CSC_IDENTITY_AUTO_DISCOVERY=false
# renderer（Monaco を含む）のビルドは Node の既定のヒープを超えることがある
export NODE_OPTIONS=--max-old-space-size=4096

if [[ "$(uname)" != "Darwin" ]]; then
  echo "macOS で実行してください（dmg と Windows 版をこの Mac で作るため）" >&2
  exit 1
fi

echo "== Ferret ${VERSION} を作ります（作業場所: ${WORK}）"
mkdir -p "${SRC}"
cd "${REPO}"
for entry in $(ls -A); do
  case "$entry" in dist|out|e2e-artifacts|test-results|.git) continue ;; esac
  cp -cR "$entry" "${SRC}/"
done

echo "== 型検査と単体テスト"
cd "${SRC}"
pnpm typecheck
pnpm test:unit
# ビルドのあと、ソースマップを Sentry へ上げ、out/ の JS に debug ID を書き込む（electron-builder より前）
pnpm build:release

echo "== macOS（dmg arm64 / x64）"
npx electron-builder --config electron-builder.config.cjs --mac dmg --arm64 --x64

echo "== Windows（x64 / arm64）"
npx electron-builder --config electron-builder.config.cjs --win --dir --x64
npx electron-builder --config electron-builder.config.cjs --win --dir --arm64
rm -rf "${OUT}"
mkdir -p "${OUT}"
cd "${REPO}"
npx electron-builder --config electron-builder.config.cjs --win nsis --x64 --prepackaged "${SRC}/dist/release/win-unpacked"
npx electron-builder --config electron-builder.config.cjs --win nsis --arm64 --prepackaged "${SRC}/dist/release/win-arm64-unpacked"
cp -c "${SRC}"/dist/release/Ferret-"${VERSION}"-mac-*.dmg "${OUT}/"

if [[ "${SKIP_LINUX:-}" == "1" ]]; then
  echo "== Linux は飛ばしました（SKIP_LINUX=1）"
else
  echo "== Linux（x64 のコンテナで AppImage / deb）"
  started_podman=""
  if docker info >/dev/null 2>&1; then
    CLI=docker
  elif command -v podman >/dev/null 2>&1; then
    CLI=podman
    if ! podman info >/dev/null 2>&1; then
      podman machine start >/dev/null
      started_podman=1
    fi
  else
    echo "podman も docker も使えません。SKIP_LINUX=1 で Linux を飛ばすか、Linux の上で pnpm dist:linux を流してください" >&2
    exit 1
  fi

  mkdir -p "${WORK}/linux"
  cat > "${WORK}/linux/run.sh" <<'LINUX'
set -euo pipefail
apt-get update -qq
apt-get install -y -qq build-essential python3 rsync libnss3 libnspr4 libgtk-3-0 libasound2 libgbm1 libxss1 libxtst6 >/dev/null
# out/ は Mac で作ったものをそのまま使う（JS は OS に関係なく同じ。ソースマップの debug ID も揃う）
rsync -a --exclude node_modules --exclude dist /src/ /work/
cd /work
corepack enable && corepack prepare pnpm@10 --activate
pnpm install --frozen-lockfile
npx electron-builder --config electron-builder.config.cjs --linux AppImage deb --x64
cp dist/release/Ferret-*.AppImage dist/release/Ferret-*.deb /out/
# パッケージに入った node-pty で PTY を1つ開いて閉じる
cd dist/release/linux-unpacked
ELECTRON_RUN_AS_NODE=1 ./ferret -e "const p=require('./resources/app.asar/node_modules/node-pty');const t=p.spawn('/bin/bash',['-c','echo PTY_OK'],{});t.onData(d=>process.stdout.write(d));t.onExit(e=>process.exit(e.exitCode))"
LINUX
  mkdir -p "${WORK}/linux/out"
  "${CLI}" run --rm --platform linux/amd64 -m 7g \
    -v "${SRC}:/src:ro" -v "${WORK}/linux:/s:ro" -v "${WORK}/linux/out:/out" \
    docker.io/library/node:22-bookworm bash /s/run.sh
  cp "${WORK}"/linux/out/* "${OUT}/"
  if [[ -n "${started_podman}" ]]; then podman machine stop >/dev/null; fi
fi

rm -rf "${WORK}"
echo "== できたもの（${OUT}）"
ls -la "${OUT}"/Ferret-"${VERSION}"-*
echo "次: pnpm release:r2 stage --preview win,linux  →  確認  →  pnpm release:r2 promote --version ${VERSION}"
