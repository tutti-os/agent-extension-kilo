# Reference review

This note is suitable for carrying into a future pull-request description. It
records implementation evidence without treating community registries as
runtime truth.

## Authoritative sources

- [Kilo source at 2c070e6e6f8387329f0243708ef82a4920502ec7](https://github.com/Kilo-Org/kilocode/tree/2c070e6e6f8387329f0243708ef82a4920502ec7)
- [Kilo CLI documentation](https://kilo.ai/docs/code-with-ai/platforms/cli)
- exact local probe of `@kilocode/cli@7.4.11`
- [Tutti Gemini extension at 8f8f2d9e794bc5a04f309cabe93aef4682ea2652](https://github.com/tutti-os/agent-extension-gemini/tree/8f8f2d9e794bc5a04f309cabe93aef4682ea2652)
- [Tutti CodeBuddy extension at 697155d716ce1174b202b1e1f999c290b5023c75](https://github.com/tutti-os/agent-extension-codebuddy/tree/697155d716ce1174b202b1e1f999c290b5023c75)
- [Agent Extension Skill at 4a053ce577bbf126ed614132bb176853855d7707](https://github.com/tutti-os/tutti-agent-extension-skill/tree/4a053ce577bbf126ed614132bb176853855d7707)

Fixed-source traceability:

- [package identity and both bin aliases](https://github.com/Kilo-Org/kilocode/blob/2c070e6e6f8387329f0243708ef82a4920502ec7/packages/opencode/package.json#L2-L21)
- [`acp` command and NDJSON stdio transport](https://github.com/Kilo-Org/kilocode/blob/2c070e6e6f8387329f0243708ef82a4920502ec7/packages/opencode/src/cli/cmd/acp.ts#L12-L64)
- [initialize capabilities and auth metadata](https://github.com/Kilo-Org/kilocode/blob/2c070e6e6f8387329f0243708ef82a4920502ec7/packages/opencode/src/acp/service.ts#L93-L147)
- [`session/new` dynamic state](https://github.com/Kilo-Org/kilocode/blob/2c070e6e6f8387329f0243708ef82a4920502ec7/packages/opencode/src/acp/service.ts#L164-L209)
- [dynamic model/effort/mode options](https://github.com/Kilo-Org/kilocode/blob/2c070e6e6f8387329f0243708ef82a4920502ec7/packages/opencode/src/acp/config-option.ts#L31-L190)
- [dynamic commands and Skills snapshot](https://github.com/Kilo-Org/kilocode/blob/2c070e6e6f8387329f0243708ef82a4920502ec7/packages/opencode/src/acp/service.ts#L734-L914)
- [permission request choices, not permission modes](https://github.com/Kilo-Org/kilocode/blob/2c070e6e6f8387329f0243708ef82a4920502ec7/packages/opencode/src/acp/permission.ts#L16-L60)
- [local Skill roots](https://github.com/Kilo-Org/kilocode/blob/2c070e6e6f8387329f0243708ef82a4920502ec7/packages/opencode/src/skill/index.ts#L24-L32)
  and [workspace/user discovery](https://github.com/Kilo-Org/kilocode/blob/2c070e6e6f8387329f0243708ef82a4920502ec7/packages/opencode/src/skill/index.ts#L210-L280)
- [`/name` Skill invocation](https://github.com/Kilo-Org/kilocode/blob/2c070e6e6f8387329f0243708ef82a4920502ec7/packages/opencode/src/acp/service.ts#L498-L552)
- [official authentication setup](https://github.com/Kilo-Org/kilocode/blob/2c070e6e6f8387329f0243708ef82a4920502ec7/packages/kilo-docs/pages/getting-started/setup-authentication.md#L18-L31)

## Adopted

- The fixed Kilo source defines the official npm package, both executable
  aliases, `acp` launch, initialize/session state, auth metadata, dynamic
  commands, and safe local Skill roots. The Kilo docs supply the manual login
  prerequisite; the product page is identity/context only, not protocol proof.
- The fixed Agent Extension Skill supplies the package contract, validator
  baseline, deterministic archive/signing tools, release schemas, workflow, and
  AWS bootstrap structure. This repository keeps those tools self-contained.
- The fixed Gemini extension contributes the concrete declarative repository
  and release-layout pattern. None of its Gemini-specific permission, model,
  binary, or provider semantics are copied.
- The fixed CodeBuddy extension is used as a second structural cross-check for
  open provider identity and runtime-owned composer projection. None of its
  CodeBuddy-specific launch, tools, capabilities, or setup copy are copied.
- Kilo's official `kilo acp` command and npm package identity are used.
- `kilocode` is accepted only as a discovery alias because npm 7.4.11 maps it
  to the same executable, both aliases passed version checks, and the shared
  executable passed ACP initialize.
- Runtime-owned model and configuration projection follows the standard ACP
  patterns demonstrated by the Tutti reference extensions.

## Corrected

- The generic scaffold defaults to `--acp`; Kilo uses the `acp` subcommand.
- The scaffold's sample permission modes and optimistic capability flags were
  removed or narrowed to the actual initialize/session evidence.
- The scaffold locale's “install in this project” wording was corrected to
  Tutti's managed runtime directory.
- The release template's unconditional `latest.json` upload was changed to an
  ETag-conditional update with fresh reads on conflict.
- Release `publishedAt` is derived from the source commit timestamp so a rerun
  after immutable upload produces byte-identical signed metadata.
- Package validation was extended to reject undeclared files and malformed,
  namespaced active, remote, or oversized presentation assets, invalid locales,
  contradictory capability profiles, and unknown contract fields.
- The generic probe was corrected to drain the current stdout batch and wait a
  bounded settle window after `session/new`, so asynchronous command updates
  are not missed.

## Community references

- [Zed Kilo registry](https://zed.dev/acp/agent/kilo): adopted only as evidence
  for the `acp` subcommand; its 7.4.7 pin was rejected as stale after npm and
  the exact 7.4.11 probe succeeded.
- [acpx registry](https://github.com/openclaw/acpx/blob/a518ea909eb91296b0d05c76345f1c8403ba830b/src/agent-registry.ts): useful for
  discovery comparison, but not used to define identity, capabilities, or
  version compatibility.
- [acpx conformance spec](https://github.com/openclaw/acpx/blob/a518ea909eb91296b0d05c76345f1c8403ba830b/conformance/spec/v1.md): useful for
  lifecycle edge cases, but the standard protocol and real runtime responses
  remain authoritative.

## Deliberately unverified or omitted

- No paid prompt, model billing, quota behavior, or provider-specific prompt
  path was exercised.
- No tool presentation mappings, permission IDs, or fixed slash command catalog
  are declared without sufficient ACP payload or exact source evidence. Skills
  declare only fixed-source-proven local roots and `/` invocation; dynamic and
  URL-backed roots are omitted.
- No official Kilo artwork is redistributed; neutral Tutti-maintained artwork
  avoids making an unsupported asset-license claim.
- No Tutti trusted-source/public-key registration, feature flag, production
  secret, AWS deployment, or publication is included in this repository.
