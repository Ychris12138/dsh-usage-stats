import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js"), "utf8");

if (!source.includes(".usg_panel{z-index:100;")) {
	throw new Error("usage panel must stay in the DSH overlay layer above sidebar workbenches (#30)");
}
if (source.includes(".usg_panel{z-index:30;")) {
	throw new Error("legacy sidebar-level z-index must not return (#30)");
}

console.log("overlay layering regression ok");
