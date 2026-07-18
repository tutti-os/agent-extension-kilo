# Contributing

Use Node.js 24 and pnpm 10.11.0. Keep the extension package declarative and
pin every runtime dependency exactly.

Before opening a pull request, run:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm package:tutti-agent
python3 scripts/validate_agent_extension.py build/tutti-agent/package
```

Changes to the runtime pin, executable aliases, launch arguments, discovery
constraint, capabilities, composer mappings, commands, tools, or Skills roots
must cite the fixed official source or a real ACP payload. Re-run
`scripts/probe_acp_runtime.py` through `initialize` and `session/new` in an
isolated runtime directory, without sending a paid prompt, and update
`docs/runtime-verification.md` with redacted evidence.

Keep `extension/` data-only. Do not add executable scripts, symlinks, remote
assets, renderers, normalizers, runtime binaries, or undeclared files. Do not
hardcode runtime-owned model, reasoning, mode, permission, or command catalogs.

Use Conventional Commits and certify every commit with DCO sign-off:

```sh
git commit -s -m "fix(agent): describe the change"
```

Never commit signing keys, cloud credentials, runtime binaries, generated
archives, or `node_modules`.
