import { readFile, writeFile } from "node:fs/promises";
import { SEMVER } from "./release-metadata.mjs";
const version = process.argv[2];

if (typeof version !== "string" || !SEMVER.test(version)) {
	console.error("usage: npm run release:sync -- <semver>");
	process.exitCode = 1;
} else {
	const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
	const [pkg, lock, catalog, readme] = await Promise.all([
		readJson("package.json"),
		readJson("package-lock.json"),
		readJson("catalog/v1/plugins.json"),
		readFile("README.md", "utf8")
	]);
	const previousVersion = pkg.version;
	const marker = `<!-- stable-version: ${previousVersion} -->`;
	if (!readme.includes(marker)) throw new Error(`README stable-version marker does not match package ${previousVersion}`);
	const timestamp = new Date().toISOString();
	pkg.version = version;
	lock.version = version;
	lock.packages[""].version = version;
	catalog.revision = version;
	catalog.generatedAt = timestamp;
	catalog.items[0].latestVersion = version;
	catalog.items[0].updatedAt = timestamp;
	const nextReadme = readme
		.replace(marker, `<!-- stable-version: ${version} -->`)
		.replaceAll(`${pkg.name}@${previousVersion}`, `${pkg.name}@${version}`)
		.replaceAll(`stable/catalog 版本是 \`${previousVersion}\``, `stable/catalog 版本是 \`${version}\``)
		.replaceAll(`当前 npm stable 为 \`${previousVersion}\``, `当前 npm stable 为 \`${version}\``);
	await Promise.all([
		writeFile("package.json", `${JSON.stringify(pkg, null, 2)}\n`, "utf8"),
		writeFile("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`, "utf8"),
		writeFile("catalog/v1/plugins.json", `${JSON.stringify(catalog, null, 2)}\n`, "utf8"),
		writeFile("README.md", nextReadme, "utf8")
	]);
	console.log(`synchronized package, lockfile, catalog, and README install references to ${version}`);
}
