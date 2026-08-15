import assert from "node:assert/strict";
import { collectSubscription, collectSubscriptions, subscriptionCredentialRefs } from "../lib/subscriptions.js";

function credentials(values) {
	return {
		resolve: async (ref) => Object.hasOwn(values, ref) ? { value: values[ref] } : void 0
	};
}

const now = Date.parse("2026-08-14T00:00:00Z");
const noLocalAuth = {
	homedir: () => "/test-home",
	readFile: async () => { throw new Error("missing"); }
};

{
	const providers = await collectSubscriptions(credentials({}), {}, { ...noLocalAuth, now: () => now });
	assert.deepEqual(providers.map((provider) => [provider.id, provider.status]), [
		["opencode-go", "not-configured"],
		["zai", "not-configured"]
	]);
	assert.deepEqual(providers[0].missingCredentials, [subscriptionCredentialRefs.openCodeApiKey]);
	console.log("not-configured states ok");
}

{
	const calls = [];
	const secret = "sk-opencode-test";
	const providers = await collectSubscriptions(credentials({ OPENCODE_GO_API_KEY: secret }), {}, {
		...noLocalAuth,
		now: () => now,
		fetch: async (url, init) => {
			calls.push({ url: String(url), init });
			if (String(url).includes("api.z.ai")) return { ok: false, status: 401, json: async () => ({}) };
			return {
				ok: true,
				status: 200,
				json: async () => ({ usage: {
					rolling: { status: "ok", percent: 9, resetsAt: "2026-08-14T07:20:04.810Z" },
					weekly: { status: "ok", percent: 12, resetsAt: "2026-08-17T00:00:00.810Z" },
					monthly: { status: "ok", percent: 6, resetsAt: "2026-09-09T00:41:03.810Z" }
				} })
			};
		}
	});
	const go = providers[0];
	assert.equal(go.status, "ok");
	assert.deepEqual(go.windows.map((window) => [window.kind, window.usedPercent]), [["session", 9], ["weekly", 12], ["monthly", 6]]);
	assert.equal(calls[0].url, "https://opencode.ai/zen/go/v1/usage");
	assert.equal(calls[0].init.headers.authorization, `Bearer ${secret}`);
	assert.equal(JSON.stringify(go).includes(secret), false, "API key must not cross the module interface");
	console.log("OpenCode Go Bearer endpoint normalization ok");
}

{
	const calls = [];
	const secret = "super-secret-cookie";
	const providers = await collectSubscriptions(credentials({
		OPENCODE_GO_AUTH_COOKIE: secret,
		OPENCODE_GO_WORKSPACE_ID: "https://opencode.ai/workspace/wrk_TEST/go"
	}), {}, {
		...noLocalAuth,
		now: () => now,
		fetch: async (url, init) => {
			calls.push({ url: String(url), init });
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({
					rollingUsage: { usagePercent: 12, resetInSec: 3600 },
					weeklyUsage: { usagePercent: 34, resetInSec: 86400 },
					monthlyUsage: { usagePercent: 56, resetInSec: 2592000 }
				})
			};
		}
	});
	const go = providers[0];
	assert.equal(go.status, "ok");
	assert.deepEqual(go.windows.map((window) => [window.kind, window.usedPercent]), [["session", 12], ["weekly", 34], ["monthly", 56]]);
	assert.equal(calls[0].url, "https://opencode.ai/workspace/wrk_TEST/go");
	assert.equal(calls[0].init.headers.cookie, `auth=${secret}`);
	assert.equal(JSON.stringify(go).includes(secret), false, "cookie must not cross the module interface");
	console.log("OpenCode Go dashboard normalization ok");
}

{
	const calls = [];
	const providers = await collectSubscriptions(credentials({}), {}, {
		homedir: () => "/users/demo",
		readFile: async (path) => {
			assert.equal(String(path).replaceAll("\\", "/"), "/users/demo/.local/share/opencode/auth.json");
			return JSON.stringify({ "opencode-go": { type: "api", key: "local-opencode-key" } });
		},
		now: () => now,
		fetch: async (url, init) => {
			calls.push(String(url));
			assert.equal(init.headers.authorization, "Bearer local-opencode-key");
			return { ok: true, status: 200, json: async () => ({ usage: { rolling: { percent: 1 }, weekly: { percent: 2 }, monthly: { percent: 3 } } }) };
		}
	});
	assert.equal(providers[0].status, "ok");
	assert.deepEqual(calls, ["https://opencode.ai/zen/go/v1/usage"]);
	console.log("OpenCode auth.json fallback ok");
}

{
	const calls = [];
	const secret = "zai-secret-key";
	const providers = await collectSubscriptions(credentials({ ZAI_API_KEY: secret }), {}, {
		...noLocalAuth,
		now: () => now,
		fetch: async (url, init) => {
			calls.push({ url: String(url), init });
			if (String(url).endsWith("/quota/limit")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({ data: { limits: [
						{ type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 1000, currentValue: 120, remaining: 850 },
						{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 25 },
						{ type: "TIME_LIMIT", remaining: 9, percentage: 40 }
					] } })
				};
			}
			return { ok: true, status: 200, json: async () => ({ data: [{ product_name: "GLM Coding Pro", next_renew_time: "2026-09-01T00:00:00Z" }] }) };
		}
	});
	const zai = providers[1];
	assert.equal(zai.status, "ok");
	assert.equal(zai.plan, "GLM Coding Pro");
	assert.deepEqual(zai.windows.map((window) => [window.kind, Math.round(window.usedPercent)]), [["session", 15], ["weekly", 25], ["billing", 40]]);
	assert.deepEqual(calls.map((call) => call.url), [
		"https://api.z.ai/api/monitor/usage/quota/limit",
		"https://api.z.ai/api/biz/subscription/list"
	]);
	assert.ok(calls.every((call) => call.init.headers.authorization === secret));
	assert.equal(JSON.stringify(zai).includes(secret), false, "API key must not cross the module interface");
	console.log("Z.ai quota normalization ok");
}

{
	const providers = await collectSubscriptions(credentials({ ZAI_API_KEY: "x", ZAI_API_REGION: "cn" }), {}, {
		...noLocalAuth,
		now: () => now,
		fetch: async (url) => {
			assert.match(String(url), /^https:\/\/open\.bigmodel\.cn\//);
			return { ok: false, status: 401, json: async () => ({}) };
		}
	});
	assert.equal(providers[1].region, "bigmodel-cn");
	assert.equal(providers[1].status, "unauthorized");
	console.log("Z.ai region and auth error mapping ok");
}

{
	const secret = "kimi-secret";
	const kimi = await collectSubscription("kimi", credentials({ KIMI_API_KEY: secret }), {}, {
		now: () => now,
		fetch: async (url, init) => {
			assert.equal(String(url), "https://api.kimi.com/coding/v1/usages");
			assert.equal(init.headers.authorization, `Bearer ${secret}`);
			return {
				ok: true,
				status: 200,
				json: async () => ({
					plan: "Coding Pro",
					limits: [{ detail: { limit: 1000, remaining: 750, resetTime: "2026-08-14T05:00:00Z" } }],
					usage: { limit: 10000, remaining: 6000, resetTime: "2026-08-17T00:00:00Z" }
				})
			};
		}
	});
	assert.equal(kimi.status, "ok");
	assert.equal(kimi.plan, "Coding Pro");
	assert.deepEqual(kimi.windows.map((window) => [window.kind, window.usedPercent, window.remainingPercent]), [
		["session", 25, 75],
		["weekly", 40, 60]
	]);
	assert.equal(JSON.stringify(kimi).includes(secret), false);
	console.log("Kimi token plan normalization ok");
}

{
	const secret = "minimax-secret";
	const minimax = await collectSubscription("minimax", credentials({ MINIMAX_API_KEY: secret, MINIMAX_API_REGION: "cn" }), {}, {
		now: () => now,
		fetch: async (url, init) => {
			assert.equal(String(url), "https://www.minimaxi.com/v1/token_plan/remains");
			assert.equal(init.headers.authorization, `Bearer ${secret}`);
			return {
				ok: true,
				status: 200,
				json: async () => ({
					base_resp: { status_code: 0 },
					model_remains: [{
						model_name: "general",
						current_interval_remaining_percent: 82,
						remains_time: 3600000,
						current_weekly_status: 1,
						current_weekly_remaining_percent: 45,
						weekly_remains_time: 604800000
					}]
				})
			};
		}
	});
	assert.equal(minimax.status, "ok");
	assert.equal(minimax.region, "cn");
	assert.deepEqual(minimax.windows.map((window) => [window.kind, window.usedPercent, window.remainingPercent]), [
		["session", 18, 82],
		["weekly", 55, 45]
	]);
	assert.deepEqual(minimax.windows.map((window) => window.resetsAt), [
		"2026-08-14T01:00:00.000Z",
		"2026-08-21T00:00:00.000Z"
	]);
	assert.equal(JSON.stringify(minimax).includes(secret), false);
	console.log("MiniMax token plan normalization ok");
}

{
	const calls = [];
	const minimax = await collectSubscription("minimax", credentials({ MINIMAX_API_KEY: "x" }), {}, {
		now: () => now,
		fetch: async (url) => {
			calls.push(String(url));
			if (calls.length === 1) return { ok: false, status: 404, json: async () => ({}) };
			return {
				ok: true,
				status: 200,
				json: async () => ({ model_remains: [{ model_name: "general", current_interval_remaining_percent: 90, current_weekly_status: 0 }] })
			};
		}
	});
	assert.equal(minimax.status, "ok");
	assert.deepEqual(calls, [
		"https://www.minimax.io/v1/token_plan/remains",
		"https://api.minimax.io/v1/api/openplatform/coding_plan/remains"
	]);
	console.log("MiniMax official endpoint and legacy fallback ok");
}

{
	const minimax = await collectSubscription("minimax", credentials({ MINIMAX_API_KEY: "x" }), {}, {
		now: () => now,
		fetch: async () => ({
			ok: true,
			status: 200,
			json: async () => ({ model_remains: [{ model_name: "text-01", current_interval_remaining_percent: 99 }] })
		})
	});
	assert.equal(minimax.status, "invalid-response");
	assert.deepEqual(minimax.windows, []);
	console.log("MiniMax ignores non-general model quotas ok");
}

{
	const kimi = await collectSubscription("kimi", credentials({ KIMI_API_KEY: "x" }), {}, {
		now: () => now,
		fetch: async () => ({
			ok: true,
			status: 200,
			json: async () => { throw new SyntaxError("bad json"); }
		})
	});
	assert.equal(kimi.status, "invalid-response");
	assert.deepEqual(kimi.windows, []);
	console.log("Token-plan invalid JSON classification ok");
}

console.log("SUBSCRIPTION TESTS PASSED");
