import assert from "node:assert/strict";
import { createQianwenAuth, queryQianwenPersonalPlan } from "../lib/qianwen-token-plan.js";
import { validateAccountConfig, resolveAccountSpec, queryAccount, createAccountService } from "../lib/accounts.js";

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const epoch = Date.parse("2026-11-12T00:00:00Z");
let clock = epoch;
let verifierChallenge;
const auth = createQianwenAuth({ now: () => clock, fetch: async (raw, init) => {
	const url = new URL(raw);
	assert.equal(url.origin, "https://t.qianwenai.com");
	assert.equal(init.redirect, "error");
	if (url.pathname.endsWith("/code")) {
		assert.equal(url.searchParams.get("code_challenge_method"), "S256");
		verifierChallenge = url.searchParams.get("code_challenge");
		return reply({ Success: true, Data: { Token: "test-device-secret", VerificationUrl: "https://account.qianwenai.com/authorize?code=example", ExpiresIn: 300, Interval: 2 } });
	}
	const { createHash } = await import("node:crypto");
	assert.equal(createHash("sha256").update(url.searchParams.get("code_verifier")).digest("base64url"), verifierChallenge);
	assert.equal(url.searchParams.get("token"), "test-device-secret");
	return reply({ Data: { Status: "complete", Credentials: { AccessToken: "test-access-secret", ExpireTime: "2026-12-01T00:00:00Z" } } });
} });
const started = await auth.start();
assert.equal(new URL(started.verificationUrl).hostname, "account.qianwenai.com");
assert.equal(JSON.stringify(started).includes("test-device-secret"), false);
assert.deepEqual(await auth.poll(), { status: "pending" });
clock += 2000;
const authorized = await auth.poll();
assert.equal(authorized.status, "complete");
assert.equal(authorized.credential.accessToken, "test-access-secret");
await assert.rejects(auth.poll(), { code: "qianwen-no-pending-login" });

const wrap = (data) => ({ code: "200", successResponse: true, data: { success: true, DataV2: { ret: ["SUCCESS::ok"], data: { success: true, code: "SUCCESS", data } } } });
let seen = [];
function mock(usage = { per1MonthPercentage: 0.009, per1MonthResetTime: Date.parse("2026-12-12T16:00:00Z") }) {
	return async (raw, init) => {
		const url = new URL(raw);
		seen.push(url.origin + url.pathname);
		assert.equal(init.redirect, "error");
		if (url.hostname === "cli.qianwenai.com") {
			assert.equal(init.headers.authorization, "Bearer test-access-secret");
			assert.equal(JSON.parse(init.body).action, "GenerateCLIAccessToken");
			return reply({ code: "200", successResponse: true, data: { cliAccessToken: "test-derived-secret" } });
		}
		assert.equal(url.hostname, "cs-data.qianwenai.com");
		assert.equal(init.headers.authorization, "Bearer test-derived-secret");
		const action = url.searchParams.get("api").split("/").at(-1);
		const params = JSON.parse(new URLSearchParams(init.body).get("params"));
		assert.ok(params.Api.endsWith(`/${action}`));
		if (action === "subscription") return reply(wrap({ status: "VALID", specCode: "essential", startTime: epoch - 1000, endTime: epoch + 86400000 }));
		if (action === "quota-config") return reply(wrap({ essential: { monthly: 45000 } }));
		if (action === "usage") return reply(wrap(usage));
		throw new Error("unexpected route");
	};
}
const result = await queryQianwenPersonalPlan(authorized.credential, { fetch: mock(), now: () => epoch });
assert.deepEqual(result, { status: "ok", plan: "Qianwen Token Plan essential", windows: [{ kind: "monthly", usedPercent: 0.9, remainingPercent: 99.1, resetsAt: "2026-12-12T16:00:00.000Z" }], quota: { total: 45000, unit: "credits" } });
assert.equal(JSON.stringify(result).includes("secret"), false);
assert.equal(seen.length, 4);
await assert.rejects(queryQianwenPersonalPlan(authorized.credential, { fetch: mock({ per1MonthPercentage: 1.1 }), now: () => epoch }), { code: "qianwen-invalid-response" });
const weekly = await queryQianwenPersonalPlan(authorized.credential, { fetch: mock({ per1WeekPercentage: 0.25 }), now: () => epoch });
assert.equal(weekly.windows[0].kind, "weekly");
assert.equal(weekly.windows[0].remainingPercent, 75);
assert.equal("quota" in weekly, false);
await assert.rejects(queryQianwenPersonalPlan(authorized.credential, { fetch: mock({ per1MonthPercentage: 0.2, per1MonthResetTime: -1 }), now: () => epoch }), { code: "qianwen-invalid-response" });
await assert.rejects(queryQianwenPersonalPlan({ ...authorized.credential, expiresAt: "2026-01-01T00:00:00Z" }, { fetch: () => { throw new Error("must not request"); }, now: () => epoch }), { code: "qianwen-unauthorized" });
const malicious = createQianwenAuth({ fetch: async () => reply({ Success: true, Data: { Token: "secret", VerificationUrl: "https://evil.example/", ExpiresIn: 300, Interval: 2 } }) });
await assert.rejects(malicious.start(), { code: "qianwen-invalid-response" });

const config = validateAccountConfig({ monitors: { "qianwen-plan": { adapter: "qianwen-token-plan", credentialRef: "QIANWEN_MANAGEMENT" } } });
const spec = resolveAccountSpec({ id: "qianwen-plan", displayName: "Qianwen", apiKeyEnv: "MODEL_KEY" }, config);
assert.equal(spec.adapter, "qianwen-token-plan");
assert.equal(spec.mode, "subscription");
const credentials = { resolve: async (ref) => { assert.equal(ref, "QIANWEN_MANAGEMENT"); return { value: JSON.stringify(authorized.credential) }; } };
const account = await queryAccount(spec, credentials, { fetch: mock(), now: () => epoch });
assert.equal(account.status, "ok");
assert.equal(account.provenance, "experimental");
assert.equal(account.windows[0].remainingPercent, 99.1);
assert.deepEqual(account.quota, { total: 45000, unit: "credits" });
assert.equal(JSON.stringify(account).includes("secret"), false);
let pinnedRequests = 0;
const pinnedAccount = await queryAccount(spec, credentials, {
	now: () => epoch,
	lookup: async () => [{ address: "8.8.8.8", family: 4 }],
	requestPinned: async (url, address, init) => {
		assert.equal(address.address, "8.8.8.8");
		assert.equal(init.method, "POST");
		assert.equal(typeof init.body, "string");
		pinnedRequests++;
		return mock()(url.href, init);
	}
});
assert.equal(pinnedAccount.status, "ok");
assert.equal(pinnedRequests, 4);
let activeCredential = JSON.stringify(authorized.credential);
let releaseRequest;
let requestStarted;
const startedRequest = new Promise((resolve) => { requestStarted = resolve; });
const waitRequest = new Promise((resolve) => { releaseRequest = resolve; });
const oldAccount = queryAccount(spec, { resolve: async () => ({ value: activeCredential }) }, {
	now: () => epoch,
	fetch: async (url, init) => {
		if (new URL(url).hostname === "cli.qianwenai.com") { requestStarted(); await waitRequest; }
		return mock()(url, init);
	}
});
await startedRequest;
activeCredential = "";
releaseRequest();
assert.equal((await oldAccount).status, "not-configured", "a disconnected credential cannot publish an in-flight result");
const emptyAccount = await queryAccount(spec, { resolve: async () => null }, { fetch: () => { throw new Error("unexpected network"); }, now: () => epoch });
assert.equal(emptyAccount.status, "not-configured");
const nativeSpec = resolveAccountSpec({ id: "qwen-token-plan-cn", displayName: "Qwen", apiKeyEnv: "MODEL_KEY", baseURL: "https://token-plan.cn-beijing.maas.aliyuncs.com/v1" }, validateAccountConfig({}));
assert.equal(nativeSpec.adapter, "qianwen-token-plan");
assert.equal(nativeSpec.apiKeyRef, "QIANWEN_TOKEN_PLAN_AUTH", "model API key must never become the management credential");
const nativeCredentials = { resolve: async (ref) => { assert.equal(ref, "QIANWEN_TOKEN_PLAN_AUTH"); return { value: JSON.stringify(authorized.credential) }; } };
assert.equal((await queryAccount(nativeSpec, nativeCredentials, { fetch: mock(), now: () => epoch })).status, "ok");
const nativeService = createAccountService({ credentials: nativeCredentials, getProviders: async () => [{ id: "qwen-token-plan-cn", apiKeyEnv: "MODEL_KEY" }], config: validateAccountConfig({}), deps: { fetch: mock(), now: () => epoch, includeLegacyProviders: true } });
const nativeViews = await nativeService.providerViews();
assert.equal(nativeViews.find((entry) => entry.id === "qwen-token-plan-cn")?.qianwenAuthManaged, true);
assert.equal(nativeViews.some((entry) => entry.id === "qianwen-token-plan"), false, "the real model route avoids a duplicate synthetic account");
await nativeService.get("qwen-token-plan-cn");
assert.equal(nativeService.cached("qwen-token-plan-cn").status, "ok");
nativeService.invalidateAdapter("qianwen-token-plan");
assert.equal(nativeService.cached("qwen-token-plan-cn"), null);
assert.throws(() => validateAccountConfig({ monitors: { bad: { adapter: "qianwen-token-plan" } } }));
assert.throws(() => validateAccountConfig({ monitors: { bad: { adapter: "qianwen-token-plan", credentialRef: "REF", usageBaseURL: "https://evil.example" } } }));
const service = createAccountService({ credentials, getProviders: async () => [], config, deps: { fetch: mock(), now: () => epoch, includeLegacyProviders: false } });
assert.ok((await service.providerViews()).some((entry) => entry.id === "qianwen-plan"));
assert.equal((await service.get("qianwen-plan")).windows[0].remainingPercent, 99.1);
console.log("Qianwen Token Plan protocol tests passed");
