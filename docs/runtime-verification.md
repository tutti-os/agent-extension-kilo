# Kilo 7.4.11 runtime verification

Verification dates: 2026-07-17 and an exact-version rerun on 2026-07-18
(Asia/Singapore).

The probe used an isolated temporary npm prefix and a clean temporary home. It
did not inherit credentials and did not send `session/prompt`.

## Package and executable

`npm view @kilocode/cli dist-tags.latest version bin repository dist.shasum dist.integrity --json`
reported:

```json
{
  "dist-tags.latest": "7.4.11",
  "version": "7.4.11",
  "bin": {
    "kilo": "bin/kilo",
    "kilocode": "bin/kilo"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/Kilo-Org/kilocode.git"
  },
  "dist.shasum": "b0c13728b5705b143b3539bc2c5fe37a82aaa79a",
  "dist.integrity": "sha512-v9w0Zv7SYkHbd8D2HK1qjJOnQACg9kOfjl3tRjErytnCWuALS5yRmmVP4ekXsR++3+SePMeGX6HOa5H6lWdfeQ=="
}
```

The exact package installed successfully into a dedicated temporary prefix.
Both `kilo --version` and
`kilocode --version` returned `7.4.11`.

## ACP initialize

`kilo acp` completed `initialize` using protocol version 1. The response
identified `Kilo` version `7.4.11` and advertised:

- `loadSession: true`;
- MCP HTTP and SSE support;
- embedded-context and image prompt support;
- session close, fork, list, and resume support;
- auth method `kilo-login`, instructing the user to run `kilo auth login`.

A fresh-home initialize-only probe completed in about 1.03 seconds under the
5-second discovery timeout.

## ACP session/new

The final rerun used:

```sh
python3 -B scripts/probe_acp_runtime.py \
  --cwd "$PWD" \
  --timeout 15 \
  --notification-settle-ms 500 \
  --clean-env \
  -- "$runtime_root/node_modules/.bin/kilo" acp
```

It exited 0. `session/new` returned a non-empty session ID and dynamic
`configOptions`:

- model: select catalog with 272 options on the final 2026-07-18 rerun (271 and
  272 were observed across earlier runs), confirming that this network-backed
  catalog is dynamic;
- effort: select option, with runtime values
  `none/low/medium/high/xhigh/max`;
- mode: select option, with runtime values
  `code/ask/debug/orchestrator/plan`.

The response did not contain an independent permission-mode or tool catalog.
Within the bounded 500 ms settle window, the runtime sent one `session/update`
with `available_commands_update` and five commands. Command names were not
retained and are not frozen into the signed profile. This confirms that the
runtime publishes commands asynchronously; the extension keeps them
runtime-owned and does not reinterpret `mode` as permission.

## Authentication and failure behavior

With a dedicated clean home, `kilo auth list` exited 0 and reported
`0 credentials`, yet initialize
and session creation succeeded. Authentication advertisement and session
creation do not prove prompt readiness, so no supported-prompt claim is made.

In an earlier clean-home run where the execution sandbox denied outbound
network access, the minimum useful runtime error was:

```text
Failed to fetch models.dev
```

The associated request targeted `https://models.dev/api.json`. A final
network-denied rerun exited 1 at ACP startup with a generic `ServeError`, while
restoring network access made the identical probe command exit 0 and complete
initialize/session creation. The sandbox network toggle is environment-owned,
so it is not represented as a portable repository command. No secrets, full
environment dump, session identifier, command names, or model catalog are
retained here.

## Version decision

The [Zed ACP registry entry](https://zed.dev/acp/agent/kilo) still showed
`npx @kilocode/cli@7.4.7 acp` on 2026-07-18. That entry confirmed the
`acp` subcommand but was behind npm's official 7.4.11 release. The extension
pins 7.4.11 because that exact version passed executable, initialize, and
session creation checks; no fallback to 7.4.7 is implemented.
