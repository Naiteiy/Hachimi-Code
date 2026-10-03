# HACHIMI CODE

A personal fork of [opencode](https://github.com/anomalyco/opencode) — the open source AI coding agent — rebranded as **HACHIMI CODE**, with a warm orange-cat theme and a slanted meme shower on the terminal home screen.

This fork is **not published** to npm, Homebrew, or any other channel, so it is built and run from source. It is unaffiliated with the opencode project and is not built by its team. Upstream is MIT licensed (see [LICENSE](./LICENSE)).

## Build and run

Requires [Bun](https://bun.sh) 1.3 or newer (`packageManager` pins `bun@1.3.14`).

```bash
bun install
bun dev            # starts the TUI against packages/opencode
bun dev .          # starts it against this repository
```

A standalone binary:

```bash
./packages/opencode/script/build.ts --single
./packages/opencode/dist/opencode-<platform>-<arch>/bin/hachimicode
```

The built executable is named `hachimicode` (for example `opencode-darwin-arm64` for the directory, `hachimicode` for the binary).

## Commands

The CLI is `hachimicode`. Running it with no command starts the TUI.

| Command | What it does |
| --- | --- |
| `hachimicode [project]` | start the terminal UI (default) |
| `hachimicode run [message..]` | run one prompt non-interactively |
| `hachimicode serve` | start a headless server |
| `hachimicode web` | start a server and open the web interface |
| `hachimicode attach <url>` | attach the TUI to a running server |
| `hachimicode models [provider]` | list available models |
| `hachimicode providers` | manage provider credentials (alias `auth`) |
| `hachimicode agent` | manage agents |
| `hachimicode session` | manage sessions |
| `hachimicode mcp` | manage MCP servers |
| `hachimicode plugin <module>` | install a plugin and update config (alias `plug`) |
| `hachimicode stats` | token and cost statistics |
| `hachimicode export` / `import` | move session data as JSON |
| `hachimicode github` / `pr` | GitHub agent and pull requests |
| `hachimicode debug` | diagnostics |
| `hachimicode db` | database tools |
| `hachimicode upgrade` / `uninstall` | self management |
| `hachimicode completion` | shell completion script |
| `hachimicode acp` | ACP (Agent Client Protocol) server |

Every command prints its options with `--help`, for example `hachimicode run --help`.

## Configuration

Configuration is JSON or JSONC. Global settings live in the config directory, project settings in a `.hachimicode` directory discovered by walking up from the working directory.

| What | Where |
| --- | --- |
| Global config | `~/.config/hachimicode/hachimicode.json` or `.jsonc` (`$XDG_CONFIG_HOME` respected) |
| Project config | `<project>/.hachimicode/hachimicode.json` or `.jsonc`, also searched in parent directories |
| TUI settings | `tui.json` in either location, for example `~/.config/hachimicode/tui.json` |
| Themes | `themes/<name>.json` in either location; pick one with the TUI `theme` setting |
| Agents | `{agent,agents}/**/*.md` |
| Commands | `{command,commands}/**/*.md` |
| Modes | `{mode,modes}/*.md` |
| Plugins | `{plugin,plugins}/*.{ts,js}` |
| Custom tools | `{tool,tools}/*.{js,ts}` |
| Skills | `skills/`, as `*.md` or `**/SKILL.md` |

Data and state, outside the config directories:

| What | Where |
| --- | --- |
| Data | `~/.local/share/hachimicode` — sessions in `hachimicode-local.db`, provider credentials in `auth.json`, logs in `log/` |
| Cache | `~/.cache/hachimicode` |
| State | `~/.local/state/hachimicode` |

Environment variables use the `HACHIMICODE_` prefix, for example `HACHIMICODE_CONFIG`, `HACHIMICODE_CONFIG_DIR`, `HACHIMICODE_CONFIG_CONTENT`, `HACHIMICODE_DB`, `HACHIMICODE_DISABLE_PROJECT_CONFIG`, `HACHIMICODE_SERVER_PASSWORD`, and `HACHIMICODE_SERVER_USERNAME`.

## Agents

Two built-in agents, switched with `Tab`:

- **build** — the default full-access agent
- **plan** — read-only analysis; it denies edits and asks before running shell commands

A **general** subagent handles complex searches and multi-step work, invoked with `@general` in a message.

## Development

```bash
bun install
bun lint                              # oxlint
bun typecheck                         # all packages, via turbo
cd packages/opencode && bun typecheck # or a single package: never call tsc directly
```

Tests are run from a package directory, not the repository root:

```bash
cd packages/opencode && bun test
```

Changing the public `HttpApi` means regenerating the client, and generated files are never edited by hand:

```bash
cd packages/client && bun run generate
```

The home-screen sprites and the wordmark are generated, not hand-drawn. Rebuild the sprites from a folder of GIF or PNG files, and the wordmark from its dot-matrix font:

```bash
python3 script/build-home-memes.py --out packages/tui/src/component/home-memes/memes.json \
  --width 20 --height 24 --max-frames 16 smn1.gif smn2.gif dg.png
python3 script/build-wordmark.py --height 14 --gap 3
```

## Fork notes

Renaming a fork is never a pure string substitution. These keep their upstream names on purpose, because renaming them breaks working integrations:

- the hosted provider ids `opencode` and `opencode-go`, and the `opencode.ai` service endpoints
- the `x-opencode-*` HTTP headers, which the pinned prebuilt client artifact in `packages/app/vendor` speaks
- the provider `referrer` and `originator` fields that OAuth flows depend on
- the `.git/opencode` project identifier file, which ties existing repositories to their sessions
