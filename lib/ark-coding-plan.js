/** Optional, read-only personal Coding Plan lookup through the official Ark CLI. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
import { open } from "node:fs/promises";

const runFile = promisify(execFile);
const MAX_BYTES = 1024 * 1024;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const KINDS = new Map([["session", "session"], ["5h", "session"], ["weekly", "weekly"], ["monthly", "monthly"]]);
const NATIVE_MAGIC = new Set(["7f454c46", "feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);

async function isNativeExecutable(path) {
	const file = await open(path, "r");
	try {
		const bytes = Buffer.alloc(4);
		const { bytesRead } = await file.read(bytes, 0, 4, 0);
		return bytesRead === 4 && (NATIVE_MAGIC.has(bytes.toString("hex")) || bytes[0] === 0x4d && bytes[1] === 0x5a);
	} finally { await file.close(); }
}

export function validateArkCLIConfig(monitor, label) {
	if (monitor.arkCLIExecutable !== void 0 && (typeof monitor.arkCLIExecutable !== "string"
		|| !isAbsolute(monitor.arkCLIExecutable) || monitor.arkCLIExecutable.includes("\0")
		|| monitor.arkCLIExecutable.length > 4096 || /\.(?:cmd|bat|ps1|js)$/i.test(monitor.arkCLIExecutable))) {
		throw new Error(`${label}.arkCLIExecutable must be the absolute path to the official native arkcli executable`);
	}
	if (monitor.arkCLIProfile !== void 0 && (typeof monitor.arkCLIProfile !== "string" || !PROFILE.test(monitor.arkCLIProfile))) {
		throw new Error(`${label}.arkCLIProfile must be a named CLI profile (letters, digits, _, ., -; maximum 64 characters)`);
	}
}

function result(status, reason, extra = {}) {
	return { status, windows: [], reason, ...extra };
}

function number(value) {
	if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/** Parse only the documented personal Coding Plan bucket; never expose viewer identities or errors. */
export function parseArkCodingPlan(body, profile) {
	if (body === null || typeof body !== "object" || !Array.isArray(body.items)
		|| body.viewer?.profile !== profile || body.viewer?.tenant !== "volc") {
		return result("invalid-response", "ark-cli-response-unrecognized");
	}
	const items = body.items.filter((item) => item?.product === "coding-plan");
	if (items.length !== 1) return result("invalid-response", "ark-cli-response-unrecognized");
	const item = items[0];
	if (item.error !== void 0 && item.error !== "") return result("unavailable", "ark-cli-query-failed");
	if (item.subscribed === false && Array.isArray(item.periods) && item.periods.length === 0) {
		return result("not-configured", "ark-cli-no-subscription");
	}
	if (item.subscribed !== true || item.edition !== "personal" || !Array.isArray(item.periods) || item.periods.length === 0 || item.periods.length > 16) {
		return result("invalid-response", "ark-cli-response-unrecognized");
	}
	const seen = new Set();
	const windows = [];
	for (const period of item.periods) {
		const kind = KINDS.get(period?.label);
		const usedPercent = number(period?.percent);
		if (kind === void 0 || seen.has(kind) || usedPercent === null || usedPercent < 0 || usedPercent > 100) {
			return result("invalid-response", "ark-cli-response-unrecognized");
		}
		seen.add(kind);
		const window = { kind, usedPercent: Math.round(usedPercent * 10) / 10, remainingPercent: Math.round((100 - usedPercent) * 10) / 10 };
		if (period.reset_at !== void 0) {
			if (typeof period.reset_at !== "string" || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(period.reset_at)
				|| !Number.isFinite(Date.parse(period.reset_at))) return result("invalid-response", "ark-cli-response-unrecognized");
			window.resetsAt = new Date(period.reset_at).toISOString();
		}
		windows.push(window);
	}
	windows.sort((a, b) => ["session", "weekly", "monthly"].indexOf(a.kind) - ["session", "weekly", "monthly"].indexOf(b.kind));
	return { status: "ok", plan: "Coding Plan", windows };
}

export async function queryArkCodingPlan(monitor, deps = {}) {
	const missing = ["arkCLIExecutable", "arkCLIProfile"].filter((key) => !monitor[key]);
	if (missing.length > 0) return result("not-configured", "ark-cli-not-configured", { missingCredentials: missing });
	validateArkCLIConfig(monitor, "monitor");
	// No shell, PATH lookup, package download, login, profile switch or key rotation.
	// Inherited credential overrides are excluded; the explicitly named CLI
	// profile owns authentication. Its private files are never read by this plugin.
	const env = {};
	for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "SYSTEMROOT", "LANG", "LC_ALL"]) {
		if (typeof process.env[key] === "string") env[key] = process.env[key];
	}
	env.ARKCLI_CALLER_NAME = "dsh-usage-stats";
	try {
		// npm's Node wrapper spawns a grandchild that a parent timeout cannot
		// reliably stop. Require the actual native binary, so timeout bounds the
		// process doing the query and scripts cannot request an interactive shell.
		if (deps.arkExecFile === void 0 && !await isNativeExecutable(monitor.arkCLIExecutable)) {
			return result("unsupported", "ark-cli-native-executable-required");
		}
		const pending = (deps.arkExecFile ?? runFile)(monitor.arkCLIExecutable,
			["usage", "plan", "--product", "coding-plan", "--profile", monitor.arkCLIProfile, "--format", "json"],
			{ encoding: "utf8", timeout: deps.timeoutMs ?? 15000, maxBuffer: MAX_BYTES, windowsHide: true, shell: false, env });
		pending.child?.stdin?.end();
		const { stdout } = await pending;
		if (typeof stdout !== "string" || Buffer.byteLength(stdout) > MAX_BYTES) return result("invalid-response", "ark-cli-response-unrecognized");
		try { return parseArkCodingPlan(JSON.parse(stdout), monitor.arkCLIProfile); }
		catch { return result("invalid-response", "ark-cli-response-unrecognized"); }
	} catch (error) {
		if (error?.code === "ENOENT") return result("unsupported", "ark-cli-not-found");
		if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return result("invalid-response", "upstream-too-large");
		return result("unavailable", error?.killed === true ? "timeout" : "ark-cli-query-failed");
	}
}
