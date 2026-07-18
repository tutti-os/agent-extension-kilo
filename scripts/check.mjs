import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, [path.join(root, 'scripts', 'package.mjs')], { stdio: 'inherit' });
const packageDir = path.join(root, 'build', 'tutti-agent', 'package');
const manifest = JSON.parse(await readFile(path.join(packageDir, 'tutti.agent.json'), 'utf8'));
if (manifest.schemaVersion !== 'tutti.agent.manifest.v1' || manifest.agentKey !== 'kilo') throw new Error('invalid manifest identity');
if (Object.hasOwn(manifest, 'provider') || Object.hasOwn(manifest, 'agentTargetId')) throw new Error('host identity must not be added outside the v1 manifest contract');
if (manifest.runtime.install.runner !== 'npm' || manifest.runtime.install.args.at(-1) !== '@kilocode/cli@7.4.11') throw new Error('runtime package must be exactly pinned');
if (manifest.runtime.launch.executable !== '${installRoot}/node_modules/.bin/kilo' || JSON.stringify(manifest.runtime.launch.args) !== '["acp"]') throw new Error('invalid managed launch contract');
const discovery = JSON.parse(await readFile(path.join(packageDir, manifest.profiles.discovery), 'utf8'));
const candidate = discovery.candidates?.[0];
if (JSON.stringify(candidate?.binaryNames) !== '["kilo","kilocode"]' || candidate?.version?.constraint !== '>=7.4.11 <8.0.0' || JSON.stringify(candidate?.launchArgs) !== '["acp"]') throw new Error('invalid local discovery contract');
const composer = JSON.parse(await readFile(path.join(packageDir, manifest.profiles.composer), 'utf8'));
if (composer.model?.source !== 'acp-session-models' || composer.permission?.source !== 'acp-session-modes' || composer.permissionModes?.length !== 0) throw new Error('composer catalogs must remain runtime-owned');
const tools = JSON.parse(await readFile(path.join(packageDir, manifest.profiles.tools), 'utf8'));
if (!Array.isArray(tools.tools) || tools.tools.length !== 0) throw new Error('tool mappings require source or probe evidence');
const capabilities = JSON.parse(await readFile(path.join(packageDir, manifest.profiles.capabilities), 'utf8'));
const expectedCapabilities = { imageInput: true, audioInput: false, embeddedContext: true, interrupt: false, resume: true, permissionModes: false, modelSelection: true, mcpHttp: true, mcpSse: true, planMode: true, skills: true };
if (JSON.stringify(capabilities.declared) !== JSON.stringify(expectedCapabilities)) throw new Error('capabilities must match reviewed ACP and source evidence');
const expectedSkillRoots = ['workspace:.kilo/skills', 'workspace:.kilocode/skills', 'workspace:.agents/skills', 'workspace:.claude/skills', 'user:.agents/skills', 'user:.claude/skills'];
const actualSkillRoots = composer.skills?.roots?.map((entry) => `${entry.scope}:${entry.path}`);
if (composer.skills?.invocation !== 'textTrigger' || composer.skills?.triggerPrefix !== '/' || JSON.stringify(actualSkillRoots) !== JSON.stringify(expectedSkillRoots)) throw new Error('invalid source-backed Skills contract');
await rejectExecutables(packageDir);
async function rejectExecutables(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlink is forbidden: ${item}`);
    if (entry.isDirectory()) { await rejectExecutables(item); continue; }
    if ((await stat(item)).mode & 0o111) throw new Error(`executable is forbidden: ${item}`);
  }
}
