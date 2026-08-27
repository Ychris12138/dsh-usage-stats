import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EXPECTED_CATALOG_ENDPOINT, EXPECTED_PACKAGE_NAME, EXPECTED_REPOSITORY, SEMVER } from "./release-metadata.mjs";

async function json(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

const [pkg, lock, catalog, source, patch, client, readme] = await Promise.all([
	json("package.json"),
	json("package-lock.json"),
	json("catalog/v1/plugins.json"),
	json("catalog/catalog-source.json"),
	readFile("cordis.patch.yml", "utf8"),
	readFile("lib/client.js", "utf8"),
	readFile("README.md", "utf8")
]);

assert.equal(pkg.name, EXPECTED_PACKAGE_NAME, "unexpected scoped npm package identity");
assert.match(pkg.version, SEMVER, "package version must be valid SemVer");
assert.equal(pkg.repository?.url, EXPECTED_REPOSITORY, "repository metadata drifted");
assert.equal(pkg.homepage, "https://github.com/Ychris12138/dsh-usage-stats#readme", "homepage metadata drifted");
assert.equal(pkg.bugs, "https://github.com/Ychris12138/dsh-usage-stats/issues", "bugs metadata drifted");
assert.equal(pkg.publishConfig?.access, "public", "scoped package must publish with public access");
assert.equal(pkg.main, "lib/index.js");
assert.equal(pkg.exports?.["."], "./lib/index.js");
assert.equal(pkg.exports?.["./client"], "./lib/client.js");
assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
assert.equal(pkg.dsh?.client?.platform, "web");
for (const required of ["lib/", "cordis.patch.yml", "README.md", "LICENSE", "SECURITY.md", "docs/release-checklist.md", "docs/release-notes-v0.3.0.md"]) {
	assert.ok(pkg.files?.includes(required), `npm files is missing ${required}`);
}

assert.equal(lock.name, pkg.name, "package-lock root name drifted");
assert.equal(lock.version, pkg.version, "package-lock root version drifted");
assert.equal(lock.packages?.[""]?.name, pkg.name, "package-lock package name drifted");
assert.equal(lock.packages?.[""]?.version, pkg.version, "package-lock package version drifted");

assert.equal(catalog.revision, pkg.version, "catalog revision does not match package version");
assert.equal(catalog.items?.length, 1, "catalog must publish exactly one plugin entry");
assert.equal(catalog.items[0].latestVersion, pkg.version, "catalog latestVersion does not match package version");
assert.equal(catalog.items[0].package?.name, pkg.name, "catalog package name does not match package name");
assert.equal(catalog.items[0].name, pkg.name, "catalog item name does not match package name");
assert.equal(source.transport?.endpoint, EXPECTED_CATALOG_ENDPOINT, "unexpected catalog endpoint");

const escapedName = pkg.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
assert.match(patch, new RegExp(`^\\s*name:\\s*"${escapedName}"\\s*$`, "m"), "Cordis YAML must quote the scoped package identity");
assert.doesNotMatch(patch, new RegExp(`^\\s*name:\\s*${escapedName}\\s*$`, "m"), "Cordis YAML contains an unsafe unquoted scoped identity");
assert.match(client, new RegExp(`__ModuleLoader__\\.load\\(\\{\\s*id:\\s*"${escapedName}"`, "s"), "browser loader identity must match package name");
assert.match(client, new RegExp(`tag\\.dataset\\.plugin\\s*=\\s*"${escapedName}"`), "client style ownership identity must match package name");
assert.match(readme, new RegExp(`<!--\\s*stable-version:\\s*${pkg.version.replaceAll(".", "\\.")}\\s*-->`), "README stable-version marker must match package version");
assert.match(readme, new RegExp(`${escapedName}@${pkg.version.replaceAll(".", "\\.")}`), "README must include an exact npm install for the package version");

console.log(`release metadata ok: ${pkg.name}@${pkg.version}`);
