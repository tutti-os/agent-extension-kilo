import assert from "node:assert/strict";
import test from "node:test";

import { validateVersions } from "../lib/versions.mjs";

test("preserves historical manifest v1 releases while indexing v2", () => {
  const release = {
    schemaVersion: "tutti.agent.release.v1",
    agentKey: "example",
    version: "1.0.0",
    manifest: {
      schemaVersion: "tutti.agent.manifest.v1",
      agentKey: "example",
      version: "1.0.0"
    },
    artifactUrl: "https://example.test/agents/example/1.0.0/example-1.0.0.zip",
    artifactSha256: "a".repeat(64),
    artifactSizeBytes: 1,
    signature: {
      algorithm: "ed25519",
      keyId: "example-v1",
      value: "signed"
    }
  };

  assert.equal(
    validateVersions({
      schemaVersion: "tutti.agent.versions.v1",
      agentKey: "example",
      versions: [
        {
          version: "1.0.0",
          minTuttiVersion: "0.0.0",
          requiredHostCapabilities: [],
          status: "active",
          release
        }
      ]
    }).versions[0].release,
    release
  );
});

