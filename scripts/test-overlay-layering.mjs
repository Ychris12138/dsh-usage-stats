import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js"), "utf8");

const match = /\.usg_panel\{z-index:(\d+);/.exec(source);
if (match === null) {
	throw new Error("usage panel must declare an explicit z-index (#30)");
}
const zIndex = Number(match[1]);
if (!(zIndex > 2147482999 && zIndex <= 2147483647)) {
	throw new Error("usage panel must stack above mobile adaptation shells, which reach 2147482999 (#30)");
}

console.log("overlay layering regression ok");
