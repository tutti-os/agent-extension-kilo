import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRelease } from "../lib/release.mjs";
import { createReproducibleZip } from "../lib/archive.mjs";
import { validatePackage } from "../lib/manifest.mjs";
import { validateArchive, verifyRelease } from "../lib/verify.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const sourceExtension = path.join(repositoryRoot, "extension");
const pythonValidator = path.join(repositoryRoot, "scripts", "validate_agent_extension.py");
const releaseBuilder = path.join(
  repositoryRoot,
  "scripts",
  "release",
  "bin",
  "build-tutti-agent-extension-release.mjs"
);

test("builds a reproducible signed extension release", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "agent-extension-release-test-")
  );
  const packageDir = await writeFixture(path.join(root, "package"));
  const keys = generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKeyPath = path.join(root, "public.pem");
  await writeFile(
    publicKeyPath,
    keys.publicKey.export({ type: "spki", format: "pem" })
  );
  const options = {
    agentKey: "kilo",
    packageDir,
    outputDir: path.join(root, "out"),
    baseUrl: "https://example.test/tutti-agent-releases",
    version: "2.0.3",
    signingKeyId: "tutti-kilo-release-v1",
    privateKey,
    publishedAt: "2026-07-14T00:00:00Z",
    gitSha: "abc123"
  };
  const sourceManifest = await readFile(
    path.join(packageDir, "tutti.agent.json")
  );
  const first = await buildRelease(options);
  const firstArtifact = await readFile(first.artifactPath);
  const listing = spawnSync("unzip", ["-Z1", first.artifactPath], {
    encoding: "utf8"
  });
  assert.equal(listing.status, 0, listing.stderr);
  const entries = listing.stdout.trim().split(/\r?\n/u);
  assert.deepEqual(entries, [...entries].sort());
  const metadata = spawnSync("unzip", ["-Z", "-l", first.artifactPath], {
    encoding: "utf8"
  });
  assert.equal(metadata.status, 0, metadata.stderr);
  const modes = metadata.stdout
    .split(/\r?\n/u)
    .map((line) => line.match(/^([d-][rwx-]{9})\s/u)?.[1])
    .filter(Boolean);
  assert.ok(modes.includes("drwxr-xr-x"));
  assert.ok(modes.includes("-rw-r--r--"));
  assert.ok(modes.every((mode) => mode === "drwxr-xr-x" || mode === "-rw-r--r--"));
  await chmod(path.join(packageDir, "tutti.agent.json"), 0o600);
  const second = await buildRelease(options);
  assert.deepEqual(await readFile(second.artifactPath), firstArtifact);
  assert.deepEqual(
    await readFile(path.join(packageDir, "tutti.agent.json")),
    sourceManifest
  );
  await verifyRelease({
    releaseFile: second.releaseJsonPath,
    artifact: second.artifactPath,
    publicKeyFile: publicKeyPath,
    signingKeyId: "tutti-kilo-release-v1",
    packageDir
  });
});

test("derives stable release metadata from the source commit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-extension-cli-release-test-"));
  const packageDir = await writeFixture(path.join(root, "package"));
  const privateKeyPath = path.join(root, "private.pem");
  await writeFile(
    privateKeyPath,
    generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" })
  );
  const commonArgs = [
    releaseBuilder,
    "--agent-key", "kilo",
    "--package-dir", packageDir,
    "--base-url", "https://example.test/tutti-agent-releases",
    "--version", "2.0.3",
    "--signing-key-id", "tutti-kilo-release-v1",
    "--private-key-file", privateKeyPath
  ];
  const firstOutput = path.join(root, "first");
  const secondOutput = path.join(root, "second");
  for (const outputDir of [firstOutput, secondOutput]) {
    const result = spawnSync(
      process.execPath,
      [...commonArgs, "--output-dir", outputDir],
      { cwd: repositoryRoot, encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr);
  }
  const relativeRelease = path.join("agents", "kilo", "2.0.3", "release.json");
  const firstRelease = await readFile(path.join(firstOutput, relativeRelease));
  assert.deepEqual(await readFile(path.join(secondOutput, relativeRelease)), firstRelease);
  const release = JSON.parse(firstRelease);
  const commitTimestamp = spawnSync("git", ["show", "-s", "--format=%cI", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8"
  }).stdout.trim();
  assert.equal(release.publishedAt, new Date(commitTimestamp).toISOString().replace(/\.\d{3}Z$/u, "Z"));
});

test("the complete release fixture passes both package validators", async () => {
  const packageDir = await temporaryFixture();
  await validatePackage(packageDir, "kilo");
  const result = spawnSync("python3", [pythonValidator, packageDir], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
});

test("sorts archive entries globally with POSIX paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-extension-order-test-"));
  const packageDir = path.join(root, "package");
  await mkdir(path.join(packageDir, "a"), { recursive: true });
  await writeFile(path.join(packageDir, "a", "child.json"), "{}\n");
  await writeFile(path.join(packageDir, "a.json"), "{}\n");
  await writeFile(path.join(packageDir, "z.json"), "{}\n");
  const artifactPath = path.join(root, "ordered.zip");
  await createReproducibleZip(packageDir, artifactPath);
  const listing = spawnSync("unzip", ["-Z1", artifactPath], {
    encoding: "utf8"
  });
  assert.equal(listing.status, 0, listing.stderr);
  assert.deepEqual(listing.stdout.trim().split(/\r?\n/u), [
    "a.json",
    "a/",
    "a/child.json",
    "z.json"
  ]);
});

test("rejects executable package content", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "agent-extension-release-test-")
  );
  const packageDir = await writeFixture(path.join(root, "package"));
  const executable = path.join(packageDir, "profiles", "install.json");
  await writeFile(executable, "{}\n");
  await chmod(executable, 0o755);
  await assert.rejects(
    buildRelease({
      agentKey: "kilo",
      packageDir,
      outputDir: path.join(root, "out"),
      baseUrl: "https://example.test/releases",
      signingKeyId: "tutti-kilo-release-v1",
      privateKey: generateKeyPairSync("ed25519").privateKey
    }),
    /executable file/u
  );
});

test("rejects symlink package content", async () => {
  const packageDir = await temporaryFixture();
  await symlink("icon.svg", path.join(packageDir, "assets", "linked.svg"));
  await assert.rejects(validatePackage(packageDir, "kilo"), /symlink/u);
});

test("rejects unsafe archive entry types and executable modes before extraction", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-extension-archive-test-"));
  const source = path.join(root, "source");
  await mkdir(source);
  await writeFile(path.join(source, "target"), "target\n");
  await symlink("target", path.join(source, "linked"));
  const symlinkArchive = path.join(root, "symlink.zip");
  const symlinkZip = spawnSync("zip", ["-X", "-q", "-y", symlinkArchive, "linked"], {
    cwd: source,
    encoding: "utf8"
  });
  assert.equal(symlinkZip.status, 0, symlinkZip.stderr);
  await assert.rejects(
    validateArchive(symlinkArchive, "kilo"),
    /unsupported entry type/u
  );

  const executable = path.join(source, "executable.json");
  await writeFile(executable, "{}\n");
  await chmod(executable, 0o755);
  const executableArchive = path.join(root, "executable.zip");
  const executableZip = spawnSync("zip", ["-X", "-q", executableArchive, "executable.json"], {
    cwd: source,
    encoding: "utf8"
  });
  assert.equal(executableZip.status, 0, executableZip.stderr);
  await assert.rejects(
    validateArchive(executableArchive, "kilo"),
    /executable file mode/u
  );
});

test("rejects an unsafe referenced path", async () => {
  const packageDir = await temporaryFixture();
  await mutateManifest(packageDir, (manifest) => {
    manifest.icon.src = "../outside.svg";
  });
  await assert.rejects(validatePackage(packageDir, "kilo"), /relative package path/u);
});

test("rejects undeclared package files", async () => {
  const packageDir = await temporaryFixture();
  await writeFile(path.join(packageDir, "profiles", "injected.json"), "{}\n");
  await assert.rejects(validatePackage(packageDir, "kilo"), /undeclared file/u);
});

test("rejects undeclared package directories", async () => {
  const packageDir = await temporaryFixture();
  await mkdir(path.join(packageDir, "scripts"));
  await assert.rejects(validatePackage(packageDir, "kilo"), /undeclared directory/u);
});

test("rejects an unpinned runtime package", async () => {
  const packageDir = await temporaryFixture();
  await mutateManifest(packageDir, (manifest) => {
    manifest.runtime.install.args[manifest.runtime.install.args.length - 1] = "@kilocode/cli@latest";
  });
  await assert.rejects(validatePackage(packageDir, "kilo"), /exact package@version/u);
});

test("rejects mixed or redirected runtime install arguments", async () => {
  const packageDir = await temporaryFixture();
  await mutateManifest(packageDir, (manifest) => {
    manifest.runtime.install.args.push("other-package@latest");
  });
  await assert.rejects(validatePackage(packageDir, "kilo"), /must be exactly/u);

  const redirected = await temporaryFixture();
  await mutateManifest(redirected, (manifest) => {
    manifest.runtime.install.args.splice(2, 0, "/tmp/outside");
  });
  await assert.rejects(validatePackage(redirected, "kilo"), /must be exactly/u);
});

test("rejects launch executables outside the exact install root", async () => {
  for (const executable of [
    "${installRoot}-outside/kilo",
    "${installRoot}/../outside/kilo",
    "${installRoot}/foo\\..\\..\\outside\\kilo",
    "${projectRoot}/node_modules/.bin/kilo"
  ]) {
    const packageDir = await temporaryFixture();
    await mutateManifest(packageDir, (manifest) => {
      manifest.runtime.launch.executable = executable;
    });
    await assert.rejects(
      validatePackage(packageDir, "kilo"),
      /must stay under \$\{installRoot\}/u
    );
  }
});

test("rejects oversized presentation assets", async () => {
  const packageDir = await temporaryFixture();
  await writeFile(path.join(packageDir, "assets", "icon.svg"), `<svg>${" ".repeat((256 << 10) + 1)}</svg>`);
  await assert.rejects(validatePackage(packageDir, "kilo"), /256 KiB/u);
});

test("rejects content disguised as raster presentation assets", async () => {
  for (const extension of ["png", "jpg", "webp"]) {
    const packageDir = await temporaryFixture();
    const manifest = JSON.parse(await readFile(path.join(packageDir, "tutti.agent.json"), "utf8"));
    const source = path.join(packageDir, manifest.heroImage.src);
    const target = path.join(packageDir, "assets", `hero-image.${extension}`);
    if (source !== target) {
      await rename(source, target);
    }
    await writeFile(target, "not an image\n");
    await mutateManifest(packageDir, (manifest) => {
      manifest.heroImage.src = `assets/hero-image.${extension}`;
    });
    await assert.rejects(validatePackage(packageDir, "kilo"), /valid (?:PNG|JPEG|WebP) container/u);
  }
});

test("rejects active or remotely referenced SVG assets", async () => {
  const packageDir = await temporaryFixture();
  await writeFile(
    path.join(packageDir, "assets", "icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.test/remote.png"/></svg>\n'
  );
  await assert.rejects(validatePackage(packageDir, "kilo"), /active or remote/u);

  for (const href of ["data:text/html,active", "relative-image.png", "&#106;avascript:alert(1)"]) {
    const encoded = await temporaryFixture();
    await writeFile(
      path.join(encoded, "assets", "icon.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg"><image href="${href}"/></svg>\n`
    );
    await assert.rejects(validatePackage(encoded, "kilo"), /active or remote/u);
  }
});

test("rejects quoted CSS URLs and active XML in SVG assets", async () => {
  const remote = await temporaryFixture();
  await writeFile(
    path.join(remote, "assets", "icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url( \'https://example.test/image.svg\' )"/></svg>\n'
  );
  await assert.rejects(validatePackage(remote, "kilo"), /active or remote/u);

  const encodedRemote = await temporaryFixture();
  await writeFile(
    path.join(encodedRemote, "assets", "icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url( &#104;ttps://example.test/image.svg )"/></svg>\n'
  );
  await assert.rejects(validatePackage(encodedRemote, "kilo"), /active or remote/u);

  const processingInstruction = await temporaryFixture();
  await writeFile(
    path.join(processingInstruction, "assets", "icon.svg"),
    '<?xml-stylesheet href="https://example.test/style.css"?><svg xmlns="http://www.w3.org/2000/svg"/>\n'
  );
  await assert.rejects(validatePackage(processingInstruction, "kilo"), /active or remote/u);
});

test("rejects malformed and namespaced active SVG content", async () => {
  const malformed = await temporaryFixture();
  await writeFile(
    path.join(malformed, "assets", "icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>\n'
  );
  await assert.rejects(validatePackage(malformed, "kilo"), /well-formed XML/u);

  const namespaced = await temporaryFixture();
  await writeFile(
    path.join(namespaced, "assets", "icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/2000/svg"><x:script/></svg>\n'
  );
  await assert.rejects(validatePackage(namespaced, "kilo"), /active or remote/u);

  const malformedAttribute = await temporaryFixture();
  await writeFile(
    path.join(malformedAttribute, "assets", "icon.svg"),
    '<svg xmlns=="http://www.w3.org/2000/svg"/>\n'
  );
  await assert.rejects(validatePackage(malformedAttribute, "kilo"), /well-formed XML/u);

  const multipleRoots = await temporaryFixture();
  await writeFile(
    path.join(multipleRoots, "assets", "icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"/><svg/>\n'
  );
  await assert.rejects(validatePackage(multipleRoots, "kilo"), /exactly one root/u);
});

test("rejects invalid locales and contradictory signed capabilities", async () => {
  const invalidLocale = await temporaryFixture();
  await writeFile(path.join(invalidLocale, "locales", "en.json"), "not json\n");
  await assert.rejects(validatePackage(invalidLocale, "kilo"), /JSON/u);

  const contradictory = await temporaryFixture();
  const capabilitiesPath = path.join(contradictory, "profiles", "capabilities.json");
  const capabilities = JSON.parse(await readFile(capabilitiesPath, "utf8"));
  capabilities.declared.skills = false;
  await writeFile(capabilitiesPath, `${JSON.stringify(capabilities, null, 2)}\n`);
  await assert.rejects(
    validatePackage(contradictory, "kilo"),
    /skills must match composer skills/u
  );
});

test("rejects a mismatched package identity", async () => {
  const packageDir = await temporaryFixture();
  await mutateManifest(packageDir, (manifest) => {
    manifest.agentKey = "other";
  });
  await assert.rejects(validatePackage(packageDir, "kilo"), /does not match/u);
});

async function writeFixture(packageDir) {
  await cp(sourceExtension, packageDir, { recursive: true, dereference: false });
  return packageDir;
}

async function temporaryFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "agent-extension-release-test-"));
  return writeFixture(path.join(root, "package"));
}

async function mutateManifest(packageDir, mutation) {
  const manifestPath = path.join(packageDir, "tutti.agent.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  mutation(manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
