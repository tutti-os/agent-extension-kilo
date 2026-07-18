import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { validatePackage } from "./manifest.mjs";
import { readJSON, verifyReleaseSignature } from "./format.mjs";
import { validateRelease } from "./release.mjs";

export async function verifyRelease(options) {
  const release = validateRelease(await readJSON(path.resolve(options.releaseFile)));
  const publicKey = await readFile(path.resolve(options.publicKeyFile), "utf8");
  verifyReleaseSignature(release, publicKey, options.signingKeyId);
  const digest = await digestArtifact(options.artifact || release.artifactUrl);
  if (digest.sha256 !== release.artifactSha256 || digest.size !== release.artifactSizeBytes) {
    throw new Error("release artifact digest or size does not match signed metadata");
  }
  const artifactSource = String(options.artifact || release.artifactUrl);
  if (!/^https?:\/\//u.test(artifactSource)) {
    const archiveManifest = await validateArchive(path.resolve(artifactSource), release.agentKey);
    if (JSON.stringify(archiveManifest) !== JSON.stringify(release.manifest)) {
      throw new Error("archive manifest does not match signed release manifest");
    }
  }
  if (options.packageDir) {
    const manifest = await validatePackage(path.resolve(options.packageDir), release.agentKey);
    if (JSON.stringify(manifest) !== JSON.stringify(release.manifest)) {
      throw new Error("package manifest does not match signed release manifest");
    }
  }
  return { release, checkedArtifact: String(options.artifact || release.artifactUrl) };
}

export async function validateArchive(artifactPath, agentKey) {
  const listing = spawnSync("unzip", ["-Z1", artifactPath], { encoding: "utf8" });
  if (listing.error) throw listing.error;
  if (listing.status !== 0) {
    throw new Error(listing.stderr || `unzip listing exited with status ${listing.status}`);
  }
  const entries = listing.stdout.split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0) throw new Error("release archive is empty");
  const seen = new Set();
  for (const entry of entries) {
    const parts = entry.replace(/\/$/u, "").split("/");
    if (path.posix.isAbsolute(entry) || entry.includes("\\") || parts.includes("..") ||
        parts.includes("") || seen.has(entry)) {
      throw new Error(`release archive contains unsafe or duplicate entry: ${entry}`);
    }
    seen.add(entry);
  }
  const modeListing = spawnSync("unzip", ["-Z", "-l", artifactPath], {
    encoding: "utf8"
  });
  if (modeListing.error) throw modeListing.error;
  if (modeListing.status !== 0) {
    throw new Error(
      modeListing.stderr || `unzip metadata listing exited with status ${modeListing.status}`
    );
  }
  const modes = modeListing.stdout
    .split(/\r?\n/u)
    .map((line) => line.match(/^([bcdlps-][rwxStTs-]{9})\s/u)?.[1])
    .filter(Boolean);
  if (modes.length !== entries.length) {
    throw new Error("release archive entry metadata is incomplete");
  }
  for (const mode of modes) {
    if (mode[0] !== "d" && mode[0] !== "-") {
      throw new Error(`release archive contains unsupported entry type: ${mode[0]}`);
    }
    if (mode[0] === "-" && /[xst]/iu.test(mode.slice(1))) {
      throw new Error(`release archive contains executable file mode: ${mode}`);
    }
  }
  const root = await mkdtemp(path.join(tmpdir(), "tutti-agent-extension-verify-"));
  const packageDir = path.join(root, "package");
  try {
    const extracted = spawnSync("unzip", ["-qq", artifactPath, "-d", packageDir], {
      encoding: "utf8"
    });
    if (extracted.error) throw extracted.error;
    if (extracted.status !== 0) {
      throw new Error(extracted.stderr || `unzip exited with status ${extracted.status}`);
    }
    return await validatePackage(packageDir, agentKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function digestArtifact(value) {
  const source = String(value);
  if (/^https?:\/\//u.test(source)) {
    const response = await fetch(source);
    if (!response.ok || !response.body) {
      throw new Error(`artifact download failed with HTTP ${response.status}`);
    }
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of response.body) {
      hash.update(chunk);
      size += chunk.length;
    }
    return { sha256: hash.digest("hex"), size };
  }
  const filePath = path.resolve(source);
  const hash = createHash("sha256");
  let size = 0;
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => {
      hash.update(chunk);
      size += chunk.length;
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { sha256: hash.digest("hex"), size };
}
