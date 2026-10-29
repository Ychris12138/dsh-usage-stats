import assert from "node:assert/strict";
import { parseArkCodingPlan, queryArkCodingPlan, validateArkCLIConfig } from "../lib/ark-coding-plan.js";
import { createAccountService, validateAccountConfig } from "../lib/accounts.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const monitor = { adapter: "ark-coding-plan-cli", arkCLIExecutable: "/opt/arkcli-darwin-arm64", arkCLIProfile: "personal-coding" };
const fixture = () => ({
	viewer: { profile: "personal-coding", tenant: "volc", user_name: "private-name", account_id: "private-account" },
	items: [{ product: "coding-plan", edition: "personal", subscribed: true, periods: [
		{ label: "monthly", percent: 15, reset_at: "2026-11-01T00:00:00+08:00" },
		{ label: "session", percent: 0.5 },
		{ label: "weekly", percent: 100 }
	] }]
});

const parsed = parseArkCodingPlan(fixture(), monitor.arkCLIProfile);
assert.equal(parsed.status, "ok");
assert.deepEqual(parsed.windows.map((w) => [w.kind, w.usedPercent, w.remainingPercent]), [["session", 0.5, 99.5], ["weekly", 100, 0], ["monthly", 15, 85]]);
assert.equal(parsed.windows[2].resetsAt, "2026-10-31T16:00:00.000Z");
assert.equal("total" in parsed.windows[0], false, "Coding Plan percentages cannot invent absolute quota");
for (const bad of [null, true, -1, 101, "", "NaN", {}, Infinity]) {
	const body = fixture(); body.items[0].periods[0].percent = bad;
	assert.equal(parseArkCodingPlan(body, monitor.arkCLIProfile).status, "invalid-response");
}
for (const mutate of [
	(body) => { body.viewer.profile = "other-account-profile"; },
	(body) => { body.viewer.tenant = "byteplus"; },
	(body) => { body.items[0].product = "coding-plan-team"; },
	(body) => { body.items[0].periods[0].label = "unknown-window"; },
	(body) => { body.items[0].periods.push({ label: "session", percent: 30 }); },
	(body) => { body.items[0].periods[0].reset_at = "secret-echo"; },
	(body) => { body.items.push(body.items[0]); }
]) {
	const body = fixture(); mutate(body);
	assert.equal(parseArkCodingPlan(body, monitor.arkCLIProfile).status, "invalid-response");
}
const unsubscribed = fixture(); unsubscribed.items[0].subscribed = false; unsubscribed.items[0].periods = [];
assert.equal(parseArkCodingPlan(unsubscribed, monitor.arkCLIProfile).reason, "ark-cli-no-subscription");
const failed = fixture(); failed.items[0].error = "private-account private-secret";
assert.equal(JSON.stringify(parseArkCodingPlan(failed, monitor.arkCLIProfile)).includes("private-"), false);

for (const bad of ["../arkcli", "arkcli", "/bin/arkcli.js", "/bin/arkcli.cmd", "/bin/arkcli\0", 1]) {
	assert.throws(() => validateArkCLIConfig({ ...monitor, arkCLIExecutable: bad }, "monitor"), /arkCLIExecutable/);
}
for (const bad of ["", "--other", "a b", "x; echo", "x".repeat(65), true]) {
	assert.throws(() => validateArkCLIConfig({ ...monitor, arkCLIProfile: bad }, "monitor"), /arkCLIProfile/);
}
assert.equal((await queryArkCodingPlan({}, { arkExecFile: () => { throw new Error("must not spawn"); } })).status, "not-configured");

let calls = 0;
const service = createAccountService({
	getProviders: async () => [],
	credentials: { resolve: () => { throw new Error("CLI authentication must not read DSH model credentials"); } },
	config: validateAccountConfig({ monitors: { "ark-coding-plan-cn": monitor } }),
	deps: { includeLegacyProviders: false, now: () => Date.parse("2026-10-20T00:00:00Z"), arkExecFile: async (file, args, options) => {
		calls += 1;
		assert.equal(file, monitor.arkCLIExecutable);
		assert.deepEqual(args, ["usage", "plan", "--product", "coding-plan", "--profile", monitor.arkCLIProfile, "--format", "json"]);
		assert.equal(options.shell, false);
		assert.equal(options.timeout, 15000);
		assert.equal(options.maxBuffer, 1024 * 1024);
		assert.equal(options.env.ARK_API_KEY, void 0);
		assert.equal(options.env.ARK_PROFILE, void 0);
		return { stdout: JSON.stringify(fixture()) };
	} }
});
await service.validate();
assert.equal((await service.providerViews())[0].configured, true);
assert.equal(calls, 0, "discovery never runs a CLI command");
const account = await service.get("ark-coding-plan-cn");
assert.equal(account.status, "ok");
assert.equal(account.provenance, "experimental");
assert.equal(account.lastSuccessAt, Date.parse("2026-10-20T00:00:00Z"));
assert.equal(JSON.stringify(account).includes("private-"), false);
assert.equal(JSON.stringify(service.cached("ark-coding-plan-cn")).includes("private-"), false);
assert.equal(JSON.stringify(await service.providerViews()).includes("private-"), false);
await service.refreshDue({ force: true });
assert.equal(calls, 2);
for (const [error, status, reason] of [
	[{ code: "ENOENT", message: "private-secret" }, "unsupported", "ark-cli-not-found"],
	[{ killed: true, stderr: "private-secret" }, "unavailable", "timeout"],
	[{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: "private-secret" }, "invalid-response", "upstream-too-large"],
	[{ code: 1, stdout: "private-secret", stderr: "private-account" }, "unavailable", "ark-cli-query-failed"]
]) {
	const result = await queryArkCodingPlan(monitor, { arkExecFile: async () => { throw error; } });
	assert.equal(result.status, status); assert.equal(result.reason, reason);
	assert.equal(JSON.stringify(result).includes("private-"), false);
}
assert.equal((await queryArkCodingPlan(monitor, { arkExecFile: async () => ({ stdout: "not-json private-secret" }) })).status, "invalid-response");
const temporary = await mkdtemp(join(tmpdir(), "dsh-ark-native-"));
try {
	const wrapper = join(temporary, "arkcli");
	await writeFile(wrapper, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
	assert.equal((await queryArkCodingPlan({ ...monitor, arkCLIExecutable: wrapper })).reason, "ark-cli-native-executable-required");
} finally { await rm(temporary, { recursive: true, force: true }); }
console.log("ARK CODING PLAN CLI REGRESSION TESTS PASSED");
