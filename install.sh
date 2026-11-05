#!/usr/bin/env bash
# Catmux installer (macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/lileilei2023/catmux/main/install.sh | bash
#
# Clones Catmux into ~/.local/share/catmux/app (or updates it), then installs the
# `catmux` command, an on-demand launchd service and the Catmux.app launcher.
# Run from inside a checkout (./install.sh) to install that checkout in place.
# Nothing is installed on remote devices: they only need tmux and python3.
set -euo pipefail

REPO=${CATMUX_REPO:-https://github.com/lileilei2023/catmux.git}
REF=${CATMUX_REF:-main}
DEST=${CATMUX_HOME:-$HOME/.local/share/catmux/app}

say() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m错误：\033[0m%s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[[ $(uname -s) == Darwin ]] || die "目前只支持在 macOS 上安装 Catmux（Linux 机器可以作为远端设备使用，无需安装）。"

missing=()
have git || missing+=("git（xcode-select --install）")
have python3 || missing+=("python3（xcode-select --install）")
have ssh || missing+=("ssh")
if have node; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  (( major >= 18 )) || missing+=("node 18 或更高（当前 $(node -v)，brew install node）")
else
  missing+=("node 18 或更高（brew install node）")
fi
if (( ${#missing[@]} )); then
  printf '缺少以下依赖：\n'; printf '  - %s\n' "${missing[@]}"
  have brew || printf '没有 Homebrew 的话可以先安装：https://brew.sh\n'
  exit 1
fi
have tmux || say "可选：没有 tmux，“本机”设备不可用（SSH 设备不受影响）。安装：brew install tmux"
have tssh || say "可选：没有 tssh，UDP 漫游连接不可用（SSH TCP 正常）。安装：brew install trzsz-ssh"

# Installing from inside a checkout: use it as is.
here=""
if [[ -n ${BASH_SOURCE[0]:-} && -f ${BASH_SOURCE[0]} ]]; then here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); fi
if [[ -z ${CATMUX_HOME:-} && -n $here && -x $here/bin/catmux && -f $here/src/web-server.js ]]; then
  DEST=$here
  say "从当前目录安装：$DEST"
elif [[ -d $DEST/.git ]]; then
  say "更新 $DEST"
  git -C "$DEST" fetch --quiet origin "$REF"
  git -C "$DEST" checkout --quiet "$REF"
  git -C "$DEST" merge --ff-only --quiet "origin/$REF" || die "$DEST 有本地改动，未更新"
elif [[ -e $DEST ]]; then
  die "$DEST 已存在但不是 git 仓库；请移走它或设置 CATMUX_HOME"
else
  say "下载 Catmux 到 $DEST"
  mkdir -p "$(dirname "$DEST")"
  git clone --quiet --depth 1 --branch "$REF" "$REPO" "$DEST"
fi

chmod +x "$DEST/bin/catmux"
"$DEST/bin/catmux" install
"$DEST/bin/catmux" start
say "完成。打开：catmux open（或双击 应用程序 → Catmux）。地址 http://127.0.0.1:48731"
