# HACHIMI CODE

[opencode](https://github.com/anomalyco/opencode)（开源的 AI 编码代理）的个人分支，已改造为 **HACHIMI CODE**：橘猫橙黄主题，终端首页有斜向流星雨的动图。

本分支**没有发布**到 npm、Homebrew 或任何渠道，因此需要从源码构建运行。它与 opencode 项目无隶属关系，也不是由 opencode 团队构建的。上游是 MIT 许可（见 [LICENSE](./LICENSE)）。

## 构建与运行

需要 [Bun](https://bun.sh) 1.3 或更新版本（`packageManager` 固定为 `bun@1.3.14`）。

```bash
bun install
bun dev            # 在 packages/opencode 目录启动 TUI
bun dev .          # 在本仓库根目录启动
```

构建独立可执行文件：

```bash
./packages/opencode/script/build.ts --single
./packages/opencode/dist/opencode-<平台>-<架构>/bin/hachimicode
```

产物二进制名为 `hachimicode`（目录名形如 `opencode-darwin-arm64`）。

## 命令

CLI 名为 `hachimicode`，不带子命令直接运行即进入 TUI。

| 命令 | 作用 |
| --- | --- |
| `hachimicode [project]` | 启动终端界面（默认） |
| `hachimicode run [message..]` | 非交互执行一条提示词 |
| `hachimicode serve` | 启动无界面服务端 |
| `hachimicode web` | 启动服务端并打开 Web 界面 |
| `hachimicode attach <url>` | 把 TUI 连接到已运行的服务端 |
| `hachimicode models [provider]` | 列出可用模型 |
| `hachimicode providers` | 管理各家凭证（别名 `auth`） |
| `hachimicode agent` | 管理 agent |
| `hachimicode session` | 管理会话 |
| `hachimicode mcp` | 管理 MCP 服务器 |
| `hachimicode plugin <module>` | 安装插件并写入配置（别名 `plug`） |
| `hachimicode stats` | token 与花费统计 |
| `hachimicode export` / `import` | 以 JSON 导入导出会话 |
| `hachimicode github` / `pr` | GitHub agent 与 PR |
| `hachimicode debug` | 诊断工具 |
| `hachimicode db` | 数据库工具 |
| `hachimicode upgrade` / `uninstall` | 自升级与卸载 |
| `hachimicode completion` | 生成 shell 补全脚本 |
| `hachimicode acp` | ACP（Agent Client Protocol）服务端 |

每个命令都可以用 `--help` 查看参数，例如 `hachimicode run --help`。

## 配置文件位置与名称

配置为 JSON 或 JSONC。全局配置放在配置目录，项目配置放在从工作目录向上查找的 `.hachimicode` 目录里。

| 内容 | 位置 |
| --- | --- |
| 全局配置 | `~/.config/hachimicode/hachimicode.json` 或 `.jsonc`（遵循 `$XDG_CONFIG_HOME`） |
| 项目配置 | `<项目>/.hachimicode/hachimicode.json` 或 `.jsonc`，父目录同样会被查找 |
| TUI 设置 | 上述任一目录下的 `tui.json`，例如 `~/.config/hachimicode/tui.json` |
| 主题 | 上述任一目录下的 `themes/<名称>.json`，用 TUI 的 `theme` 设置选择 |
| Agents | `{agent,agents}/**/*.md` |
| 命令 | `{command,commands}/**/*.md` |
| Modes | `{mode,modes}/*.md` |
| 插件 | `{plugin,plugins}/*.{ts,js}` |
| 自定义工具 | `{tool,tools}/*.{js,ts}` |
| 技能 | `skills/` 下的 `*.md` 或 `**/SKILL.md` |

配置目录之外的数据与状态：

| 内容 | 位置 |
| --- | --- |
| 数据 | `~/.local/share/hachimicode` —— 会话在 `hachimicode-local.db`，凭证在 `auth.json`，日志在 `log/` |
| 缓存 | `~/.cache/hachimicode` |
| 状态 | `~/.local/state/hachimicode` |

环境变量统一使用 `HACHIMICODE_` 前缀，例如 `HACHIMICODE_CONFIG`、`HACHIMICODE_CONFIG_DIR`、`HACHIMICODE_CONFIG_CONTENT`、`HACHIMICODE_DB`、`HACHIMICODE_DISABLE_PROJECT_CONFIG`、`HACHIMICODE_SERVER_PASSWORD`、`HACHIMICODE_SERVER_USERNAME`。

## Agent

内置两个 agent，用 `Tab` 切换：

- **build** —— 默认的完全权限 agent
- **plan** —— 只读分析，默认拒绝编辑、执行 shell 命令前先询问

另有一个 **general** 子 agent 处理复杂检索与多步任务，在消息中用 `@general` 调用。

## 开发

```bash
bun install
bun lint                              # oxlint
bun typecheck                         # 经 turbo 检查全部包
cd packages/opencode && bun typecheck # 或单包检查：不要直接调用 tsc
```

测试必须**在包目录内**运行，不能在仓库根运行：

```bash
cd packages/opencode && bun test
```

改动公共 `HttpApi` 后需要重新生成客户端，生成文件不要手改：

```bash
cd packages/client && bun run generate
```

首页动图与字标都是**生成**的，不是手画的。动图由一组 GIF/PNG 烘焙而来，字标由点阵字体生成：

```bash
python3 script/build-home-memes.py --out packages/tui/src/component/home-memes/memes.json \
  --width 20 --height 24 --max-frames 16 smn1.gif smn2.gif dg.png
python3 script/build-wordmark.py --height 14 --gap 3
```

## 本分支的取舍

改造一个分支从来不是纯粹的字符串替换。以下刻意保留上游名称，因为改名会直接弄坏可用性：

- 托管 provider id `opencode`、`opencode-go`，以及 `opencode.ai` 服务端点
- `x-opencode-*` 这套 HTTP 头 —— `packages/app/vendor` 里固定的预编译客户端就是按这些头名通信的
- provider 的 `referrer` / `originator` 字段 —— OAuth 流程依赖它们
- `.git/opencode` 项目标识文件 —— 它把已有仓库和它们的会话关联在一起
