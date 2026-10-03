#!/usr/bin/env bash
# Linux 版のスモーク（e2e/platform-smoke.spec.ts）を、この Mac の Linux コンテナ（podman か docker）の中で流す。
#
# CPU は既定でこの Mac と同じ（Apple silicon なら arm64）。podman のマシンは x64 を qemu-user で動かすが、
# Chromium は qemu-user の上では子プロセス（renderer・GPU）を起動できずに落ちる（Rosetta は kernel 6.13 以降で使えず、
# podman も切っている）。x64 版の中身の違いは Electron と node-pty のバイナリだけなので、画面とターミナルは同じ OS の arm64 で確かめる。
# x64 で走らせたいとき（x64 の Linux や CI の上）は SMOKE_ARCH=x64。
#
#   bash tools/qa/linux-smoke.sh [作業フォルダ]     # 省略すると mktemp -d で作る
#   OVERLAY="src/main/a.ts src/main/b.ts" bash tools/qa/linux-smoke.sh   # commit 前のファイルを重ねて試す
#
# 手順:
#   1. commit 済みの HEAD（BASE=<commit> で別の版）を作業フォルダへ取り出す（作業ツリーの編集途中を拾わない。out/ にも書かない）
#   2. Mac で pnpm build（out/ は OS に関係なく同じ）
#   3. Debian のコンテナで pnpm install をやり直し（node-pty の Linux 用バイナリを作る）、展開済みのアプリを作る
#   4. xvfb の上で配布用アプリを起動し、Playwright で起動・内蔵ブラウザ・ターミナル（PTY）・設定を確かめて撮る
# できたスクリーンショットは <作業フォルダ>/shots/smoke-linux-*.png。開いて目で見て判定する。
# root で動くコンテナなので、Chromium のサンドボックスは外して起動する（FERRET_SMOKE_NO_SANDBOX=1）。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${1:-$(mktemp -d "${TMPDIR:-/tmp}/ferret-linux-smoke.XXXXXX")}"
SRC="${WORK}/src"
mkdir -p "${SRC}" "${WORK}/shots" "${WORK}/s"
export NODE_OPTIONS=--max-old-space-size=4096
ARCH="${SMOKE_ARCH:-$([[ "$(uname -m)" == "arm64" || "$(uname -m)" == "aarch64" ]] && echo arm64 || echo x64)}"
case "${ARCH}" in x64) PLATFORM=linux/amd64; UNPACKED=linux-unpacked ;; arm64) PLATFORM=linux/arm64; UNPACKED=linux-arm64-unpacked ;; *) echo "SMOKE_ARCH は x64 か arm64" >&2; exit 2 ;; esac

# REUSE=1 なら、前回この作業フォルダで作った src/（と out/）をそのまま使う（コンテナの中だけやり直す）
if [[ "${REUSE:-}" != "1" || ! -d "${SRC}/out" ]]; then
  git -C "${REPO}" archive "${BASE:-HEAD}" | tar -x -C "${SRC}"
  for f in ${OVERLAY:-}; do mkdir -p "${SRC}/$(dirname "$f")"; cp "${REPO}/$f" "${SRC}/$f"; done
  cp -cR "${REPO}/node_modules" "${SRC}/" 2>/dev/null || cp -R "${REPO}/node_modules" "${SRC}/"
  (cd "${SRC}" && pnpm build)
fi

if docker info >/dev/null 2>&1; then CLI=docker; elif command -v podman >/dev/null 2>&1; then CLI=podman; else
  echo "podman も docker も使えません" >&2; exit 1
fi

cat > "${WORK}/s/run.sh" <<'LINUX'
set -euo pipefail
apt-get update -qq
apt-get install -y -qq build-essential python3 rsync xvfb xauth fonts-dejavu-core fonts-noto-cjk \
  libnss3 libnspr4 libgtk-3-0 libasound2 libgbm1 libxss1 libxtst6 libsecret-1-0 >/dev/null
rsync -a --exclude node_modules --exclude dist /src/ /work/
cd /work
corepack enable && corepack prepare pnpm@10.31.0 --activate
pnpm install --frozen-lockfile
pnpm exec electron-builder --config electron-builder.config.cjs --linux --dir "--${SMOKE_ARCH}"
export SHELL=/bin/bash
status=0
FERRET_E2E_ISOLATION_ROOT="$(mktemp -d)" FERRET_SMOKE_APP="dist/release/${SMOKE_UNPACKED}/ferret" FERRET_SMOKE_NO_SANDBOX=1 \
  xvfb-run -a -s "-screen 0 1600x1000x24" pnpm exec playwright test e2e/platform-smoke.spec.ts || status=$?
cp e2e-artifacts/screenshots/smoke-* /out/ 2>/dev/null || true
exit "${status}"
LINUX

# Chromium は /dev/shm を使う。コンテナの既定（64MB）では renderer が落ちる
"${CLI}" run --rm --platform "${PLATFORM}" -m 7g --shm-size=2g -e ADE_E2E_LOG="${ADE_E2E_LOG:-0}" -e SMOKE_ARCH="${ARCH}" -e SMOKE_UNPACKED="${UNPACKED}" \
  -v "${SRC}:/src:ro" -v "${WORK}/s:/s:ro" -v "${WORK}/shots:/out" \
  docker.io/library/node:22-bookworm bash /s/run.sh
echo "== スクリーンショット: ${WORK}/shots"
ls -la "${WORK}/shots"
