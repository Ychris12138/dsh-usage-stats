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
	assert.deepEqual(minimax.windows.map((window) => [window.kind, window.remainingPercent]), [["session", 90]]);
	assert.deepEqual(calls, [
		"https://www.minimax.io/v1/token_plan/remains",
		"https://api.minimax.io/v1/token_plan/remains"
	]);
	console.log("MiniMax official endpoint and api-host fallback ok");
}

{
	const calls = [];
	const minimax = await collectSubscription("minimax", credentials({ MINIMAX_API_KEY: "x" }), {}, {
		now: () => now,
		fetch: async (url) => {
			calls.push(String(url));
			if (calls.length < 3) return { ok: false, status: 404, json: async () => ({}) };
			return {
				ok: true,
				status: 200,
				json: async () => ({ model_remains: [{ model_name: "general", current_interval_remaining_percent: 88 }] })
			};
		}
	});
	assert.equal(minimax.status, "ok");
	assert.deepEqual(calls, [
		"https://www.minimax.io/v1/token_plan/remains",
		"https://api.minimax.io/v1/token_plan/remains",
		"https://api.minimax.io/v1/api/openplatform/coding_plan/remains"
	]);
	console.log("MiniMax legacy coding-plan fallback ok");
}

{
	const minimax = await collectSubscription("minimax", credentials({ MINIMAX_API_KEY: "x" }), {}, {
		now: () => now,
		fetch: async () => ({
			ok: true,
			status: 200,
			json: async () => ({ model_remains: [{ model_name: "video", current_interval_remaining_percent: 99 }] })
		})
	});
	assert.equal(minimax.status, "invalid-response");
	assert.deepEqual(minimax.windows, []);
	assert.equal(minimax.reason, "model_remains has no general/chat-model entry");
	console.log("MiniMax ignores non-chat model quotas ok");
}

{
	// Newer payload versions name the chat entry after the model itself
	// (e.g. "MiniMax-M3") instead of the "general" resource group (#14).
	const minimax = await collectSubscription("minimax", credentials({ MINIMAX_API_KEY: "x" }), {}, {
		now: () => now,
		fetch: async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				base_resp: { status_code: 0, status_msg: "success" },
				model_remains: [
					{ model_name: "video", current_interval_remaining_percent: 66, current_weekly_remaining_percent: 95 },
					{
						model_name: "MiniMax-M3",
						current_interval_remaining_percent: 80,
						remains_time: 3600000,
						current_weekly_remaining_percent: 45,
						weekly_remains_time: 604800000
					}
				]
			})
		})
	});
	assert.equal(minimax.status, "ok");
	assert.deepEqual(minimax.windows.map((window) => [window.kind, window.remainingPercent]), [
		["session", 80],
		["weekly", 45]
	]);
	console.log("MiniMax model-named chat entry ok");
}

{
	// Window status semantics: 1 = normal, 2 = exhausted, 3 = unlimited.
	// Exhausted/unlimited windows must still render instead of disappearing (#14).
	const fetchFor = (entry) => async () => ({ ok: true, status: 200, json: async () => ({ model_remains: [{ model_name: "general", ...entry }] }) });
	const exhausted = await collectSubscription("minimax", credentials({ MINIMAX_API_KEY: "x" }), {}, {
		now: () => now,
		fetch: fetchFor({ current_interval_remaining_percent: 12, current_weekly_status: 2 })
	});
	assert.deepEqual(exhausted.windows.map((window) => [window.kind, window.remainingPercent]), [
		["session", 12],
		["weekly", 0]
	]);
	const unlimited = await collectSubscription("minimax", credentials({ MINIMAX_API_KEY: "x" }), {}, {
		now: () => now,
		fetch: fetchFor({ current_interval_status: 3, current_weekly_status: 1, current_weekly_remaining_percent: 64 })
	});
	assert.deepEqual(unlimited.windows.map((window) => [window.kind, window.remainingPercent]), [
		["session", 100],
		["weekly", 64]
	]);
	const legacyCounters = await collectSubscription("minimax", credentials({ MINIMAX_API_KEY: "x" }), {}, {
		now: () => now,
		fetch: fetchFor({ current_interval_total_count: 1500, current_interval_usage_count: 300, current_weekly_remaining_percent: 70 })
	});
	assert.deepEqual(legacyCounters.windows.map((window) => [window.kind, window.remainingPercent]), [
		["session", 80],
		["weekly", 70]
	]);
	console.log("MiniMax window status and counter fallbacks ok");
}

{
	// Upstream business errors surface as invalid-response with a safe reason.
	const minimax = await collectSubscription("minimax", credentials({ MINIMAX_API_KEY: "x" }), {}, {
		now: () => now,
		fetch: async () => ({
			ok: true,
			status: 200,
			json: async () => ({ base_resp: { status_code: 2057, status_msg: "not a coding plan key" } })
		})
	});
	assert.equal(minimax.status, "invalid-response");
	assert.deepEqual(minimax.windows, []);
	assert.equal(minimax.reason, "base_resp status_code 2057: not a coding plan key");
	console.log("MiniMax base_resp error reason ok");
}

{
	// A non-JSON (HTML) reply from the www host falls through to the api host.
	const calls = [];
	const minimax = await collectSubscription("minimax", credentials({ MINIMAX_API_KEY: "x" }), {}, {
		now: () => now,
		fetch: async (url) => {
			calls.push(String(url));
			if (calls.length === 1) return { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } };
			return {
				ok: true,
				status: 200,
				json: async () => ({ model_remains: [{ model_name: "general", current_interval_remaining_percent: 77, current_weekly_remaining_percent: 55 }] })
			};
		}
	});
	assert.equal(minimax.status, "ok");
	assert.deepEqual(calls, [
		"https://www.minimax.io/v1/token_plan/remains",
		"https://api.minimax.io/v1/token_plan/remains"
	]);
	console.log("MiniMax non-JSON host fallback ok");
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

{
	// Ollama Cloud: normal limits.session.usage + limits.weekly.usage parsing.
	const secret = "sk-ollama-test";
	const calls = [];
	const ollama = await collectSubscription("ollama", credentials({ OLLAMA_API_KEY: secret }), {}, {
		now: () => now,
		fetch: async (url, init) => {
			calls.push({ url: String(url), init });
			return {
				ok: true,
				status: 200,
				json: async () => ({ limits: { session: { usage: 0.3 }, weekly: { usage: 0.08 } } })
			};
		}
	});
	assert.equal(ollama.status, "ok");
	assert.equal(ollama.mode, "subscription");
	assert.deepEqual(ollama.windows.map((window) => [window.kind, window.usedPercent, window.remainingPercent]), [
		["session", 30, 70],
		["weekly", 8, 92]
	]);
	assert.equal(calls[0].url, "https://ollama.com/api/usage");
	assert.equal(calls[0].init.headers.authorization, "Bearer " + secret);
	assert.equal(JSON.stringify(ollama).includes(secret), false, "API key must not cross the module interface");
	console.log("Ollama normal window parsing ok");
}

{
	// Ollama Cloud: 0 / 1 / negative / out-of-range / string ratios.
	const fetchFor = (session, weekly) => async () => ({
		ok: true,
		status: 200,
		json: async () => ({ limits: { session: { usage: session }, weekly: { usage: weekly } } })
	});
	const zero = await collectSubscription("ollama", credentials({ OLLAMA_API_KEY: "x" }), {}, { now: () => now, fetch: fetchFor(0, 0) });
	assert.deepEqual(zero.windows.map((window) => [window.kind, window.usedPercent, window.remainingPercent]), [
		["session", 0, 100],
		["weekly", 0, 100]
	]);
	const full = await collectSubscription("ollama", credentials({ OLLAMA_API_KEY: "x" }), {}, { now: () => now, fetch: fetchFor(1, 0.5) });
	assert.deepEqual(full.windows.map((window) => [window.kind, window.usedPercent, window.remainingPercent]), [
		["session", 100, 0],
		["weekly", 50, 50]
	]);
	// Negative clamps to 0; out-of-range (>1) clamps to a full bar instead of dropping.
	const clamped = await collectSubscription("ollama", credentials({ OLLAMA_API_KEY: "x" }), {}, { now: () => now, fetch: fetchFor(-0.2, 1.4) });
	assert.deepEqual(clamped.windows.map((window) => [window.kind, window.usedPercent, window.remainingPercent]), [
		["session", 0, 100],
		["weekly", 100, 0]
	]);
	const stringRatio = await collectSubscription("ollama", credentials({ OLLAMA_API_KEY: "x" }), {}, { now: () => now, fetch: fetchFor("0.25", "0.05") });
	assert.deepEqual(stringRatio.windows.map((window) => [window.kind, window.usedPercent]), [
		["session", 25],
		["weekly", 5]
	]);
	console.log("Ollama ratio edge cases ok");
}

{
	// Ollama Cloud: missing limits / non-object body -> invalid-response.
	const missing = await collectSubscription("ollama", credentials({ OLLAMA_API_KEY: "x" }), {}, {
		now: () => now,
		fetch: async () => ({ ok: true, status: 200, json: async () => ({}) })
	});
	assert.equal(missing.status, "invalid-response");
	assert.deepEqual(missing.windows, []);
	const nonObject = await collectSubscription("ollama", credentials({ OLLAMA_API_KEY: "x" }), {}, {
		now: () => now,
		fetch: async () => ({ ok: true, status: 200, json: async () => "not-an-object" })
	});
	assert.equal(nonObject.status, "invalid-response");
	assert.deepEqual(nonObject.windows, []);
	console.log("Ollama invalid-response classification ok");
}

{
	// Ollama Cloud: HTTP status mapping.
	for (const [httpStatus, providerStatus] of [[401, "unauthorized"], [403, "unauthorized"], [429, "rate-limited"], [500, "unavailable"], [503, "unavailable"]]) {
		const account = await collectSubscription("ollama", credentials({ OLLAMA_API_KEY: "x" }), {}, {
			now: () => now,
			fetch: async () => ({ ok: false, status: httpStatus, json: async () => ({}) })
		});
		assert.equal(account.status, providerStatus, "HTTP " + httpStatus + " should map to " + providerStatus);
	}
	console.log("Ollama HTTP status mapping ok");
}

{
	// Ollama Cloud: missing credential -> not-configured with the ref listed.
	const account = await collectSubscription("ollama", credentials({}), {}, {
		now: () => now,
		fetch: async () => { throw new Error("must not fetch without a credential"); }
	});
	assert.equal(account.status, "not-configured");
	assert.deepEqual(account.missingCredentials, [subscriptionCredentialRefs.ollamaApiKey]);
	console.log("Ollama missing credential is not-configured ok");
}

{
	// Ollama Cloud: real captured payload shape (2026-08-20 live response).
	// Guards against circular verification: the parser must handle the actual
	// upstream shape, not just hand-crafted JSON that mirrors the assumption.
	const realPayload = {
		activity: { cost: "0.00000", period: { type: "last_4_weeks", starting_at: "2026-07-27T00:00:00Z", ending_at: "2026-08-20T18:39:14.280986854Z" }, models: [] },
		limits: {
			session: { usage: 0.276, models: [{ name: "deepseek-v4-flash:0731", request_count: 670 }, { name: "web search", request_count: 1 }] },
			weekly: { usage: 0.078, models: [{ name: "deepseek-v4-flash:0731", request_count: 1158 }] }
		}
	};
	const real = await collectSubscription("ollama", credentials({ OLLAMA_API_KEY: "x" }), {}, {
		now: () => now,
		fetch: async () => ({ ok: true, status: 200, json: async () => realPayload })
	});
	assert.equal(real.status, "ok");
	assert.deepEqual(real.windows.map((window) => [window.kind, window.usedPercent, window.remainingPercent]), [
		["session", 27.6, 72.4],
		["weekly", 7.8, 92.2]
	]);
	console.log("Ollama real captured payload parses ok");
}

{
	// Ollama Cloud: custom usage base URL override is honored.
	const calls = [];
	const account = await collectSubscription("ollama", credentials({ OLLAMA_API_KEY: "x" }), { baseURL: "https://ollama.example.com" }, {
		now: () => now,
		fetch: async (url) => {
			calls.push(String(url));
			return { ok: true, status: 200, json: async () => ({ limits: { session: { usage: 0.1 }, weekly: { usage: 0.2 } } }) };
		}
	});
	assert.equal(account.status, "ok");
	assert.deepEqual(calls, ["https://ollama.example.com/api/usage"]);
	console.log("Ollama custom usage base URL ok");
}

console.log("SUBSCRIPTION TESTS PASSED");
