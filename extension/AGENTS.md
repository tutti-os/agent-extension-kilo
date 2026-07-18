# Kilo Code package

This signed data-only package declares `agentKey: kilo`. Tutti resolves it as
Agent Target `extension:kilo` with open execution metadata `acp:kilo`; those
host identities are intentionally not extra manifest fields in the v1 package
schema. The release signing key ID is `tutti-kilo-release-v1`.

Keep this directory limited to declarative JSON, localized copy, passive local
images, and package documentation. It must never contain a runtime binary,
script, symlink, normalizer, renderer, or remote mutable asset.

Keep `icon.svg` as the transparent, mask-safe conversation-row glyph.
`sidebar-icon.svg` carries the colored yellow-tile, black-`KI/LO` identity
shared by the Provider Rail, conversation headers, Message Center, and mentions;
Tutti owns outer corner clipping.
