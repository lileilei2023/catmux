# Catmux

<img src="web/icon-512.png" width="96" alt="Catmux icon" align="right">

**本机 + 任意 SSH 设备上的 tmux / AI 编程 CLI 工作台。** 在一个本机网页窗口里管理分布在多台机器上的
Codex、Claude Code 或普通终端会话：中间是真实的远端终端，左边是按设备分组的会话列表，右边是远端项目的
文件树、编辑器与逐文件 Git diff。会话都跑在各设备自己的 tmux 里——关掉窗口、断网、重启本机后端都不会停。

- **一个入口，多台设备**：设备 = “本机”（本地 tmux）+ `~/.ssh/config` 里的所有 Host；多个项目并行，后台有新输出会提示。
- **独立任务 worktree**：新建任务时选起点分支（每个项目可设默认，比如 `develop`），自动建 `aihub/<id>` 分支与 worktree。
- **结束任务**：只停止 / 清理（PR 已合并或内容已进入目标分支才允许，不强制删除）/ 推送并开 PR（`gh`）或仅推送（非 GitHub）。
- **启动参数**：每个工具的权限模式（默认 / 自动编辑 / 完全权限）+ 额外参数原样透传。
- **右侧工作台**：整个项目结构一次加载、本机缓存、语法高亮预览、显式编辑 + 冲突检测 + 私有备份、图片预览、右键菜单。
- **终端体验**：同步输出（不闪烁）、鼠标事件合并、OSC 52 复制到 Mac 剪贴板、⌥ 拖动选择、粘贴图片自动上传到远端。
- **只在本机监听** `127.0.0.1`；远端设备不需要安装任何东西（只要有 `tmux` 与 `python3`）。

## 安装（macOS）

```zsh
curl -fsSL https://raw.githubusercontent.com/lileilei2023/catmux/main/install.sh | bash
```

需要 Node.js ≥ 18、`python3`、`git`、`ssh`（缺少时安装脚本会提示）。可选：`tmux`（使用“本机”设备）、
`tssh`（`brew install trzsz-ssh`，UDP 漫游连接）、`gh`（结束任务时查 PR / 开 PR）。

安装后：

```zsh
catmux open                 # 启动并打开窗口（也可以双击 应用程序 → Catmux）
catmux start|stop|status|logs
catmux update               # 更新
catmux autostart on|off     # 登录后自动启动（默认关）
catmux icon cat|robot|cloud|classic
catmux dock                 # 固定到 Dock
catmux doctor               # 检查依赖
catmux uninstall            # 移除命令 / 服务 / 启动器（不动数据与各设备上的会话）
```

在 Chrome 打开 http://127.0.0.1:48731 后点地址栏右侧“安装”，可得到独立窗口的 Web App。

## 设备上的约定

- 会话：tmux 会话名 `aihub-<id>`；任务分支 `aihub/<id>`；worktree、上传、文件备份与协议缓存都在
  `~/.local/share/ai-hub/`（权限 0700）。这些名字沿用项目旧名，保证升级前创建的会话与任务继续可用。
- 所有远端操作都通过普通 SSH 执行（严格主机密钥校验、不转发任何东西）；同一设备复用一条 SSH 连接；
  协议脚本按 SHA-256 缓存并在每次执行前校验。
- 停止只结束对应的 tmux 会话；从不自动删除 worktree / 分支，从不自动提交或强制推送。

## 开发

```zsh
npm test            # 单元测试（真实 git / tmux / Python，远端操作在本机模拟）
npm run test:web    # 真实 Chrome 端到端测试（需要 Playwright；远端为模拟）
CATMUX_LIVE_HOST=<ssh 别名> npm run test:live   # 对真实设备的只读检查
```

第三方前端文件（xterm.js、highlight.js）随仓库提供，许可证见 `web/vendor/LICENSES.md`。

## 许可证

MIT，见 [LICENSE](LICENSE)。
