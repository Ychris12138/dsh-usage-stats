import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const home = await mkdtemp(join(tmpdir(), "dsh-usage-stats-install-"));
const installer = fileURLToPath(new URL("./install.mjs", import.meta.url));

function run(...args) {
	const result = spawnSync(process.execPath, [installer, ...args], {
		env: { ...process.env, DSH_HOME: home },
		encoding: "utf8"
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result.stdout;
}

try {
	run();
	run();
	assert.match(run("--check"), /Verified dsh-usage-stats@/);
	const patch = await readFile(join(home, "profiles", "web", "cordis.patch.yml"), "utf8");
	assert.equal([...patch.matchAll(/^\s+name:\s*dsh-usage-stats\s*$/gm)].length, 1, "installer must be idempotent");
	const installed = JSON.parse(await readFile(join(home, "profiles", "node_modules", "dsh-usage-stats", "package.json"), "utf8"));
	assert.equal(installed.name, "dsh-usage-stats");
	assert.equal(installed.dsh?.bundle?.patch, "./cordis.patch.yml");
	assert.match(
		await readFile(join(home, "profiles", "node_modules", "dsh-usage-stats", "cordis.patch.yml"), "utf8"),
		/^\s+name:\s*dsh-usage-stats\s*$/m
	);
	assert.equal(await readFile(join(home, "profiles", "node_modules", "dsh-usage-stats", "lib", "index.js"), "utf8").then((text) => text.length > 1000), true);
	console.log("INSTALLER REGRESSION TESTS PASSED");
} finally {
	await rm(home, { recursive: true, force: true });
}
