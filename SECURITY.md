# Security

Do not report vulnerabilities through a public issue. Follow the Tutti
security policy at https://github.com/tutti-os/tutti/security/policy.

Never attach signing keys, access tokens, credentials, complete environment
maps, or private Agent prompts to a report.

Reports about this declarative package, validation bypasses, release signing,
archive extraction assumptions, or workflow permissions belong with Tutti.
Vulnerabilities in the Kilo CLI itself should also be reported through the
[Kilo security policy](https://github.com/Kilo-Org/kilocode/security/policy).

The extension repository never stores the production Ed25519 private key or
AWS credentials. Releases use a repository secret for signing and GitHub OIDC
for short-lived AWS credentials. Local verification must use an ephemeral test
key and redacted ACP probe output.
