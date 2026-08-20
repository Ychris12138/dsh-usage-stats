import { readFile, writeFile, rm } from "node:fs/promises";

const version = "0.2.6";
const packageName = "@ychris12138/dsh-usage-stats";
const generatedAt = "2026-08-20T02:30:00.000Z";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const writeJson = async (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

const pkg = await readJson("package.json");
pkg.name = packageName;
pkg.version = version;
delete pkg.private;
pkg.publishConfig = { access: "public" };
pkg.scripts.prepublishOnly = "npm run check && npm test";
await writeJson("package.json", pkg);

const lock = await readJson("package-lock.json");
lock.name = packageName;
lock.version = version;
lock.packages[""].name = packageName;
lock.packages[""].version = version;
await writeJson("package-lock.json", lock);

let patch = await readFile("cordis.patch.yml", "utf8");
patch = patch.replace("name: dsh-usage-stats", `name: ${packageName}`);
await writeFile("cordis.patch.yml", patch);

const catalog = await readJson("catalog/v1/plugins.json");
catalog.generatedAt = generatedAt;
catalog.revision = version;
for (const item of catalog.items ?? []) {
  if (item.id !== "dsh-usage-stats") continue;
  item.name = packageName;
  item.latestVersion = version;
  item.package = { registry: "npm", name: packageName };
  item.updatedAt = generatedAt;
}
await writeJson("catalog/v1/plugins.json", catalog);

let bundleTest = await readFile("scripts/test-bundle.mjs", "utf8");
bundleTest = bundleTest
  .replace('/^\\s+name:\\s*dsh-usage-stats\\s*$/gm', '/^\\s+name:\\s*@ychris12138\\/dsh-usage-stats\\s*$/gm')
  .replace('"bundle patch must mount dsh-usage-stats exactly once"', '"bundle patch must mount @ychris12138/dsh-usage-stats exactly once"');
await writeFile("scripts/test-bundle.mjs", bundleTest);

let installTest = await readFile("scripts/test-install.mjs", "utf8");
installTest = installTest
  .replace('assert.match(run("--check"), /Verified dsh-usage-stats@/);', 'assert.match(run("--check"), /Verified @ychris12138\\/dsh-usage-stats@/);')
  .replace('assert.equal(installed.name, "dsh-usage-stats");', `assert.equal(installed.name, "${packageName}");`)
  .replace('/^\\s+name:\\s*dsh-usage-stats\\s*$/m\n\t);\n\tassert.equal(await readFile(join(home, "profiles", "node_modules", "dsh-usage-stats", "lib", "index.js")', '/^\\s+name:\\s*@ychris12138\\/dsh-usage-stats\\s*$/m\n\t);\n\tassert.equal(await readFile(join(home, "profiles", "node_modules", "dsh-usage-stats", "lib", "index.js")');
await writeFile("scripts/test-install.mjs", installTest);

let readme = await readFile("README.md", "utf8");
readme = readme.replace(
  '1. 把 `package.json` 的 `name` 改为 `@ychris12138/dsh-usage-stats`（或你选定的可用名），去掉 `private: true`，并同步 `cordis.patch.yml` 的 `name` 与 `catalog/v1/plugins.json` 的 `package.name` / `latestVersion`；**每次发版都要同步 bump `catalog/v1/plugins.json` 的 `latestVersion`**。\n2. `npm publish`（scoped 公开包）。',
  '1. 仓库包身份已统一为 `@ychris12138/dsh-usage-stats`；每次发版需同步 `package.json` / `package-lock.json` / `catalog/v1/plugins.json` 的版本。\n2. 发布 scoped 公共包：`npm publish --access public`。'
);
await writeFile("README.md", readme);

await rm("scripts/.release-0.2.6-prep.mjs");
await rm(".github/workflows/release-0.2.6-bootstrap.yml");
