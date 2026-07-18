import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const validator = path.join(repositoryRoot, "scripts", "validate_agent_extension.py");
const sourceExtension = path.join(repositoryRoot, "extension");

test("validates the source extension package", async () => {
  const packageDir = await copyExtension();
  const result = validate(packageDir);
  assert.equal(result.status, 0, result.stderr);
});

test("rejects unsafe data-only package mutations", async (context) => {
  const cases = [
    ["executable", async (packageDir) => {
      await chmod(path.join(packageDir, "profiles", "tools.json"), 0o755);
    }, /executable files are not allowed/u],
    ["symlink", async (packageDir) => {
      await symlink("icon.svg", path.join(packageDir, "assets", "linked.svg"));
    }, /symlinks are not allowed/u],
    ["unsafe path", async (packageDir) => {
      await mutateManifest(packageDir, (manifest) => {
        manifest.icon.src = "../icon.svg";
      });
    }, /safe relative POSIX path/u],
    ["undeclared file", async (packageDir) => {
      await writeFile(path.join(packageDir, "profiles", "injected.json"), "{}\n");
    }, /undeclared package file/u],
    ["undeclared directory", async (packageDir) => {
      await mkdir(path.join(packageDir, "scripts"));
    }, /undeclared package directory/u],
    ["unpinned package", async (packageDir) => {
      await mutateManifest(packageDir, (manifest) => {
        manifest.runtime.install.args[manifest.runtime.install.args.length - 1] = "@kilocode/cli@latest";
      });
    }, /exact npm package@version/u],
    ["mixed package specs", async (packageDir) => {
      await mutateManifest(packageDir, (manifest) => {
        manifest.runtime.install.args.push("other-package@latest");
      });
    }, /must be exactly/u],
    ["install root override", async (packageDir) => {
      await mutateManifest(packageDir, (manifest) => {
        manifest.runtime.install.args.splice(2, 0, "/tmp/outside");
      });
    }, /must be exactly/u],
    ["launch root prefix collision", async (packageDir) => {
      await mutateManifest(packageDir, (manifest) => {
        manifest.runtime.launch.executable = "${installRoot}-outside/kilo";
      });
    }, /must stay under \$\{installRoot\}/u],
    ["launch path traversal", async (packageDir) => {
      await mutateManifest(packageDir, (manifest) => {
        manifest.runtime.launch.executable = "${installRoot}/../outside/kilo";
      });
    }, /must stay under \$\{installRoot\}/u],
    ["launch backslash traversal", async (packageDir) => {
      await mutateManifest(packageDir, (manifest) => {
        manifest.runtime.launch.executable = "${installRoot}/foo\\..\\..\\outside\\kilo";
      });
    }, /must stay under \$\{installRoot\}/u],
    ["launch project root", async (packageDir) => {
      await mutateManifest(packageDir, (manifest) => {
        manifest.runtime.launch.executable = "${projectRoot}/node_modules/.bin/kilo";
      });
    }, /must stay under \$\{installRoot\}/u],
    ["oversized asset", async (packageDir) => {
      await writeFile(
        path.join(packageDir, "assets", "icon.svg"),
        `<svg xmlns="http://www.w3.org/2000/svg">${" ".repeat((256 << 10) + 1)}</svg>`
      );
    }, /256 KiB/u],
    ["fake PNG", async (packageDir) => {
      await replaceHeroWithFakeRaster(packageDir, "png");
    }, /valid PNG container/u],
    ["fake JPEG", async (packageDir) => {
      await replaceHeroWithFakeRaster(packageDir, "jpg");
    }, /valid JPEG container/u],
    ["fake WebP", async (packageDir) => {
      await replaceHeroWithFakeRaster(packageDir, "webp");
    }, /valid WebP container/u],
    ["remote SVG", async (packageDir) => {
      await writeFile(
        path.join(packageDir, "assets", "icon.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.test/remote.png"/></svg>\n'
      );
    }, /remote reference/u],
    ["quoted CSS remote SVG", async (packageDir) => {
      await writeFile(
        path.join(packageDir, "assets", "icon.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url( \'https://example.test/image.svg\' )"/></svg>\n'
      );
    }, /remote reference/u],
    ["entity-encoded CSS remote SVG", async (packageDir) => {
      await writeFile(
        path.join(packageDir, "assets", "icon.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url( &#104;ttps://example.test/image.svg )"/></svg>\n'
      );
    }, /active or remote content/u],
    ["XML stylesheet SVG", async (packageDir) => {
      await writeFile(
        path.join(packageDir, "assets", "icon.svg"),
        '<?xml-stylesheet href="https://example.test/style.css"?><svg xmlns="http://www.w3.org/2000/svg"/>\n'
      );
    }, /active XML content/u],
    ["unknown profile field", async (packageDir) => {
      const profilePath = path.join(packageDir, "profiles", "composer.json");
      const profile = JSON.parse(await readFile(profilePath, "utf8"));
      profile.renderer = "remote";
      await writeFile(profilePath, `${JSON.stringify(profile)}\n`);
    }, /unsupported fields/u],
    ["unknown asset descriptor field", async (packageDir) => {
      await mutateManifest(packageDir, (manifest) => {
        manifest.icon.remote = "https://example.test/icon.svg";
      });
    }, /icon contains unsupported fields/u],
    ["unknown manifest profile", async (packageDir) => {
      await mutateManifest(packageDir, (manifest) => {
        manifest.profiles.events = "profiles/tools.json";
      });
    }, /profiles contains unsupported fields/u],
    ["unknown localization field", async (packageDir) => {
      await mutateManifest(packageDir, (manifest) => {
        manifest.localizationInfo.remote = "https://example.test/locales.json";
      });
    }, /localizationInfo contains unsupported fields/u],
    ["contradictory skills capability", async (packageDir) => {
      const profilePath = path.join(packageDir, "profiles", "capabilities.json");
      const profile = JSON.parse(await readFile(profilePath, "utf8"));
      profile.declared.skills = false;
      await writeFile(profilePath, `${JSON.stringify(profile)}\n`);
    }, /skills must match/u],
    ["contradictory permission modes capability", async (packageDir) => {
      const profilePath = path.join(packageDir, "profiles", "capabilities.json");
      const profile = JSON.parse(await readFile(profilePath, "utf8"));
      profile.declared.permissionModes = true;
      await writeFile(profilePath, `${JSON.stringify(profile)}\n`);
    }, /permissionModes must match/u],
    ["invalid SVG", async (packageDir) => {
      await writeFile(path.join(packageDir, "assets", "icon.svg"), "not an svg\n");
    }, /well-formed XML/u]
  ];

  for (const [name, mutate, expected] of cases) {
    await context.test(name, async () => {
      const packageDir = await copyExtension();
      await mutate(packageDir);
      const result = validate(packageDir);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
    });
  }
});

async function copyExtension() {
  const root = await mkdtemp(path.join(tmpdir(), "kilo-extension-validator-"));
  const packageDir = path.join(root, "package");
  await cp(sourceExtension, packageDir, { recursive: true, dereference: false });
  return packageDir;
}

function validate(packageDir) {
  return spawnSync("python3", [validator, packageDir], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
}

async function mutateManifest(packageDir, mutation) {
  const manifestPath = path.join(packageDir, "tutti.agent.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  mutation(manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function replaceHeroWithFakeRaster(packageDir, extension) {
  const source = path.join(packageDir, "assets", "hero-image.svg");
  const target = path.join(packageDir, "assets", `hero-image.${extension}`);
  await rename(source, target);
  await writeFile(target, "not an image\n");
  await mutateManifest(packageDir, (manifest) => {
    manifest.heroImage.src = `assets/hero-image.${extension}`;
  });
}
