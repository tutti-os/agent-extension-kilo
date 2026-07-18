# Kilo Code Agent Extension for Tutti

This repository packages the official Kilo Code CLI as a declarative Tutti
Agent Extension over the standard Agent Client Protocol (ACP). It is not a
Kilo fork, does not redistribute the Kilo runtime, and does not add
Kilo-specific runtime, provider enum, event parsing, or React code to Tutti.

## Identity and trust boundary

| Contract | Value |
| --- | --- |
| Repository | `tutti-os/agent-extension-kilo` |
| Agent key | `kilo` |
| Tutti Agent Target | `extension:kilo` |
| Open provider metadata | `acp:kilo` |
| Extension version | `1.0.0` |
| Signing key ID | `tutti-kilo-release-v1` |
| Release base URL | `https://d1x7gb6wqsqmnm.cloudfront.net/tutti-agent-releases` |

The v1 package manifest intentionally contains `agentKey`, not additional
`provider` or `agentTargetId` fields. Tutti resolves the signed, fixed
`extension:kilo` Target before preserving the open `acp:kilo` provider value.
The provider string alone is never launch authority.

Everything under `extension/` is data-only: JSON, localized copy, passive
local images, and package documentation. The validator rejects symlinks,
executables, undeclared files, unsafe paths, unpinned packages, oversized or
active images, runtime binaries, and development directories.

## Runtime contract

The managed fallback installs exactly `@kilocode/cli@7.4.11` below Tutti's
`${installRoot}` and launches:

```text
${installRoot}/node_modules/.bin/kilo acp
```

Discovery checks user-local binaries first, in order: `kilo`, then the
official `kilocode` alias. Both aliases from 7.4.11 point to `bin/kilo` and
report `7.4.11`; the shared executable passed ACP initialize. The supported
constraint is `>=7.4.11 <8.0.0`; managed installation never silently falls
back to another version and never touches a workspace `package.json`, lockfile,
`node_modules`, or global package state.

On 2026-07-18, npm reported `latest` as 7.4.11 while the Zed ACP registry page
still launched `@kilocode/cli@7.4.7`. Registry metadata is useful for command
discovery, but is not authoritative for the runtime pin. Version 7.4.11 was
selected only after exact installation, `--version`, ACP `initialize`, and
`session/new` all succeeded. See [runtime verification](docs/runtime-verification.md).

## Authentication and provider setup

Kilo 7.4.11 advertises one ACP auth method: run `kilo auth login` in a terminal.
The CLI also supports provider configuration, including API keys referenced
from trusted global configuration or environment-backed configuration. See the
[official CLI documentation](https://kilo.ai/docs/code-with-ai/platforms/cli).

At the reviewed source commit, ACP `authenticate` validates the method ID but
does not perform login, and terminal-auth metadata incorrectly names the
legacy `opencode` executable. Tutti setup copy therefore gives the verified
manual `kilo auth login` command instead of treating ACP auth advertisement as
an authenticated session.

A clean-home probe with `kilo auth list` reporting `0 credentials` could still
complete ACP initialize and create a session. That proves protocol negotiation,
not model access: no paid prompt was sent, and prompts still require Kilo login
or a usable AI provider. The first uncached ACP startup may need network access
to `https://models.dev/api.json`; without it the observed minimum error was
`Failed to fetch models.dev`.

## Runtime-owned composer state

The extension does not hardcode models, reasoning values, modes, permission
IDs, slash commands, or tool IDs. The successful `session/new` response exposed
dynamic `configOptions` for model, effort, and mode. It did not expose an
independent permission catalog, command catalog, or tool catalog. Official
source sends commands and discovered Skills through dynamic ACP command
updates, so the signed profile does not freeze a slash-command list. Unknown
tools stay with Tutti's generic renderer. Model and configuration choices are
projected from ACP session state.

Official source proves `/name` Skill invocation and local discovery under
workspace `.kilo/skills`, `.kilocode/skills`, `.agents/skills`, and
`.claude/skills`, plus user `.agents/skills` and `.claude/skills`. Only those
safe local roots are declared; config-provided URLs and platform-dependent
config directories are intentionally omitted.

## Local setup and validation

Requirements are Node.js 24, pnpm 10.11.0, Python 3, and the `zip` command used
by deterministic release tests.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm package:tutti-agent
python3 scripts/validate_agent_extension.py build/tutti-agent/package
```

Probe an already installed official runtime without sending a prompt:

```sh
python3 scripts/probe_acp_runtime.py \
  --cwd /path/to/project \
  --timeout 10 \
  --clean-env \
  -- kilo acp
```

For an isolated exact-version check, install into a temporary prefix rather
than the project or global npm state:

```sh
runtime_root="$(mktemp -d)"
npm install --prefix "$runtime_root" --no-save @kilocode/cli@7.4.11
"$runtime_root/node_modules/.bin/kilo" --version
python3 scripts/probe_acp_runtime.py \
  --cwd /path/to/project \
  --clean-env \
  -- "$runtime_root/node_modules/.bin/kilo" acp
```

The probe prints a redacted catalog summary to stdout by default, diagnostics
to stderr, disables browser opening, answers unsupported Agent-to-client
requests with a standard JSON-RPC error, drains the response batch, waits a
bounded 250 ms for asynchronous command/Skill updates, and then terminates the
runtime. `--clean-env` drops inherited provider configuration and creates
a fresh temporary HOME that is removed after the probe; use `--env HOME=...`
only when explicitly testing a prepared isolated home. `--full` is available
for local debugging but can expose custom provider/model names and session IDs;
do not attach its output, full environment maps, credentials, or paid prompts
to shared evidence.

## Release and AWS bootstrap

`scripts/release/` is self-contained. It creates a path-sorted ZIP with fixed
timestamps, records SHA-256 and byte size, derives `publishedAt` from the source
commit for safe reruns, signs `release.json` with Ed25519, and verifies the
archive and manifest. The release workflow:

1. installs with the frozen lockfile and runs the full repository checks;
2. builds and validates a clean `extension/` package;
3. uploads versioned ZIP and `release.json` objects with
   `If-None-Match: *`;
4. updates `versions.json` and `latest.json` with ETag preconditions and fresh
   reads on retry;
5. invalidates only the two mutable CDN paths and waits for that invalidation;
6. downloads the public release metadata and ZIP, verifies digest, size,
   manifest identity, and Ed25519 signature, then confirms the public mutable
   indexes expose the active version.

The workflow also requires an explicit `min_tutti_version` dispatch input.
There is no permissive guessed default; set it only after the target Tutti build
accepts the manifest/profile schemas and passes local Target discovery.

Configure these GitHub repository variables:

- `TUTTI_AGENT_RELEASES_AWS_REGION`
- `TUTTI_AGENT_RELEASES_AWS_ROLE_ARN`
- `TUTTI_AGENT_RELEASES_S3_BUCKET`
- `TUTTI_AGENT_RELEASES_CLOUDFRONT_DISTRIBUTION_ID`

Store the Ed25519 private key only in the repository secret
`TUTTI_AGENT_EXTENSION_SIGNING_PRIVATE_KEY`. Use GitHub OIDC; never commit a
private signing key, AWS credential, runtime binary, archive, or `node_modules`.
`infra/aws/agent-extension-release-infrastructure.yaml` provides a
repository-scoped role, private versioned S3 bucket, CloudFront origin access
control, and distribution. Prefer organization-provided shared infrastructure
when available.

This repository owns its per-agent `versions.json` and `latest.json`. A shared
multi-agent catalog and Tutti trusted-source/public-key registration are host
rollout concerns and are intentionally not changed here.

## Artwork and trademark notice

The icon and hero image are original, neutral, Tutti-maintained geometric
artwork. They are not copied from Kilo assets and do not claim to be an official
Kilo logo because redistribution permission for an official identity asset was
not established for this package. “Kilo Code” and related marks belong to their
respective owners and are used only to identify compatibility with the
official runtime. Both packaged SVGs are local, passive, and below 256 KiB.

## Known limits

- No prompt was sent during verification, so model billing, quota, and
  provider-specific prompt behavior remain unverified.
- First startup can fail when `models.dev` is unavailable and no usable catalog
  is cached.
- Permission IDs, fixed slash commands, and tool semantic mappings are not
  declared because the runtime owns them or the probe/source did not provide
  enough evidence for Tutti-specific presentation fields.
- This repository does not publish 1.0.0, configure production credentials, or
  enable the source in Tutti.

See [reference review](docs/reference-review.md) for the evidence hierarchy and
the community references that were adopted, corrected, or deliberately not
used.
