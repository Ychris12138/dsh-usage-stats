import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const patchDeclaration = manifest.dsh?.bundle?.patch;

assert.equal(patchDeclaration, "./cordis.patch.yml", "package must declare its DSH bundle patch");
assert.ok(manifest.files?.includes("cordis.patch.yml"), "npm package must include the declared bundle patch");

const patchPath = join(root, normalize(patchDeclaration));
await access(patchPath);
const patch = await readFile(patchPath, "utf8");
assert.equal(
	[...patch.matchAll(/^\s+name:\s*dsh-usage-stats\s*$/gm)].length,
	1,
	"bundle patch must mount dsh-usage-stats exactly once"
);

console.log("DSH BUNDLE MANIFEST TESTS PASSED");
