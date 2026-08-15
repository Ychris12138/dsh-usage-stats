#!/usr/bin/env node

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const knownFlags = new Set(["--check", "--dry-run", "--no-enable", "--help"]);
const args = new Set(process.argv.slice(2));
for (const arg of args) {
	if (!knownFlags.has(arg)) {
		console.error(`Unknown option: ${arg}`);
		process.exit(2);
	}
}

if (args.has("--help")) {
	console.log(`dsh-usage-stats installer

Usage:
  npx --yes github:Ychris12138/dsh-usage-stats [options]

Options:
  --check      Verify the installed package and Cordis patch without changing them
  --dry-run    Print the resolved paths and planned changes
  --no-enable  Install files without editing cordis.patch.yml
  --help       Show this help

Set DSH_HOME to override the default ~/.dsh location.`);
	process.exit(0);
}

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePackage = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const target = join(dshHome, "profiles", "node_modules", "dsh-usage-stats");
const patchPath = join(dshHome, "profiles", "web", "cordis.patch.yml");
const pluginLine = /^\s+name:\s*dsh-usage-stats\s*$/gm;
const patchBlock = `# dsh-usage-stats: token usage heatmap + DeepSeek balance
- insert:
    - id: usage-stats
      name: dsh-usage-stats
`;
const emptySequenceRoot = /^\[\](?:[ \t]+#.*)?$/;

function meaningfulPatchLines(text) {
	return String(text).split(/\r?\n/).map((line, index) => ({
		index,
		indent: line.match(/^[ \t]*/)?.[0].length ?? 0,
		content: line.trim()
	})).filter(({ content }) => content !== "" && !content.startsWith("#") && content !== "---" && content !== "...");
}

/** Remove a YAML document whose only value is the empty root sequence `[]`. */
function withoutEmptySequenceRoot(text) {
	const meaningful = meaningfulPatchLines(text);
	if (meaningful.length === 0) return text;
	const rootIndent = Math.min(...meaningful.map(({ indent }) => indent));
	const emptyRoot = meaningful.find(({ indent, content }) => indent === rootIndent && emptySequenceRoot.test(content));
	if (emptyRoot === void 0) return text;
	const lines = String(text).split(/\r?\n/);
	const inlineComment = lines[emptyRoot.index].match(/^([ \t]*)\[\][ \t]+(#.*)$/);
	if (inlineComment === null) lines.splice(emptyRoot.index, 1);
	else lines[emptyRoot.index] = `${inlineComment[1]}${inlineComment[2]}`;
	return lines.filter((line) => line.trim() !== "...").join("\n").trimEnd();
}

/** Detect the exact invalid shape produced by older installers: `[]` plus list entries. */
function assertNoEmptyRootConflict(text) {
	const meaningful = meaningfulPatchLines(text);
	if (meaningful.length < 2) return;
	const rootIndent = Math.min(...meaningful.map(({ indent }) => indent));
	const roots = meaningful.filter(({ indent }) => indent === rootIndent);
	if (roots.some(({ content }) => emptySequenceRoot.test(content)) && roots.length > 1) {
		throw new Error(`invalid YAML in ${patchPath}: empty root sequence [] cannot be combined with patch entries; rerun the installer to repair it`);
	}
}

/** Preserve existing YAML/comments while adding exactly one plugin patch entry. */
function enablePluginInPatch(text) {
	const base = withoutEmptySequenceRoot(text);
	if ([...base.matchAll(pluginLine)].length > 0) return base;
	return base.trim() === "" ? patchBlock : `${base.trimEnd()}\n\n${patchBlock}`;
}

async function readOptional(path) {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

async function verify(expectEnabled) {
	const installedRaw = await readOptional(join(target, "package.json"));
	if (installedRaw === null) throw new Error(`package is not installed at ${target}`);
	const installed = JSON.parse(installedRaw);
	if (installed.name !== sourcePackage.name || installed.version !== sourcePackage.version) {
		throw new Error(`installed package is ${installed.name ?? "unknown"}@${installed.version ?? "unknown"}; expected ${sourcePackage.name}@${sourcePackage.version}`);
	}
	if (expectEnabled) {
		const patch = await readOptional(patchPath);
		const count = patch === null ? 0 : [...patch.matchAll(pluginLine)].length;
		if (count !== 1) throw new Error(`expected exactly one dsh-usage-stats entry in ${patchPath}; found ${count}`);
		assertNoEmptyRootConflict(patch);
	}
	console.log(`Verified ${sourcePackage.name}@${sourcePackage.version}`);
	console.log(`  package: ${target}`);
	if (expectEnabled) console.log(`  patch:   ${patchPath}`);
}

const enable = !args.has("--no-enable");
if (args.has("--dry-run")) {
	console.log(`Would install ${sourcePackage.name}@${sourcePackage.version}`);
	console.log(`  package: ${target}`);
	console.log(`  patch:   ${enable ? patchPath : "unchanged (--no-enable)"}`);
	process.exit(0);
}

if (args.has("--check")) {
	await verify(enable);
	process.exit(0);
}

await mkdir(target, { recursive: true });
for (const entry of ["lib", "cordis.patch.yml", "package.json", "README.md", "LICENSE", "SECURITY.md"]) {
	await cp(join(sourceRoot, entry), join(target, entry), { recursive: true, force: true });
}
await mkdir(join(target, "scripts"), { recursive: true });
await cp(fileURLToPath(import.meta.url), join(target, "scripts", "install.mjs"), { force: true });

if (enable) {
	await mkdir(dirname(patchPath), { recursive: true });
	const current = await readOptional(patchPath) ?? "";
	const enabledPatch = enablePluginInPatch(current);
	if (enabledPatch !== current) await writeFile(patchPath, enabledPatch, "utf8");
}

await verify(enable);
console.log("Installation complete. Restart dsh web, then hard-refresh the browser.");
console.log("Balance is optional: configure DEEPSEEK_API_KEY in <DSH_HOME>/.credentials.yaml.");