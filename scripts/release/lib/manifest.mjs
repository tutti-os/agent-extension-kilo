import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  isRelativePackagePath,
  requireSafeSegment,
  requireSemver,
  requireString
} from "./format.mjs";

export const manifestSchemaVersion = "tutti.agent.manifest.v1";
export const profileSchemas = Object.freeze({
  discovery: "tutti.agent.discovery.v1",
  tools: "tutti.agent.tools.v1",
  capabilities: "tutti.agent.capabilities.v1",
  composer: "tutti.agent.composer.v1"
});

const allowedPackageExtensions = new Set([
  ".json",
  ".md",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp"
]);
const presentationAssetExtensions = new Set([
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp"
]);
const presentationAssetLimit = 256 << 10;
const packageDocumentation = new Set([
  "AGENTS.md",
  "LICENSE",
  "NOTICE.md",
  "README.md"
]);
const allowedPlaceholders = new Set([
  "${projectRoot}",
  "${installRoot}",
  "${platform}"
]);
const capabilityKeys = new Set([
  "imageInput",
  "audioInput",
  "embeddedContext",
  "interrupt",
  "resume",
  "permissionModes",
  "modelSelection",
  "mcpHttp",
  "mcpSse",
  "planMode",
  "skills"
]);

export async function validatePackage(packageDir, expectedAgentKey) {
  const manifestPath = path.join(packageDir, "tutti.agent.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifest(manifest, expectedAgentKey);
  const declaredPaths = await validateReferencedFiles(packageDir, manifest);
  await validatePackageEntries(packageDir, "", declaredPaths);
  return manifest;
}

export function validateManifest(manifest, expectedAgentKey) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("agent manifest must be an object");
  }
  rejectUnknownKeys(
    manifest,
    new Set([
      "schemaVersion",
      "agentKey",
      "version",
      "name",
      "description",
      "icon",
      "heroImage",
      "runtime",
      "profiles",
      "localizationInfo"
    ]),
    "agent manifest"
  );
  if (manifest.schemaVersion !== manifestSchemaVersion) {
    throw new Error(
      `agent manifest schemaVersion must be ${manifestSchemaVersion}`
    );
  }
  manifest.agentKey = requireSafeSegment(
    manifest.agentKey,
    "manifest agentKey"
  );
  if (expectedAgentKey && manifest.agentKey !== expectedAgentKey) {
    throw new Error(
      `manifest agentKey ${manifest.agentKey} does not match ${expectedAgentKey}`
    );
  }
  manifest.version = requireSemver(manifest.version, "manifest version");
  requireString(manifest.name, "manifest name");
  requireString(manifest.description, "manifest description");
  validateIcon(manifest.icon);
  validateHeroImage(manifest.heroImage);
  validateRuntime(manifest.runtime);
  validateProfiles(manifest.profiles);
  validateLocalizationInfo(manifest.localizationInfo);
  return manifest;
}

function validateIcon(icon) {
  if (!icon || typeof icon !== "object" || icon.type !== "asset") {
    throw new Error("manifest icon.type must be asset");
  }
  rejectUnknownKeys(icon, new Set(["type", "src"]), "manifest icon");
  requireRelativePath(icon.src, "manifest icon.src");
}

function validateHeroImage(heroImage) {
  if (
    !heroImage ||
    typeof heroImage !== "object" ||
    heroImage.type !== "asset"
  ) {
    throw new Error("manifest heroImage.type must be asset");
  }
  rejectUnknownKeys(heroImage, new Set(["type", "src"]), "manifest heroImage");
  requireRelativePath(heroImage.src, "manifest heroImage.src");
}

function validateRuntime(runtime) {
  if (!runtime || typeof runtime !== "object") {
    throw new Error("manifest runtime is required");
  }
  rejectUnknownKeys(runtime, new Set(["kind", "install", "launch"]), "runtime");
  if (runtime.kind !== "standard-acp") {
    throw new Error("manifest runtime.kind must be standard-acp");
  }
  validateInstall(runtime.install);
  if (!runtime.launch || typeof runtime.launch !== "object") {
    throw new Error("manifest runtime.launch is required");
  }
  rejectUnknownKeys(runtime.launch, new Set(["executable", "args"]), "runtime launch");
  validateTemplateArgument(
    requireString(runtime.launch.executable, "runtime launch executable"),
    "runtime launch executable"
  );
  if (
    !runtime.launch.executable.startsWith("${installRoot}/") ||
    runtime.launch.executable.split("/").includes("..") ||
    runtime.launch.executable.includes("\\")
  ) {
    throw new Error("runtime launch executable must stay under ${installRoot}");
  }
  validateArgv(runtime.launch.args ?? [], "runtime launch args");
}

function validateInstall(install) {
  if (!install || typeof install !== "object") {
    throw new Error("manifest runtime.install is required");
  }
  rejectUnknownKeys(install, new Set(["runner", "args"]), "runtime install");
  if (!new Set(["npm", "pnpm", "uv"]).has(install.runner)) {
    throw new Error("runtime install runner must be npm, pnpm, or uv");
  }
  validateArgv(install.args, "runtime install args");
  if (!install.args.some((argument) => argument.includes("${installRoot}"))) {
    throw new Error("runtime install args must target ${installRoot}");
  }
  if (install.runner === "npm" || install.runner === "pnpm") {
    const packageArguments = install.args.filter((argument) =>
      /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(
        argument
      )
    );
    if (packageArguments.length !== 1) {
      throw new Error(
        "npm/pnpm install must contain one exact package@version"
      );
    }
    const expected = install.runner === "npm"
      ? ["install", "--prefix", "${installRoot}", packageArguments[0]]
      : ["add", "--dir", "${installRoot}", packageArguments[0]];
    if (JSON.stringify(install.args) !== JSON.stringify(expected)) {
      throw new Error(
        `runtime ${install.runner} install args must be exactly ${expected.join(" ")}`
      );
    }
  } else {
    const packageArguments = install.args.filter((argument) =>
      /^[A-Za-z0-9][A-Za-z0-9._-]*==[0-9]+\.[0-9]+\.[0-9]+(?:[A-Za-z0-9._+-]*)?$/u.test(
        argument
      )
    );
    if (packageArguments.length !== 1) {
      throw new Error("uv install must contain one exact package==version");
    }
    const expected = ["pip", "install", "--target", "${installRoot}", packageArguments[0]];
    if (JSON.stringify(install.args) !== JSON.stringify(expected)) {
      throw new Error(`runtime uv install args must be exactly ${expected.join(" ")}`);
    }
  }
}

function validateArgv(argv, label) {
  if (!Array.isArray(argv)) throw new Error(`${label} must be an array`);
  for (const [index, argument] of argv.entries()) {
    validateTemplateArgument(
      requireString(argument, `${label}[${index}]`),
      `${label}[${index}]`
    );
  }
}

function validateTemplateArgument(argument, label) {
  if (/[|;&`\n\r<>]/u.test(argument) || argument.includes("$(")) {
    throw new Error(`${label} contains forbidden shell syntax`);
  }
  for (const match of argument.matchAll(/\$\{[^}]+\}/gu)) {
    if (!allowedPlaceholders.has(match[0])) {
      throw new Error(`${label} contains unsupported placeholder ${match[0]}`);
    }
  }
}

function validateProfiles(profiles) {
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
    throw new Error("manifest profiles is required");
  }
  rejectUnknownKeys(profiles, new Set(Object.keys(profileSchemas)), "manifest profiles");
  for (const kind of Object.keys(profileSchemas)) {
    const file = profiles[kind];
    requireRelativePath(file, `manifest profiles.${kind}`);
  }
}

function validateLocalizationInfo(localizationInfo) {
  if (!localizationInfo || typeof localizationInfo !== "object") {
    throw new Error("manifest localizationInfo is required");
  }
  rejectUnknownKeys(
    localizationInfo,
    new Set(["defaultLocale", "defaultFile", "additionalLocales"]),
    "manifest localizationInfo"
  );
  requireString(
    localizationInfo.defaultLocale,
    "localizationInfo defaultLocale"
  );
  requireRelativePath(
    localizationInfo.defaultFile,
    "localizationInfo defaultFile"
  );
  const additional = localizationInfo.additionalLocales ?? [];
  if (!Array.isArray(additional)) {
    throw new Error("localizationInfo additionalLocales must be an array");
  }
  for (const [index, locale] of additional.entries()) {
    if (!locale || typeof locale !== "object" || Array.isArray(locale)) {
      throw new Error(`additionalLocales[${index}] must be an object`);
    }
    rejectUnknownKeys(locale, new Set(["locale", "file"]), `additionalLocales[${index}]`);
    requireString(locale?.locale, `additionalLocales[${index}].locale`);
    requireRelativePath(locale?.file, `additionalLocales[${index}].file`);
  }
}

async function validateReferencedFiles(packageDir, manifest) {
  const references = [
    [manifest.icon.src, null, "manifest icon"],
    ...(manifest.heroImage ? [[manifest.heroImage.src, null, "manifest heroImage"]] : []),
    [manifest.localizationInfo.defaultFile, null, null],
    ...(manifest.localizationInfo.additionalLocales ?? []).map((entry) => [
      entry.file,
      null,
      null
    ]),
    ...Object.entries(manifest.profiles).map(([kind, file]) => [
      file,
      profileSchemas[kind],
      null
    ])
  ];
  const declaredPaths = new Set(["tutti.agent.json"]);
  const profiles = new Map();
  for (const [relativePath, expectedSchema, assetLabel] of references) {
    declaredPaths.add(relativePath);
    const filePath = resolvePackagePath(packageDir, relativePath);
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile() || info.size === 0) {
      throw new Error(
        `referenced package file is missing or empty: ${relativePath}`
      );
    }
    if (expectedSchema) {
      const profile = JSON.parse(await readFile(filePath, "utf8"));
      if (profile.schemaVersion !== expectedSchema) {
        throw new Error(
          `${relativePath} schemaVersion must be ${expectedSchema}`
        );
      }
      validateProfile(relativePath, expectedSchema, profile);
      profiles.set(expectedSchema, profile);
    }
    if (assetLabel) await validatePresentationAsset(filePath, assetLabel, info);
    if (!expectedSchema && !assetLabel) {
      const locale = JSON.parse(await readFile(filePath, "utf8"));
      if (!locale || typeof locale !== "object" || Array.isArray(locale)) {
        throw new Error(`${relativePath} must contain a JSON object`);
      }
      requireString(locale["agent.name"], `${relativePath} agent.name`);
      requireString(locale["agent.description"], `${relativePath} agent.description`);
    }
  }
  const capabilities = profiles.get(profileSchemas.capabilities);
  const composer = profiles.get(profileSchemas.composer);
  const hasSkills = composer?.skills !== undefined;
  if (Boolean(capabilities?.declared?.skills) !== hasSkills) {
    throw new Error("capabilities declared skills must match composer skills");
  }
  const hasPermissionModes = (composer?.permissionModes?.length ?? 0) > 0;
  if (Boolean(capabilities?.declared?.permissionModes) !== hasPermissionModes) {
    throw new Error("capabilities declared permissionModes must match composer permissionModes");
  }
  return declaredPaths;
}

async function validatePackageEntries(root, relativeDir = "", declaredPaths) {
  const entries = await readdir(path.join(root, relativeDir), {
    withFileTypes: true
  });
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    const absolutePath = path.join(root, relativePath);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `agent package must not contain symlinks: ${relativePath}`
      );
    }
    if (entry.isDirectory()) {
      const packagePath = relativePath.split(path.sep).join("/");
      const declaredPrefix = `${packagePath}/`;
      if (![...declaredPaths, ...packageDocumentation].some(
        (declaredPath) => declaredPath.startsWith(declaredPrefix)
      )) {
        throw new Error(`agent package contains undeclared directory: ${relativePath}`);
      }
      await validatePackageEntries(root, relativePath, declaredPaths);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `agent package contains unsupported entry: ${relativePath}`
      );
    }
    if (!allowedPackageExtensions.has(path.extname(entry.name).toLowerCase())) {
      throw new Error(
        `agent package contains forbidden file type: ${relativePath}`
      );
    }
    const info = await stat(absolutePath);
    if ((info.mode & 0o111) !== 0) {
      throw new Error(
        `agent package contains executable file: ${relativePath}`
      );
    }
    const packagePath = relativePath.split(path.sep).join("/");
    if (!declaredPaths.has(packagePath) && !packageDocumentation.has(packagePath)) {
      throw new Error(`agent package contains undeclared file: ${relativePath}`);
    }
  }
}

async function validatePresentationAsset(filePath, label, info) {
  const extension = path.extname(filePath).toLowerCase();
  if (!presentationAssetExtensions.has(extension)) {
    throw new Error(`${label} must be JPEG, PNG, SVG, or WebP`);
  }
  if (info.size > presentationAssetLimit) {
    throw new Error(`${label} exceeds the 256 KiB presentation asset limit`);
  }
  if (extension !== ".svg") {
    validateRasterAsset(await readFile(filePath), extension, label);
    return;
  }
  const content = await readFile(filePath, "utf8");
  if (
    /<\?(?!xml\s)|<!DOCTYPE|<!ENTITY/iu.test(content) ||
    /<(?:[A-Za-z_][\w.-]*:)?(?:script|style|foreignObject|iframe|object|embed)(?:\s|\/?>)/iu.test(content) ||
    /\son[a-z]+\s*=/iu.test(content) ||
    /javascript:|url\s*\(\s*["']?\s*(?:https?:|\/\/|data:image\/svg)|(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/|data:image\/svg)/iu.test(content)
  ) {
    throw new Error(`${label} SVG contains active or remote content`);
  }
  validateSvgStructure(content, label);
}

function validateSvgStructure(content, label) {
  const stripped = content.replace(/^\s*<\?xml\s[^?]*\?>/iu, "").trim();
  const tagPattern = /<\/?([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)(?:\s[^<>]*?)?\s*\/?>/gu;
  const stack = [];
  let cursor = 0;
  let rootName;
  let rootComplete = false;
  for (const match of stripped.matchAll(tagPattern)) {
    const gap = stripped.slice(cursor, match.index);
    if (gap.includes("<") || gap.includes(">") || (stack.length === 0 && gap.trim())) {
      throw new Error(`${label} SVG must be well-formed XML`);
    }
    validateXmlEntities(gap, label);
    const token = match[0];
    const qualifiedName = match[1];
    const localName = qualifiedName.split(":").at(-1).toLowerCase();
    if (new Set(["script", "style", "foreignobject", "iframe", "object", "embed"]).has(localName)) {
      throw new Error(`${label} SVG contains active or remote content`);
    }
    const closing = token.startsWith("</");
    const selfClosing = /\/\s*>$/u.test(token);
    if (closing) {
      if (selfClosing || !/^<\/[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?\s*>$/u.test(token) ||
          stack.pop() !== qualifiedName) {
        throw new Error(`${label} SVG must be well-formed XML`);
      }
      rootComplete = stack.length === 0;
    } else {
      if (rootComplete) {
        throw new Error(`${label} SVG must contain exactly one root element`);
      }
      rootName ??= localName;
      const attributes = token
        .replace(/^<[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?/u, "")
        .replace(/\/?>$/u, "");
      validateSvgAttributes(attributes, label);
      if (selfClosing) {
        rootComplete = stack.length === 0;
      } else {
        stack.push(qualifiedName);
      }
    }
    cursor = match.index + token.length;
  }
  const tail = stripped.slice(cursor);
  if (tail.includes("<") || tail.includes(">") || tail.trim() || stack.length > 0 ||
      !rootComplete || rootName !== "svg") {
    throw new Error(`${label} SVG must be well-formed XML with an svg root`);
  }
}

function validateSvgAttributes(source, label) {
  let remaining = source;
  const names = new Set();
  while (remaining.trim()) {
    const match = remaining.match(
      /^\s+([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)\s*=\s*(?:"([^"]*)"|'([^']*)')/u
    );
    if (!match) {
      throw new Error(`${label} SVG must be well-formed XML`);
    }
    if (names.has(match[1])) {
      throw new Error(`${label} SVG contains a duplicate attribute`);
    }
    names.add(match[1]);
    const value = match[2] ?? match[3];
    validateXmlEntities(value, label);
    const decodedValue = decodeXmlEntities(value).trim().toLowerCase();
    const localName = match[1].split(":").at(-1).toLowerCase();
    if (localName.startsWith("on") || decodedValue.includes("javascript:") ||
        /url\s*\(\s*["']?\s*(?:https?:|\/\/|data:image\/svg)/iu.test(decodedValue)) {
      throw new Error(`${label} SVG contains active or remote content`);
    }
    if (new Set(["href", "src"]).has(localName) && !(
      decodedValue.startsWith("#") ||
      (decodedValue.startsWith("data:image/") && !decodedValue.startsWith("data:image/svg"))
    )) {
      throw new Error(`${label} SVG contains active or remote content`);
    }
    remaining = remaining.slice(match[0].length);
  }
}

function validateXmlEntities(value, label) {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);)/u.test(value)) {
    throw new Error(`${label} SVG must be well-formed XML`);
  }
  for (const match of value.matchAll(/&#(x[0-9A-Fa-f]+|\d+);/gu)) {
    const codePoint = match[1].startsWith("x")
      ? Number.parseInt(match[1].slice(1), 16)
      : Number.parseInt(match[1], 10);
    const validXmlCharacter = codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (!validXmlCharacter) {
      throw new Error(`${label} SVG must be well-formed XML`);
    }
  }
}

function decodeXmlEntities(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return value.replace(
    /&(amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);/gu,
    (_match, entity) => {
      if (Object.hasOwn(named, entity)) return named[entity];
      const codePoint = entity.startsWith("#x")
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : "";
    }
  );
}

function validateRasterAsset(data, extension, label) {
  if (extension === ".png") {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (data.length < 20 || !data.subarray(0, 8).equals(signature)) {
      throw new Error(`${label} must be a valid PNG container`);
    }
    let offset = 8;
    const chunks = [];
    while (offset < data.length) {
      if (data.length - offset < 12) throw new Error(`${label} must be a valid PNG container`);
      const length = data.readUInt32BE(offset);
      const type = data.subarray(offset + 4, offset + 8).toString("ascii");
      offset += 12 + length;
      if (offset > data.length) throw new Error(`${label} must be a valid PNG container`);
      chunks.push(type);
      if (type === "IEND") {
        if (length !== 0 || offset !== data.length) throw new Error(`${label} must be a valid PNG container`);
        break;
      }
    }
    if (chunks[0] !== "IHDR" || !chunks.includes("IDAT") || chunks.at(-1) !== "IEND") {
      throw new Error(`${label} must be a valid PNG container`);
    }
    return;
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    if (data.length < 8 || data[0] !== 0xff || data[1] !== 0xd8 ||
        data.at(-2) !== 0xff || data.at(-1) !== 0xd9) {
      throw new Error(`${label} must be a valid JPEG container`);
    }
    let offset = 2;
    let sawFrame = false;
    let sawScan = false;
    const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset < data.length - 2 && !sawScan) {
      if (data[offset] !== 0xff) throw new Error(`${label} must be a valid JPEG container`);
      while (offset < data.length && data[offset] === 0xff) offset += 1;
      if (offset >= data.length) throw new Error(`${label} must be a valid JPEG container`);
      const marker = data[offset];
      offset += 1;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (marker === 0xd9 || offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) throw new Error(`${label} must be a valid JPEG container`);
      sawFrame ||= frameMarkers.has(marker);
      sawScan ||= marker === 0xda;
      offset += length;
    }
    if (!sawFrame || !sawScan) throw new Error(`${label} must be a valid JPEG container`);
    return;
  }
  if (extension === ".webp") {
    if (data.length < 20 || data.subarray(0, 4).toString("ascii") !== "RIFF" ||
        data.subarray(8, 12).toString("ascii") !== "WEBP" || data.readUInt32LE(4) + 8 !== data.length) {
      throw new Error(`${label} must be a valid WebP container`);
    }
    let offset = 12;
    let hasImageChunk = false;
    while (offset < data.length) {
      if (data.length - offset < 8) throw new Error(`${label} must be a valid WebP container`);
      const type = data.subarray(offset, offset + 4).toString("ascii");
      const length = data.readUInt32LE(offset + 4);
      offset += 8 + length + (length % 2);
      if (offset > data.length) throw new Error(`${label} must be a valid WebP container`);
      hasImageChunk ||= new Set(["VP8 ", "VP8L", "ANMF"]).has(type);
    }
    if (offset !== data.length || !hasImageChunk) throw new Error(`${label} must be a valid WebP container`);
  }
}

function validateProfile(relativePath, schema, profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error(`${relativePath} must contain a JSON object`);
  }
  if (schema === profileSchemas.discovery) return validateDiscovery(profile);
  if (schema === profileSchemas.tools) return validateTools(profile);
  if (schema === profileSchemas.capabilities) return validateCapabilities(profile);
  if (schema === profileSchemas.composer) return validateComposer(profile);
}

function validateDiscovery(profile) {
  rejectUnknownKeys(profile, new Set(["schemaVersion", "candidates"]), "discovery profile");
  if (!Array.isArray(profile.candidates) || profile.candidates.length === 0) {
    throw new Error("discovery candidates must be a non-empty array");
  }
  for (const [index, candidate] of profile.candidates.entries()) {
    const label = `discovery candidate ${index}`;
    rejectUnknownKeys(candidate, new Set(["binaryNames", "version", "launchArgs", "probe"]), label);
    if (!Array.isArray(candidate.binaryNames) || candidate.binaryNames.length === 0 ||
        candidate.binaryNames.some((name) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name))) {
      throw new Error(`${label} binaryNames are invalid`);
    }
    rejectUnknownKeys(candidate.version, new Set(["args", "constraint"]), `${label} version`);
    validateArgv(candidate.version?.args, `${label} version args`);
    requireString(candidate.version?.constraint, `${label} version constraint`);
    validateArgv(candidate.launchArgs, `${label} launch args`);
    rejectUnknownKeys(candidate.probe, new Set(["kind", "timeoutMs"]), `${label} probe`);
    if (candidate.probe?.kind !== "acp-initialize" || !Number.isInteger(candidate.probe.timeoutMs) ||
        candidate.probe.timeoutMs < 100 || candidate.probe.timeoutMs > 60_000) {
      throw new Error(`${label} must declare a bounded acp-initialize probe`);
    }
  }
}

function validateTools(profile) {
  rejectUnknownKeys(profile, new Set(["schemaVersion", "tools"]), "tools profile");
  if (!Array.isArray(profile.tools)) throw new Error("tools profile tools must be an array");
  for (const [index, tool] of profile.tools.entries()) {
    rejectUnknownKeys(tool, new Set(["name", "aliases"]), `tools profile entry ${index}`);
    requireString(tool?.name, `tools profile entry ${index} name`);
    if (tool.aliases !== undefined && (!Array.isArray(tool.aliases) || tool.aliases.some((item) => typeof item !== "string"))) {
      throw new Error(`tools profile entry ${index} aliases must be strings`);
    }
  }
}

function validateCapabilities(profile) {
  rejectUnknownKeys(profile, new Set(["schemaVersion", "declared"]), "capabilities profile");
  if (!profile.declared || typeof profile.declared !== "object" || Array.isArray(profile.declared)) {
    throw new Error("capabilities profile declared must be an object");
  }
  rejectUnknownKeys(profile.declared, capabilityKeys, "capabilities profile declared");
  if (Object.values(profile.declared).some((value) => typeof value !== "boolean")) {
    throw new Error("capabilities profile values must be booleans");
  }
}

function validateComposer(profile) {
  rejectUnknownKeys(profile, new Set(["schemaVersion", "model", "permission", "permissionModes", "skills"]), "composer profile");
  rejectUnknownKeys(profile.model, new Set(["source"]), "composer model");
  rejectUnknownKeys(profile.permission, new Set(["source"]), "composer permission");
  if (profile.model?.source !== "acp-session-models" || profile.permission?.source !== "acp-session-modes") {
    throw new Error("composer catalogs must come from ACP session state");
  }
  if (!Array.isArray(profile.permissionModes)) throw new Error("composer permissionModes must be an array");
  const runtimeIds = new Set();
  for (const [index, mode] of profile.permissionModes.entries()) {
    rejectUnknownKeys(mode, new Set(["runtimeId", "semantic"]), `composer permission mode ${index}`);
    const runtimeId = requireString(mode?.runtimeId, `composer permission mode ${index} runtimeId`);
    if (runtimeIds.has(runtimeId)) {
      throw new Error(`composer permission mode ${index} runtimeId must be unique`);
    }
    runtimeIds.add(runtimeId);
    if (!new Set(["read-only", "ask-before-write", "accept-edits", "full-access"]).has(mode?.semantic)) {
      throw new Error(`composer permission mode ${index} semantic is invalid`);
    }
  }
  if (profile.skills === undefined) return;
  rejectUnknownKeys(profile.skills, new Set(["invocation", "triggerPrefix", "roots"]), "composer skills");
  if (profile.skills?.invocation !== "textTrigger" || typeof profile.skills.triggerPrefix !== "string" ||
      !profile.skills.triggerPrefix || /\s/u.test(profile.skills.triggerPrefix) || profile.skills.triggerPrefix.length > 8) {
    throw new Error("composer skills invocation is invalid");
  }
  if (!Array.isArray(profile.skills.roots) || profile.skills.roots.length === 0) {
    throw new Error("composer skills roots must be a non-empty array");
  }
  for (const [index, root] of profile.skills.roots.entries()) {
    rejectUnknownKeys(root, new Set(["scope", "path"]), `composer skill root ${index}`);
    if (!new Set(["workspace", "user"]).has(root?.scope) || !isRelativePackagePath(root?.path)) {
      throw new Error(`composer skill root ${index} is invalid`);
    }
  }
}

function rejectUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}`);
  }
}

function requireRelativePath(value, label) {
  const normalized = requireString(value, label);
  if (!isRelativePackagePath(normalized)) {
    throw new Error(`${label} must be a relative package path`);
  }
  return normalized;
}

function resolvePackagePath(packageDir, relativePath) {
  const resolved = path.resolve(packageDir, relativePath);
  if (!resolved.startsWith(`${path.resolve(packageDir)}${path.sep}`)) {
    throw new Error(`package reference escapes package root: ${relativePath}`);
  }
  return resolved;
}
