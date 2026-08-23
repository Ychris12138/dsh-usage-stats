import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	accountProvenance,
	createAccountService,
	isPrivateAddress,
	queryAccount,
	refreshPolicy,
	resolveAccountSpec,
	selectResolvedAddress,
	selectResolvedAddresses,
	validateAccountConfig,
	withHealthAge
} from "../lib/accounts.js";

function credentials(values) {
	return {
		resolve: async (ref) => Object.hasOwn(values, ref) ? { value: values[ref] } : void 0
	};
}

function jsonResponse(value, status = 200, headers = {}) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json", ...headers }
	});
}

/** Build a fake provider-status error the way lib/accounts.js statusError() does. */
function statusErrorFromTest(status, message) {
	const error = new Error(message);
	error.providerStatus = status;
	return error;
}

const now = Date.parse("2026-08-15T00:00:00Z");
const relay = {
	id: "relay-a",
	displayName: "Relay A",
	apiKeyEnv: "RELAY_A_KEY",
	baseURL: "https://relay.example.com/v1"
};

const passion = {
	id: "passion",
	displayName: "Passion",
	apiKeyEnv: "PASSION_API_KEY",
	baseURL: "https://api.passionapi.com"
};

const deepseek = {
	id: "deepseek-official",
	displayName: "DeepSeek",
	apiKeyEnv: "DEEPSEEK_API_KEY",
	baseURL: "https://api.deepseek.com"
};

{
	const provenanceCases = new Map([
		["deepseek-balance", "official"],
		["openrouter-balance", "official"],
		["moonshot-balance", "official"],
		["zai-balance", "official"],
		["opencode-go", "official"],
		["zai-token-plan", "official"],
		["kimi-token-plan", "official"],
		["minimax-token-plan", "official"],
		["ollama", "official"],
		["new-api", "provider"],
		["sub2api", "provider"],
		["sub2api-auth", "provider"],
		["general", "configured"],
		["declarative", "configured"],
		[null, "unknown"]
	]);
	for (const [adapter, expected] of provenanceCases) assert.equal(accountProvenance({ adapter }), expected, `${adapter} provenance`);
	assert.equal(accountProvenance(resolveAccountSpec(deepseek, validateAccountConfig())), "official");
	assert.equal(accountProvenance({ ...resolveAccountSpec(relay, validateAccountConfig()), provenanceHint: "experimental" }), "experimental");
	console.log("account provenance vocabulary ok");
}

{
	const active = refreshPolicy({ activity: "active", status: "ok", rateLimitFailures: 0, lastAttemptAt: now }, now);
	const detail = refreshPolicy({ activity: "detail", status: "ok", rateLimitFailures: 0, lastAttemptAt: now }, now);
	const background = refreshPolicy({ activity: "background", status: "ok", rateLimitFailures: 0, lastAttemptAt: now }, now);
	assert.ok(active.nextRefreshAt < background.nextRefreshAt, "active providers must refresh sooner than background providers");
	assert.ok(detail.nextRefreshAt < background.nextRefreshAt, "detail providers must refresh sooner than background providers");
	const first429 = refreshPolicy({ activity: "active", status: "rate-limited", rateLimitFailures: 1, lastAttemptAt: now }, now);
	const second429 = refreshPolicy({ activity: "active", status: "rate-limited", rateLimitFailures: 2, lastAttemptAt: now }, now);
	const failedRetry = refreshPolicy({ activity: "active", status: "unavailable", rateLimitFailures: 2, lastAttemptAt: now }, now);
	const bounded429 = refreshPolicy({ activity: "active", status: "rate-limited", rateLimitFailures: 99, lastAttemptAt: now }, now);
	assert.ok(first429.nextRefreshAt > active.nextRefreshAt, "429 must override the fast activity interval");
	assert.ok(second429.nextRefreshAt > first429.nextRefreshAt, "consecutive 429 responses must increase backoff");
	assert.equal(failedRetry.nextRefreshAt, second429.nextRefreshAt, "a non-success retry must preserve the existing rate-limit backoff");
	assert.ok(bounded429.nextRefreshAt - now <= 3600000, "429 backoff must remain bounded");
	assert.equal(refreshPolicy({ activity: "background", status: "pending", rateLimitFailures: 0, lastAttemptAt: null }, now).nextRefreshAt, now);
	console.log("adaptive refresh policy and bounded 429 backoff ok");
}

{
	const stored = { status: "ok", lastSuccessAt: now, fetchedAt: now };
	const first = withHealthAge(stored, now + 1000);
	const second = withHealthAge(stored, now + 9000);
	assert.equal(first.ageMs, 1000);
	assert.equal(second.ageMs, 9000);
	assert.equal(Object.hasOwn(stored, "ageMs"), false, "ageMs must never become a cached dead value");
	assert.equal(withHealthAge({ status: "unavailable", lastSuccessAt: null }, now).ageMs, null);
	console.log("health age is derived at read time ok");
}

assert.equal(isPrivateAddress("127.0.0.1"), true);
assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true);
assert.equal(isPrivateAddress("::ffff:7f00:1"), true);
assert.equal(isPrivateAddress("fc00::1"), true);
assert.equal(isPrivateAddress("fe80::1"), true);
assert.equal(isPrivateAddress("fec0::1"), true);
assert.equal(isPrivateAddress("100::1"), true);
assert.equal(isPrivateAddress("2001:2::1"), true);
assert.equal(isPrivateAddress("2002:7f00:1::"), true);
assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
// RFC 2544 benchmarking (198.18.0.0/15) stays non-public; Clash/Mihomo
// fake-IP answers are only accepted later through the HTTPS-hostname rule.
assert.equal(isPrivateAddress("198.18.0.50"), true);
console.log("IPv4/IPv6 private-address classification ok");

{
	const spec = resolveAccountSpec(passion, validateAccountConfig());
	assert.equal(spec.adapter, "sub2api");
	assert.equal(spec.mode, "balance");
	console.log("Passion Sub2API auto-detection ok");
}

{
	const config = validateAccountConfig({ monitors: {
		"relay-a": { adapter: "new-api" }
	} });
	const spec = resolveAccountSpec(relay, config);
	assert.equal(spec.adapter, "new-api");
	assert.equal(spec.mode, "balance");
	assert.equal(spec.apiKeyRef, "RELAY_A_KEY");
	assert.equal(spec.baseURL, relay.baseURL);
	console.log("explicit New API binding ok");
}

{
	const calls = [];
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "new-api" }
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		fetch: async (url, init) => {
			calls.push({ url: String(url), init });
			if (String(url).endsWith("/api/status")) return jsonResponse({ data: { quota_per_unit: 500000 } });
			return jsonResponse({ code: true, data: {
				total_granted: 1500000,
				total_used: 500000,
				total_available: 1000000,
				unlimited_quota: false,
				expires_at: 1798761600
			} });
		}
	});
	assert.equal(account.status, "ok");
	assert.deepEqual(account.balance, {
		remaining: 2,
		used: 1,
		total: 3,
		currency: "USD",
		unlimited: false,
		expiresAt: "2027-01-01T00:00:00.000Z"
	});
	assert.deepEqual(account.alert, { level: "normal", metric: "remaining-percent", value: 66.7 });
	assert.equal(calls[0].init.headers.authorization, "Bearer sk-relay");
	assert.equal(JSON.stringify(account).includes("sk-relay"), false);
	console.log("New API token-scoped normalization ok");
}

{
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "new-api" }
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		fetch: async (url) => String(url).endsWith("/api/status")
			? jsonResponse({ data: { quota_per_unit: 500000 } })
			: jsonResponse({ code: true, data: { total_granted: 1, total_used: 0, total_available: 1, expires_at: 0 } })
	});
	assert.equal(account.balance.expiresAt, null, "expires_at=0 means no expiry, not the Unix epoch");
	console.log("New API zero expiry normalization ok");
}

{
	const spec = resolveAccountSpec(deepseek, validateAccountConfig());
	for (const [httpStatus, providerStatus] of [[401, "unauthorized"], [403, "unauthorized"], [429, "rate-limited"], [503, "unavailable"]]) {
		const account = await queryAccount(spec, credentials({ DEEPSEEK_API_KEY: "sk-test" }), {
			now: () => now,
			fetch: async () => jsonResponse({}, httpStatus)
		});
		assert.equal(account.status, providerStatus, `HTTP ${httpStatus} should map to ${providerStatus}`);
	}
	const malformed = await queryAccount(spec, credentials({ DEEPSEEK_API_KEY: "sk-test" }), {
		now: () => now,
		fetch: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad JSON"); } })
	});
	assert.equal(malformed.status, "invalid-response");
	console.log("built-in balance account status classification ok");
}

{
	const spec = resolveAccountSpec(deepseek, validateAccountConfig());
	const account = await queryAccount(spec, credentials({ DEEPSEEK_API_KEY: "sk-test" }), {
		now: () => now,
		fetch: async () => jsonResponse({
			is_available: false,
			balance_infos: [{ currency: "CNY", total_balance: "12.50", granted_balance: "0", topped_up_balance: "12.50" }]
		})
	});
	assert.equal(account.status, "unavailable");
	assert.equal(account.balance.available, false);
	assert.equal(account.balance.remaining, 12.5);
	let clock = now;
	let available = true;
	const service = createAccountService({
		credentials: credentials({ DEEPSEEK_API_KEY: "sk-test" }),
		getProviders: async () => [deepseek],
		config: validateAccountConfig(),
		deps: {
			includeLegacyProviders: false,
			now: () => clock,
			fetch: async () => jsonResponse({
				is_available: available,
				balance_infos: [{ currency: "CNY", total_balance: available ? "20.00" : "12.50", granted_balance: "0", topped_up_balance: available ? "20.00" : "12.50" }]
			})
		}
	});
	const healthy = await service.get("deepseek-official");
	assert.equal(healthy.status, "ok");
	assert.equal(healthy.lastSuccessAt, now);
	available = false;
	clock += 1000;
	const observed = await service.get("deepseek-official", { force: true });
	assert.equal(observed.status, "unavailable");
	assert.equal(observed.stale, false, "a valid unavailable response must replace rather than retain the previous balance");
	assert.equal(observed.balance.remaining, 12.5);
	assert.equal(observed.lastAttemptAt, clock);
	assert.equal(observed.lastSuccessAt, clock, "a valid DeepSeek response must advance health success even when the account is unavailable");
	assert.equal(observed.ageMs, 0);
	console.log("DeepSeek provider-reported unavailable state ok");
}

{
	const provider = { id: "openrouter", displayName: "OpenRouter", apiKeyEnv: "OPENROUTER_API_KEY", baseURL: "https://openrouter.ai/api/v1" };
	const spec = resolveAccountSpec(provider, validateAccountConfig());
	assert.equal(spec.apiKeyRef, "OPENROUTER_MANAGEMENT_KEY");
	const inferenceOnly = await queryAccount(spec, credentials({ OPENROUTER_API_KEY: "inference-key" }), {
		now: () => now,
		fetch: async () => { throw new Error("must not use the inference key"); }
	});
	assert.equal(inferenceOnly.status, "not-configured");
	assert.deepEqual(inferenceOnly.missingCredentials, ["OPENROUTER_MANAGEMENT_KEY"]);
	const unconfiguredService = createAccountService({
		credentials: credentials({ OPENROUTER_API_KEY: "inference-key" }),
		getProviders: async () => [provider],
		config: validateAccountConfig(),
		deps: { includeLegacyProviders: false, now: () => now, fetch: async () => { throw new Error("must not request upstream"); } }
	});
	const unconfigured = await unconfiguredService.get("openrouter");
	assert.equal(unconfigured.lastAttemptAt, null, "missing management credentials must not count as a provider attempt");
	assert.equal(unconfigured.lastSuccessAt, null);
	const account = await queryAccount(spec, credentials({ OPENROUTER_MANAGEMENT_KEY: "management-key" }), {
		now: () => now,
		fetch: async (_url, init) => {
			assert.equal(init.headers.authorization, "Bearer management-key");
			return jsonResponse({ data: { total_credits: 25.75, total_usage: 25.75 } });
		}
	});
	assert.equal(account.status, "ok", "a valid zero balance is not a transport/account availability failure");
	assert.equal(account.balance.remaining, 0);
	assert.equal(account.balance.used, 25.75);
	assert.equal(account.balance.total, 25.75);
	console.log("OpenRouter management credential and zero balance contract ok");
}

{
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "general", warning: { warnBelow: 5, criticalBelow: 1 } }
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		fetch: async (url, init) => {
			assert.equal(String(url), "https://relay.example.com/user/balance");
			assert.equal(init.headers.authorization, "Bearer sk-relay");
			return jsonResponse({ balance: 4, currency: "USD", is_active: true });
		}
	});
	assert.equal(account.status, "ok");
	assert.equal(account.balance.remaining, 4);
	assert.deepEqual(account.alert, { level: "warning", metric: "balance", value: 4, threshold: 5 });
	console.log("general balance template ok");
}

{
	const spec = resolveAccountSpec(passion, validateAccountConfig());
	const account = await queryAccount(spec, credentials({ PASSION_API_KEY: "sk-passion" }), {
		now: () => now,
		fetch: async (url, init) => {
			assert.equal(String(url), "https://api.passionapi.com/v1/usage");
			assert.equal(init.headers.authorization, "Bearer sk-passion");
			return jsonResponse({ mode: "unrestricted", isValid: true, planName: "Wallet", remaining: 28.5, unit: "USD", balance: 28.5 });
		}
	});
	assert.equal(account.mode, "balance");
	assert.equal(account.plan, "Wallet");
	assert.deepEqual(account.balance, { remaining: 28.5, currency: "USD", unlimited: false, expiresAt: null });
	console.log("Sub2API wallet balance normalization ok");
}

{
	const spec = resolveAccountSpec({ ...relay, id: "sub2" }, validateAccountConfig({ monitors: {
		sub2: { adapter: "sub2api" }
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-sub2" }), {
		now: () => now,
		fetch: async () => jsonResponse({
			mode: "quota_limited",
			isValid: true,
			status: "active",
			planName: "Quota Plan",
			quota: { limit: 100, used: 25, remaining: 75, unit: "USD" },
			rate_limits: [{ window: "5h", limit: 20, used: 18, remaining: 2, reset_at: "2026-08-15T05:00:00Z" }]
		})
	});
	assert.equal(account.mode, "subscription");
	assert.equal(account.plan, "Quota Plan");
	assert.deepEqual(account.windows.map((window) => [window.kind, window.usedPercent, window.remainingPercent]), [
		["quota", 25, 75],
		["session", 90, 10]
	]);
	assert.deepEqual(account.alert, { level: "critical", metric: "remaining-percent", value: 10 });
	console.log("Sub2API quota-plan normalization ok");
}

{
	const spec = resolveAccountSpec({ ...relay, id: "sub2" }, validateAccountConfig({ monitors: {
		sub2: { adapter: "sub2api" }
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-sub2" }), {
		now: () => now,
		fetch: async () => jsonResponse({
			mode: "unrestricted",
			isValid: true,
			planName: "Pro Plan",
			remaining: 15,
			subscription: {
				daily_usage_usd: 2,
				daily_limit_usd: 5,
				weekly_usage_usd: 10,
				weekly_limit_usd: 20,
				monthly_usage_usd: 60,
				monthly_limit_usd: 100
			}
		})
	});
	assert.equal(account.mode, "subscription");
	assert.deepEqual(account.windows.map((window) => [window.kind, window.usedPercent, window.remainingPercent]), [
		["daily", 40, 60],
		["weekly", 50, 50],
		["monthly", 60, 40]
	]);
	assert.deepEqual(account.alert, { level: "normal", metric: "remaining-percent", value: 40 });
	console.log("Sub2API subscription-window normalization ok");
}

{
	const calls = [];
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": {
			adapter: "new-api",
			fallbackCredentialRef: "RELAY_A_PAT"
		}
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "inference-key", RELAY_A_PAT: "management-pat" }), {
		now: () => now,
		fetch: async (url, init) => {
			calls.push({ url: String(url), authorization: init.headers.authorization });
			if (String(url).endsWith("/api/usage/token/")) return jsonResponse({}, 404);
			if (String(url).endsWith("/api/status")) return jsonResponse({ data: { quota_per_unit: 1000 } });
			return jsonResponse({ success: true, data: { group: "pro", quota: 8000, used_quota: 2000 } });
		}
	});
	assert.equal(account.status, "ok");
	assert.equal(account.plan, "pro");
	assert.deepEqual(account.balance, { remaining: 8, used: 2, total: 10, currency: "USD", unlimited: false, expiresAt: null });
	assert.ok(calls.some((call) => call.url.endsWith("/api/user/self") && call.authorization === "Bearer management-pat"));
	console.log("New API explicit management fallback ok");
}

{
	const custom = {
		monitors: {
			"relay-a": {
				adapter: "declarative",
				mode: "balance",
				request: { path: "/account/balance", auth: { type: "bearer", credentialRef: "CUSTOM_KEY" } },
				extract: {
					root: "/data",
					remaining: "/available",
					used: "/used",
					total: "/total",
					currency: "/currency",
					divisor: 100
				},
				warning: { warnBelow: 5, criticalBelow: 1 }
			}
		}
	};
	const spec = resolveAccountSpec(relay, validateAccountConfig(custom));
	const account = await queryAccount(spec, credentials({ CUSTOM_KEY: "custom-secret" }), {
		now: () => now,
		fetch: async (url, init) => {
			assert.equal(String(url), "https://relay.example.com/account/balance");
			assert.equal(init.redirect, "manual");
			assert.equal(init.headers.authorization, "Bearer custom-secret");
			return jsonResponse({ data: { available: 450, used: 550, total: 1000, currency: "USD" } });
		}
	});
	assert.deepEqual(account.balance, { remaining: 4.5, used: 5.5, total: 10, currency: "USD", unlimited: false, expiresAt: null });
	assert.deepEqual(account.alert, { level: "warning", metric: "balance", value: 4.5, threshold: 5 });
	console.log("declarative balance mapping and warning threshold ok");
}

{
	assert.throws(() => validateAccountConfig({ monitors: {
		"relay-a": {
			adapter: "declarative",
			mode: "balance",
			request: { path: "https://evil.example/steal" },
			extract: { remaining: "/balance" }
		}
	} }), /relative path/i);
	console.log("declarative absolute URL rejection ok");
}

{
	for (const header of ["x-api-key", "api-key"]) {
		assert.throws(() => validateAccountConfig({ monitors: {
			"relay-a": {
				adapter: "declarative",
				mode: "balance",
				request: { path: "/balance", headers: { [header]: "literal-secret" } },
				extract: { remaining: "/balance" }
			}
		} }), /cannot override/i);
	}
	assert.throws(() => validateAccountConfig({ monitors: {
		"relay-a": { adapter: "new-api", usageBaseURL: "https://user:password@relay.example.com" }
	} }), /must not contain credentials/i);
	console.log("literal auth header and URL credential rejection ok");
}

{
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": {
			adapter: "declarative",
			mode: "subscription",
			request: { path: "/quota", auth: { type: "x-api-key", credentialRef: "CUSTOM_KEY" } },
			extract: {
				root: "/data",
				plan: "/plan",
				items: "/windows",
				kind: "/kind",
				remainingPercent: "/remaining",
				resetsAt: "/reset"
			}
		}
	} }));
	const account = await queryAccount(spec, credentials({ CUSTOM_KEY: "secret" }), {
		now: () => now,
		fetch: async (_url, init) => {
			assert.equal(init.headers["x-api-key"], "secret");
			return jsonResponse({ data: { plan: "Team", windows: [
				{ kind: "session", remaining: 80, reset: "2026-08-15T05:00:00Z" },
				{ kind: "weekly", remaining: 20 }
			] } });
		}
	});
	assert.equal(account.mode, "subscription");
	assert.equal(account.plan, "Team");
	assert.deepEqual(account.windows.map((window) => [window.kind, window.usedPercent, window.remainingPercent]), [
		["session", 20, 80],
		["weekly", 80, 20]
	]);
	assert.deepEqual(account.alert, { level: "warning", metric: "remaining-percent", value: 20 });
	console.log("declarative subscription mapping ok");
}

{
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": {
			adapter: "declarative",
			mode: "balance",
			usageBaseURL: "https://usage.other.example",
			request: { path: "/balance" },
			extract: { remaining: "/balance" }
		}
	} }));
	const account = await queryAccount(spec, credentials({}), { now: () => now, fetch: async () => { throw new Error("must not fetch"); } });
	assert.equal(account.status, "blocked", "cross-origin policy rejection must surface as blocked");
	console.log("declarative cross-origin default deny ok");
}

{
	const localProvider = { ...relay, baseURL: "http://127.0.0.1:8787/v1" };
	const spec = resolveAccountSpec(localProvider, validateAccountConfig({ monitors: {
		"relay-a": {
			adapter: "declarative",
			mode: "balance",
			usageBaseURL: "http://127.0.0.1:8787",
			allowInsecure: true,
			request: { path: "/balance" },
			extract: { remaining: "/balance" }
		}
	} }));
	const account = await queryAccount(spec, credentials({}), { now: () => now, fetch: async () => { throw new Error("must not fetch"); } });
	assert.equal(account.status, "blocked", "private-network policy rejection must surface as blocked, not unsupported");
	console.log("declarative private-network default deny ok");
}

{
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": {
			adapter: "declarative",
			mode: "balance",
			request: { path: "/balance" },
			extract: { remaining: "/balance" }
		}
	} }));
	const account = await queryAccount(spec, credentials({}), {
		now: () => now,
		fetch: async () => jsonResponse({ balance: 1 }, 200, { "content-length": String(1024 * 1024 + 1) })
	});
	assert.equal(account.status, "invalid-response");
	assert.equal(account.reason, "upstream-too-large");
	console.log("declarative response-size limit ok");
}

{
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "new-api" }
	} }));
	const noFallback = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		fetch: async () => jsonResponse({}, 404)
	});
	assert.equal(noFallback.status, "unsupported");
	assert.equal(noFallback.balance, null);
	console.log("New API refuses implicit credential fallback ok");
}

{
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "new-api" }
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		fetch: async (url) => String(url).endsWith("/api/status")
			? jsonResponse({}, 503)
			: jsonResponse({ code: true, data: { total_granted: 10, total_used: 2, total_available: 8 } })
	});
	assert.equal(account.status, "unavailable", "status transport failures must not use the historical quota unit");
	assert.equal(account.balance, null);
	console.log("New API status failures do not silently change quota units");
}

{
	// sub2api-auth: reuse the provider's own API key (already configured in the
	// model) against GET /user/balance — the CC Switch General template.
	const calls = [];
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "sub2api-auth" }
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		fetch: async (url, init) => {
			calls.push({ url: String(url), authorization: init?.headers?.authorization });
			if (String(url).includes("/api/v1/usage/stats")) {
				return jsonResponse({ code: 0, message: "ok", data: { total_actual_cost: 2.5, total_input_tokens: 100, total_output_tokens: 50 } });
			}
			assert.equal(String(url).endsWith("/user/balance"), true);
			assert.equal(init.headers.authorization, "Bearer sk-relay");
			return jsonResponse({ balance: 12.5, unit: "USD", planName: "Relay A" });
		}
	});
	assert.equal(account.status, "ok");
	assert.equal(account.mode, "balance");
	assert.equal(account.plan, "Relay A");
	assert.deepEqual(account.balance, { remaining: 12.5, used: 2.5, currency: "USD", unlimited: false, expiresAt: null });
	assert.equal(JSON.stringify(account).includes("sk-relay"), false, "provider key must never leak into the snapshot");
	console.log("sub2api-auth reuses provider API key against /user/balance ok");
}

{
	// sub2api-auth: a numeric-string balance and missing currency default to USD.
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "sub2api-auth" }
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		fetch: async (url) => {
			if (String(url).includes("/api/v1/usage/stats")) return jsonResponse({ code: 0, message: "ok", data: {} });
			assert.equal(String(url).endsWith("/user/balance"), true);
			return jsonResponse({ balance: "7.25" });
		}
	});
	assert.equal(account.status, "ok");
	assert.equal(account.balance.remaining, 7.25);
	assert.equal(account.balance.currency, "USD");
	console.log("sub2api-auth numeric-string balance and default currency ok");
}

{
	// sub2api-auth: missing provider API key is not-configured (never a blind request).
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "sub2api-auth" }
	} }));
	const account = await queryAccount(spec, credentials({}), { now: () => now, fetch: async () => { throw new Error("must not fetch without a provider API key"); } });
	assert.equal(account.status, "not-configured");
	assert.equal(account.balance, null);
	console.log("sub2api-auth missing provider key is not-configured ok");
}

{
	// sub2api-auth: when /user/balance returns no recognizable numeric balance,
	// the flow falls back to /v1/usage (same model API key).
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "sub2api-auth" }
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		fetch: async (url) => {
			if (String(url).endsWith("/user/balance")) return jsonResponse({});
			if (String(url).endsWith("/v1/usage")) return jsonResponse({ isValid: true, balance: 6.6, unit: "USD", planName: "Panel" });
			if (String(url).includes("/api/v1/usage/stats")) return jsonResponse({ code: 0, message: "ok", data: {} });
			throw new Error(`unexpected url: ${url}`);
		}
	});
	assert.equal(account.status, "ok");
	assert.equal(account.mode, "balance");
	assert.equal(account.balance.remaining, 6.6);
	assert.equal(account.plan, "Panel");
	console.log("sub2api-auth /user/balance empty falls back to /v1/usage ok");
}

{
	// sub2api-auth: an SPA HTML response for /user/balance (like real panels'
	// catch-all) is skipped and the panel's /v1/usage is used instead.
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "sub2api-auth" }
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		fetch: async (url) => {
			if (String(url).endsWith("/user/balance")) return new Response("<!doctype html><title>SPA</title>", {
				status: 200,
				headers: { "content-type": "text/html" }
			});
			if (String(url).endsWith("/v1/usage")) return jsonResponse({ mode: "unrestricted", isValid: true, remaining: 8.25, unit: "USD", balance: 8.25 });
			if (String(url).includes("/api/v1/usage/stats")) return jsonResponse({ code: 0, message: "ok", data: {} });
			throw new Error(`unexpected url: ${url}`);
		}
	});
	assert.equal(account.status, "ok");
	assert.equal(account.balance.remaining, 8.25);
	console.log("sub2api-auth HTML /user/balance falls back to /v1/usage ok");
}

{
	// sub2api-auth: when both endpoints fail to yield a balance, the snapshot
	// stays invalid-response and surfaces the /user/balance top-level keys.
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "sub2api-auth" }
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		fetch: async (url) => {
			if (String(url).endsWith("/user/balance")) return jsonResponse({ message: "nope" });
			if (String(url).endsWith("/v1/usage")) return jsonResponse({});
			if (String(url).includes("/api/v1/usage/stats")) return jsonResponse({ code: 0, message: "ok", data: {} });
			throw new Error(`unexpected url: ${url}`);
		}
	});
	assert.equal(account.status, "invalid-response");
	assert.equal(account.balance, null);
	assert.equal(account.reason, "sub2api-balance-shape-unrecognized", "reason must be a fixed enum, never upstream-controlled keys");
	console.log("sub2api-auth both endpoints missing balance keeps invalid-response ok");
}

{
	// sub2api-auth: a nested { code, data: { balance } } envelope is recognized.
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "sub2api-auth" }
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		fetch: async (url) => {
			if (String(url).endsWith("/user/balance")) return jsonResponse({ code: 0, message: "ok", data: { balance: 4.2, unit: "USD" } });
			if (String(url).endsWith("/v1/usage")) throw new Error("must not fall back when /user/balance already yields a balance");
			if (String(url).includes("/api/v1/usage/stats")) return jsonResponse({ code: 0, message: "ok", data: {} });
			throw new Error(`unexpected url: ${url}`);
		}
	});
	assert.equal(account.status, "ok");
	assert.equal(account.balance.remaining, 4.2);
	console.log("sub2api-auth nested data.balance envelope ok");
}

{
	// Auto-detection hit: a relay provider with an API key and a public-settings
	// fingerprint is auto-selected as sub2api-auth and queried with its own key.
	const probed = [];
	const account = await queryAccount(resolveAccountSpec(relay, validateAccountConfig()), credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		fetch: async (url, init) => {
			if (String(url).endsWith("/api/v1/settings/public")) {
				probed.push(String(url));
				return jsonResponse({ code: 0, message: "ok", data: { affiliate_enabled: true } });
			}
			if (String(url).includes("/api/v1/usage/stats")) return jsonResponse({ code: 0, message: "ok", data: {} });
			assert.ok(String(url).endsWith("/user/balance"));
			assert.equal(init.headers.authorization, "Bearer sk-relay");
			return jsonResponse({ balance: 3.5, unit: "USD" });
		},
		sub2apiDetection: new Map()
	});
	assert.equal(account.status, "ok");
	assert.equal(account.mode, "balance");
	assert.equal(account.adapter, "sub2api-auth");
	assert.equal(account.balance.remaining, 3.5);
	assert.ok(probed.length === 1, "panel probe must run");
	console.log("sub2api-auth auto-detection fingerprint hit ok");
}

{
	// Auto-detection miss: the probe shows it is not a Sub2API panel → unsupported,
	// no balance query is attempted with the provider key.
	const account = await queryAccount(resolveAccountSpec(relay, validateAccountConfig()), credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		fetch: async (url) => {
			if (String(url).endsWith("/api/v1/settings/public")) {
				return jsonResponse({ code: 0, message: "ok", data: { affiliate_enabled: "yes" } });
			}
			throw new Error("must not query non-panel endpoints when the probe misses");
		},
		sub2apiDetection: new Map()
	});
	assert.equal(account.status, "unsupported");
	assert.equal(account.balance, null);
	console.log("sub2api-auth auto-detection fingerprint miss ok");
}

{
	// Auto-detection is gated on a provider API key: an unkeyed relay is left
	// unsupported and never probed.
	let fetched = false;
	const account = await queryAccount(resolveAccountSpec(relay, validateAccountConfig()), credentials({}), {
		now: () => now,
		fetch: async () => { fetched = true; throw new Error("must not probe without a provider API key"); },
		sub2apiDetection: new Map()
	});
	assert.equal(account.status, "unsupported");
	assert.equal(fetched, false, "no request must fire without a provider API key");
	console.log("sub2api-auth auto-detection requires a provider API key ok");
}

{
	// An explicit adapter always wins over auto-detection: a provider bound to
	// `new-api` is never probed or overridden even with a provider API key.
	let fetched = false;
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "new-api" }
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		fetch: async (url) => {
			if (String(url).endsWith("/api/v1/settings/public")) { fetched = true; throw new Error("explicit adapter must not be probed"); }
			if (String(url).endsWith("/api/status")) return jsonResponse({ data: { quota_per_unit: 500000 } });
			return jsonResponse({ code: true, data: { total_granted: 10, total_used: 2, total_available: 8 } });
		},
		sub2apiDetection: new Map()
	});
	assert.equal(account.status, "ok");
	assert.equal(account.adapter, "new-api");
	assert.equal(fetched, false, "explicit adapter must bypass the panel probe");
	console.log("sub2api-auth auto-detection never overrides explicit adapter ok");
}

{
	// P1 regression: upstream-controlled JSON property names must never appear
	// in the normalized snapshot's reason. A hostile panel echoing sensitive
	// material as an object key (e.g. an API key) must stay out of safeReason.
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "sub2api-auth" }
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		fetch: async (url) => {
			if (String(url).endsWith("/user/balance")) return jsonResponse({ "sk-super-secret-api-key": 1 });
			if (String(url).endsWith("/v1/usage")) return jsonResponse({});
			if (String(url).includes("/api/v1/usage/stats")) return jsonResponse({ code: 0, message: "ok", data: {} });
			throw new Error(`unexpected url: ${url}`);
		}
	});
	assert.equal(account.status, "invalid-response");
	assert.equal(account.reason, "sub2api-balance-shape-unrecognized", "reason must be a fixed enum");
	assert.equal(JSON.stringify(account).includes("sk-super-secret-api-key"), false, "upstream-controlled key must never reach the snapshot");
	console.log("sub2api-auth upstream key names never leak into snapshot ok");
}

{
	// P1 regression: the detection cache must live on the service, so two
	// refresh/query cycles for the same configKey probe the panel only once.
	let probes = 0;
	const service = createAccountService({
		credentials: credentials({ RELAY_A_KEY: "sk-relay" }),
		getProviders: async () => [relay],
		config: { monitors: {} },
		deps: {
			now: () => now,
			fetch: async (url, init) => {
				if (String(url).endsWith("/api/v1/settings/public")) {
					probes += 1;
					return jsonResponse({ code: 0, message: "ok", data: { affiliate_enabled: true } });
				}
				if (String(url).includes("/api/v1/usage/stats")) return jsonResponse({ code: 0, message: "ok", data: {} });
				if (String(url).endsWith("/user/balance")) return jsonResponse({ balance: 1.5, unit: "USD" });
				throw new Error(`unexpected url: ${url}`);
			}
		}
	});
	const first = await service.get("relay-a", { force: true });
	assert.equal(first.adapter, "sub2api-auth");
	assert.equal(probes, 1, "first cycle must probe exactly once");
	const second = await service.get("relay-a", { force: true });
	assert.equal(second.adapter, "sub2api-auth");
	assert.equal(probes, 1, "second cycle must reuse the persisted detection cache");
	console.log("sub2api-auth detection cache persists across service refreshes ok");
}

{
	// Reviewer suggestion: security-policy/TLS failures on /user/balance must
	// not be silently swallowed into the /v1/usage fallback — the real error
	// surfaces instead of being masked.
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "sub2api-auth" }
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		fetch: async (url) => {
			if (String(url).endsWith("/user/balance")) {
				throw statusErrorFromTest("blocked", "account monitor requires HTTPS");
			}
			throw new Error(`must not fall back after a security-policy failure: ${url}`);
		}
	});
	assert.equal(account.status, "blocked", "security-policy failures must surface, not fall back");
	console.log("sub2api-auth security-policy failure not swallowed ok");
}

{
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "general" }
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		lookup: async () => [{ address: "127.0.0.1", family: 4 }]
	});
	assert.equal(account.status, "blocked", "DNS answers pointing at private networks must surface as blocked, not unsupported");
	console.log("DNS-to-private-network rejection ok");
}

{
	const httpsTarget = new URL("https://api.deepseek.com/user/balance");
	const fakeIpv4 = { address: "198.18.0.50", family: 4 };
	const fakeUla = { address: "fdfe:dcba:9876::1c", family: 6 };
	const publicIpv4 = { address: "1.1.1.1", family: 4 };

	assert.deepEqual(
		selectResolvedAddress(httpsTarget, [fakeUla, fakeIpv4]),
		fakeIpv4,
		"HTTPS hostname should accept the IPv4 benchmarking fake-IP when all normal answers are blocked"
	);
	assert.deepEqual(
		selectResolvedAddress(httpsTarget, [fakeIpv4, publicIpv4]),
		publicIpv4,
		"a real public address must be preferred over a proxy fake-IP"
	);
	assert.equal(
		selectResolvedAddress(httpsTarget, [
			{ address: "127.0.0.1", family: 4 },
			{ address: "10.0.0.1", family: 4 },
			fakeUla
		]),
		null,
		"ordinary private and ULA answers must remain blocked"
	);
	assert.equal(
		selectResolvedAddress(new URL("http://api.deepseek.com/user/balance"), [fakeIpv4]),
		null,
		"the fake-IP exception must not weaken insecure HTTP targets"
	);
	assert.equal(
		selectResolvedAddress(httpsTarget, []),
		null,
		"an empty answer set must select nothing"
	);
	console.log("resolved-address selection policy ok");
}

{
	const literalProvider = {
		...relay,
		baseURL: "https://198.18.0.50/v1"
	};
	const spec = resolveAccountSpec(literalProvider, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "general" }
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		lookup: async () => { throw new Error("literal targets must be blocked before DNS lookup"); }
	});
	assert.equal(account.status, "blocked", "literal 198.18/15 targets must surface as blocked without allowPrivateNetwork");
	console.log("literal benchmarking-range target rejection ok");
}

{
	const { createServer } = await import("node:http");
	const server = createServer((req, res) => {
		assert.equal(req.url, "/user/balance");
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ balance: 9, currency: "USD" }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	try {
		const localProvider = { ...relay, baseURL: `http://127.0.0.1:${port}/v1` };
		const spec = resolveAccountSpec(localProvider, validateAccountConfig({ monitors: {
			"relay-a": {
				adapter: "general",
				allowPrivateNetwork: true,
				allowInsecure: true
			}
		} }));
		const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), { now: () => now });
		assert.equal(account.status, "ok", "explicit allowPrivateNetwork must preserve private network access");
		assert.equal(account.balance.remaining, 9);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
	console.log("allowPrivateNetwork opt-in preserves private network access ok");
}

{
	// No adapter: the provider genuinely has no balance/subscription interface.
	const bare = resolveAccountSpec(relay, validateAccountConfig());
	assert.equal(bare.adapter, null);
	const account = await queryAccount(bare, credentials({}), { now: () => now, fetch: async () => { throw new Error("must not fetch"); } });
	assert.equal(account.status, "unsupported", "a provider without any adapter must stay unsupported");
	console.log("missing adapter stays unsupported ok");
}

{
	// HTTP 404/405: the upstream itself has no such account API.
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "general" }
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		fetch: async () => jsonResponse({}, 404)
	});
	assert.equal(account.status, "unsupported", "HTTP 404 must stay unsupported, not blocked");
	console.log("upstream 404 stays unsupported ok");
}

{
	// HTTPS policy: local security policy rejects the plain-HTTP target before
	// any DNS resolution or connection attempt.
	const insecureProvider = { ...relay, baseURL: "http://relay.example.com/v1" };
	const spec = resolveAccountSpec(insecureProvider, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "general" }
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		lookup: async () => { throw new Error("must not resolve before the HTTPS policy check"); }
	});
	assert.equal(account.status, "blocked", "non-HTTPS targets must surface as blocked without allowInsecure");
	console.log("non-HTTPS policy rejection ok");
}

{
	let calls = 0;
	const service = createAccountService({
		credentials: credentials({ RELAY_A_KEY: "sk-relay" }),
		getProviders: async () => [relay],
		config: validateAccountConfig({ monitors: { "relay-a": { adapter: "new-api" } } }),
		deps: {
			includeLegacyProviders: false,
			now: () => now,
			fetch: async (url) => {
				calls += 1;
				if (String(url).endsWith("/api/status")) return jsonResponse({ data: { quota_per_unit: 1 } });
				return jsonResponse({ code: true, data: { total_granted: 10, total_used: 2, total_available: 8 } });
			}
		}
	});
	const first = await service.get("relay-a");
	const second = await service.get("relay-a");
	assert.equal(first.balance.remaining, 8);
	assert.equal(second.balance.remaining, 8);
	assert.equal(calls, 2, "fresh cache must avoid another upstream request");
	await service.refreshAll();
	assert.equal(calls, 4, "background refresh must force an upstream update");
	console.log("account cache and background refresh contract ok");
}

{
	let phase = "ok";
	let clock = now;
	const service = createAccountService({
		credentials: credentials({ RELAY_A_KEY: "sk-relay" }),
		getProviders: async () => [relay],
		config: validateAccountConfig({ monitors: { "relay-a": { adapter: "new-api" } } }),
		deps: {
			includeLegacyProviders: false,
			now: () => clock,
			fetch: async (url) => {
				if (String(url).endsWith("/api/status")) return jsonResponse({ data: { quota_per_unit: 1 } });
				if (phase === "transient") return jsonResponse({}, 503);
				if (phase === "rate-limited") return jsonResponse({}, 429);
				if (phase === "auth") return jsonResponse({}, 401);
				return jsonResponse({ code: true, data: { total_granted: 10, total_used: 2, total_available: 8 } });
			}
		}
	});
	const success = await service.get("relay-a");
	assert.equal(success.status, "ok");
	assert.equal(success.lastAttemptAt, now);
	assert.equal(success.lastSuccessAt, now);
	assert.equal(success.ageMs, 0);
	assert.equal(success.stale, false);
	assert.equal(success.provenance, "provider");
	clock += 1000;
	const successAgain = await service.get("relay-a", { force: true });
	const successfulAt = clock;
	assert.equal(successAgain.lastAttemptAt, successfulAt);
	assert.equal(successAgain.lastSuccessAt, successfulAt, "consecutive success must advance both health timestamps");
	assert.equal(successAgain.ageMs, 0);
	const providerView = (await service.providerViews()).find((entry) => entry.id === "relay-a");
	assert.deepEqual({
		stale: providerView.stale,
		lastAttemptAt: providerView.lastAttemptAt,
		lastSuccessAt: providerView.lastSuccessAt,
		ageMs: providerView.ageMs,
		provenance: providerView.provenance,
		reason: providerView.reason
	}, { stale: false, lastAttemptAt: successfulAt, lastSuccessAt: successfulAt, ageMs: 0, provenance: "provider", reason: null });
	clock += 1000;
	assert.equal((await service.get("relay-a")).ageMs, 1000, "cached health age must advance at read time");
	phase = "transient";
	clock += 300000;
	const stale = await service.get("relay-a", { force: true });
	assert.equal(stale.status, "unavailable");
	assert.equal(stale.stale, true);
	assert.equal(stale.balance.remaining, 8);
	assert.equal(stale.lastAttemptAt, clock);
	assert.equal(stale.lastSuccessAt, successfulAt);
	assert.equal(stale.ageMs, 301000);
	assert.equal(stale.reason, "unknown");
	phase = "rate-limited";
	clock += 1000;
	const limited = await service.get("relay-a", { force: true });
	assert.equal(limited.status, "rate-limited");
	assert.equal(limited.stale, true);
	assert.equal(limited.balance.remaining, 8);
	assert.equal(limited.lastSuccessAt, successfulAt);
	assert.equal(limited.reason, "rate-limited");
	assert.equal(await service.nextRefreshAt(), clock + 300000, "the first 429 must schedule bounded backoff");
	clock += 300000;
	const limitedAgain = await service.get("relay-a", { force: true });
	assert.equal(limitedAgain.status, "rate-limited");
	assert.equal(await service.nextRefreshAt(), clock + 600000, "consecutive 429 responses must increase backoff per provider");
	phase = "transient";
	clock += 1000;
	const failedRetry = await service.get("relay-a", { force: true });
	assert.equal(failedRetry.status, "unavailable");
	assert.equal(failedRetry.stale, true);
	assert.equal(await service.nextRefreshAt(), clock + 600000, "a failed retry must not clear rate-limit backoff before recovery");
	phase = "auth";
	clock += 1000;
	const unauthorized = await service.get("relay-a", { force: true });
	assert.equal(unauthorized.status, "unauthorized");
	assert.equal(unauthorized.balance, null, "auth failures must not retain stale account data");
	assert.equal(unauthorized.stale, false);
	assert.equal(unauthorized.lastSuccessAt, successfulAt, "non-transient failures must not erase health history");
	assert.equal(unauthorized.reason, "unauthorized");
	phase = "ok";
	clock += 1000;
	const recovered = await service.get("relay-a", { force: true });
	assert.equal(recovered.status, "ok");
	assert.equal(recovered.stale, false);
	assert.equal(recovered.lastSuccessAt, clock);
	assert.equal(recovered.ageMs, 0);
	assert.equal(await service.nextRefreshAt(), clock + 900000, "success must clear rate-limit backoff");
	console.log("account health transitions, stale retention, and 429 recovery ok");
}

{
	let phase = "ok";
	let provider = { ...relay };
	const service = createAccountService({
		credentials: credentials({ RELAY_A_KEY: "sk-relay" }),
		getProviders: async () => [provider],
		config: validateAccountConfig({ monitors: { "relay-a": { adapter: "general" } } }),
		deps: {
			includeLegacyProviders: false,
			now: () => now,
			fetch: async () => phase === "ok"
				? jsonResponse({ balance: 42, currency: "USD" })
				: jsonResponse({}, 503)
		}
	});
	const first = await service.get("relay-a");
	assert.equal(first.balance.remaining, 42);
	provider = { ...provider, baseURL: "https://replacement.example.com/v1" };
	const reboundView = (await service.providerViews()).find((entry) => entry.id === "relay-a");
	assert.equal(reboundView.status, "pending", "provider views must not expose a snapshot from a different config key");
	assert.equal(reboundView.fetchedAt, null);
	assert.equal(reboundView.lastSuccessAt, null);
	phase = "unavailable";
	const changed = await service.get("relay-a", { force: true });
	assert.equal(changed.status, "unavailable");
	assert.equal(changed.stale, false, "a new provider binding must not retain data from the previous config key");
	assert.equal(changed.balance, null);
	assert.equal(changed.lastSuccessAt, null);
	console.log("account config changes invalidate stale-data and backoff history ok");
}

{
	let clock = now;
	let configured = true;
	let calls = 0;
	const service = createAccountService({
		credentials: { resolve: async () => configured ? { value: "sk-relay" } : void 0 },
		getProviders: async () => [relay],
		config: validateAccountConfig({ monitors: { "relay-a": { adapter: "general" } } }),
		deps: {
			includeLegacyProviders: false,
			now: () => clock,
			fetch: async () => {
				calls += 1;
				return jsonResponse({ balance: 42, currency: "USD" });
			}
		}
	});
	const success = await service.get("relay-a");
	assert.equal(success.lastAttemptAt, now);
	configured = false;
	clock += 900000;
	await service.refreshDue();
	const unconfigured = service.cached("relay-a");
	assert.equal(unconfigured.status, "not-configured");
	assert.equal(unconfigured.lastAttemptAt, now, "a local missing-credential evaluation must preserve the last real provider attempt");
	assert.equal(unconfigured.lastSuccessAt, now);
	assert.equal(await service.nextRefreshAt(), clock + 900000, "a no-attempt evaluation must still advance the scheduler deadline");
	clock += 900000;
	await service.refreshDue();
	assert.equal(await service.nextRefreshAt(), clock + 900000, "consecutive missing-credential evaluations must never create a one-second loop");
	assert.equal(calls, 1, "missing credentials must not create extra provider requests");
	console.log("no-attempt evaluations remain health-accurate and scheduler-bounded ok");
}

{
	let provider = { ...relay, baseURL: "https://old.example.com/v1" };
	let releaseOld;
	const calls = [];
	const service = createAccountService({
		credentials: credentials({ RELAY_A_KEY: "sk-relay" }),
		getProviders: async () => [provider],
		config: validateAccountConfig({ monitors: { "relay-a": { adapter: "general" } } }),
		deps: {
			includeLegacyProviders: false,
			now: () => now,
			fetch: async (url) => {
				calls.push(String(url));
				if (String(url).includes("old.example.com")) {
					await new Promise((resolve) => { releaseOld = resolve; });
					return jsonResponse({ balance: 10, currency: "USD" });
				}
				return jsonResponse({ balance: 99, currency: "USD" });
			}
		}
	});
	const oldRequest = service.get("relay-a", { force: true });
	await new Promise((resolve) => setImmediate(resolve));
	provider = { ...provider, baseURL: "https://new.example.com/v1" };
	const newAccount = await service.get("relay-a", { force: true });
	assert.equal(newAccount.balance.remaining, 99, "a rebound provider must not share the previous config's inflight request");
	releaseOld();
	const oldAccount = await oldRequest;
	assert.equal(oldAccount.balance.remaining, 10);
	assert.equal((await service.get("relay-a")).balance.remaining, 99, "a late old-config completion must not overwrite the new binding cache");
	assert.deepEqual(calls, ["https://old.example.com/user/balance", "https://new.example.com/user/balance"]);
	console.log("single-flight is config-aware and rejects late old-binding cache writes ok");
}

{
	const secret = "SECRET_API_KEY_sk-danger";
	const service = createAccountService({
		credentials: credentials({ RELAY_A_KEY: secret }),
		getProviders: async () => [relay],
		config: validateAccountConfig({ monitors: { "relay-a": { adapter: "general" } } }),
		deps: {
			includeLegacyProviders: false,
			now: () => now,
			fetch: async () => {
				const error = new Error(`Authorization: Bearer ${secret}; Cookie=session-secret; upstream body=${secret}`);
				error.providerStatus = "unavailable";
				error.safeReason = `Authorization: Bearer ${secret}`;
				throw error;
			}
		}
	});
	const account = await service.get("relay-a", { force: true });
	assert.equal(account.reason, "unknown");
	assert.equal(account.lastAttemptAt, now);
	assert.equal(account.lastSuccessAt, null);
	assert.equal(account.ageMs, null, "an account that never succeeded has no data age");
	const wire = JSON.stringify({ account, providers: await service.providerViews() });
	assert.equal(wire.includes(secret), false);
	assert.equal(/Authorization|Cookie|upstream body/i.test(wire), false);
	console.log("account health diagnostics never expose hostile upstream secrets ok");
}

{
	let clock = now;
	let releaseRelayA;
	let holdRelayA = true;
	const calls = new Map([["relay-a", 0], ["relay-b", 0]]);
	const relayB = { ...relay, id: "relay-b", displayName: "Relay B", apiKeyEnv: "RELAY_B_KEY", baseURL: "https://relay-b.example.com/v1" };
	const service = createAccountService({
		credentials: credentials({ RELAY_A_KEY: "sk-a", RELAY_B_KEY: "sk-b" }),
		getProviders: async () => [relay, relayB],
		config: validateAccountConfig({ monitors: {
			"relay-a": { adapter: "general" },
			"relay-b": { adapter: "general" }
		} }),
		deps: {
			includeLegacyProviders: false,
			now: () => clock,
			fetch: async (url) => {
				const id = String(url).includes("relay-b") ? "relay-b" : "relay-a";
				calls.set(id, calls.get(id) + 1);
				if (id === "relay-a" && holdRelayA) await new Promise((resolve) => { releaseRelayA = resolve; });
				return jsonResponse({ balance: id === "relay-a" ? 10 : 20, currency: "USD" });
			}
		}
	});
	let policyChanges = 0;
	const unsubscribe = service.subscribePolicyChanges(() => { policyChanges += 1; });
	service.touch("relay-a", "detail");
	assert.equal(policyChanges, 1, "background-to-detail activity must notify the central scheduler");
	service.touch("relay-a", "detail");
	assert.equal(policyChanges, 1, "refreshing the same activity hint must not create redundant scheduler wakes");
	service.setActiveProviders(["relay-a"]);
	assert.equal(policyChanges, 2, "detail-to-active activity must notify the central scheduler");
	const direct = service.get("relay-a", { force: true, activity: "active" });
	await new Promise((resolve) => setImmediate(resolve));
	const central = service.refreshDue({ force: true });
	holdRelayA = false;
	releaseRelayA();
	await Promise.all([direct, central]);
	assert.deepEqual(Object.fromEntries(calls), { "relay-a": 1, "relay-b": 1 }, "detail/background overlap must preserve one upstream request per provider");
	clock += 60000;
	await service.refreshDue();
	assert.deepEqual(Object.fromEntries(calls), { "relay-a": 2, "relay-b": 1 }, "active and background providers must keep independent due times");
	unsubscribe();
	console.log("adaptive refresh preserves single-flight and per-provider independence ok");
}

{
	const service = createAccountService({
		credentials: credentials({}),
		getProviders: async () => [relay],
		config: validateAccountConfig({ monitors: { missing: { adapter: "general" } } }),
		deps: { includeLegacyProviders: false }
	});
	await assert.rejects(() => service.providerViews(), /unknown provider: missing/);
	console.log("unknown monitor provider rejection ok");
}

{
	const service = createAccountService({
		credentials: credentials({ LATE_PROVIDER_API_KEY: "sk-late-provider" }),
		getProviders: async () => [],
		config: validateAccountConfig({ monitors: {
			"late-provider": {
				adapter: "sub2api",
				usageBaseURL: "https://late-provider.example.com",
				credentialRef: "LATE_PROVIDER_API_KEY"
			}
		} }),
		deps: {
			includeLegacyProviders: false,
			fetch: async (url, init) => {
				assert.equal(String(url), "https://late-provider.example.com/v1/usage");
				assert.equal(init.headers.authorization, "Bearer sk-late-provider");
				return jsonResponse({ mode: "unrestricted", isValid: true, remaining: 12.5, unit: "USD", balance: 12.5 });
			}
		}
	});
	const view = (await service.providerViews()).find((entry) => entry.id === "late-provider");
	assert.equal(view?.adapter, "sub2api");
	const account = await service.get("late-provider");
	assert.equal(account.status, "ok");
	assert.equal(account.balance.remaining, 12.5);
	console.log("explicit dynamic provider monitor fallback ok");
}


{
	const target = new URL("https://api.deepseek.com/user/balance");
	const ipv6 = { address: "2606:4700:4700::1111", family: 6 };
	const ipv4 = { address: "1.1.1.1", family: 4 };
	assert.deepEqual(
		selectResolvedAddresses(target, [ipv6, ipv4]),
		[ipv6, ipv4],
		"all validated public DNS answers must remain available for connection fallback"
	);
	console.log("multi-address DNS policy preserves validated candidates ok");
}

{
	const source = readFileSync(new URL("../lib/accounts.js", import.meta.url), "utf8");
	assert.match(source, /family:\s*address\.family/, "each pinned request must fix the selected address family");
	assert.match(source, /autoSelectFamily:\s*false/, "Node network-family autoselection must stay disabled inside each pinned attempt");
	console.log("Node 24 pinned request disables inner network-family autoselection ok");
}

{
	const source = readFileSync(new URL("../lib/accounts.js", import.meta.url), "utf8");
	assert.match(source, /request\.on\("socket",\s*\(socket\)\s*=>\s*\{[^}]*socket\.on\("error"/, "pinned request must forward connect-phase socket errors to the request (#42)");
	console.log("pinned request socket error backstop present ok");
}

{
	// Real transport regression for #42: a pinned connection to a closed port
	// must reject through the normal error path (unavailable snapshot), never
	// escape as an unhandled socket 'error' that kills the host process.
	const { createServer } = await import("node:http");
	const probe = createServer();
	await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const { port } = probe.address();
	await new Promise((resolve) => probe.close(resolve)); // port is now guaranteed closed
	const localProvider = { ...relay, baseURL: `http://localhost:${port}/v1` };
	const spec = resolveAccountSpec(localProvider, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "general", allowPrivateNetwork: true, allowInsecure: true }
	} }));
	// No requestPinned mock: exercise the real pinnedRequest transport so the
	// connect-phase ECONNREFUSED travels the exact socket error path from #42.
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		lookup: async () => [
			{ address: "127.0.0.1", family: 4 }
		]
	});
	assert.equal(account.status, "unavailable");
	assert.equal(account.reason, "all-addresses-unreachable");
	console.log("real socket connect refusal degrades without unhandled error ok");
}

{
	const { createServer } = await import("node:http");
	const server = createServer((req, res) => {
		assert.equal(req.url, "/user/balance");
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ balance: 11, currency: "USD" }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	try {
		const localProvider = { ...relay, baseURL: `http://localhost:${port}/v1` };
		const spec = resolveAccountSpec(localProvider, validateAccountConfig({ monitors: {
			"relay-a": { adapter: "general", allowPrivateNetwork: true, allowInsecure: true }
		} }));
		const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
			now: () => now,
			lookup: async () => [
				{ address: "::1", family: 6 },
				{ address: "127.0.0.1", family: 4 }
			]
		});
		assert.equal(account.status, "ok");
		assert.equal(account.balance.remaining, 11);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
	console.log("real socket IPv6 failure falls back to pinned IPv4 without escaping ok");
}

{
	const attempts = [];
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "general" }
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		lookup: async () => [
			{ address: "2606:4700:4700::1111", family: 6 },
			{ address: "1.1.1.1", family: 4 }
		],
		requestPinned: async (_url, address) => {
			attempts.push(address.address);
			if (address.family === 6) {
				const error = new Error("IPv6 route unavailable");
				error.code = "ENETUNREACH";
				throw error;
			}
			return jsonResponse({ balance: 7, currency: "USD" });
		}
	});
	assert.equal(account.status, "ok");
	assert.equal(account.balance.remaining, 7);
	assert.deepEqual(attempts, ["2606:4700:4700::1111", "1.1.1.1"]);
	console.log("IPv6-unreachable falls back to validated IPv4 ok");
}

{
	const attempts = [];
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "general" }
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		lookup: async () => [
			{ address: "1.1.1.1", family: 4 },
			{ address: "2606:4700:4700::1111", family: 6 }
		],
		requestPinned: async (_url, address) => {
			attempts.push(address.address);
			if (address.family === 4) {
				const error = new Error("IPv4 route unavailable");
				error.code = "EHOSTUNREACH";
				throw error;
			}
			return jsonResponse({ balance: 8, currency: "USD" });
		}
	});
	assert.equal(account.status, "ok");
	assert.equal(account.balance.remaining, 8);
	assert.deepEqual(attempts, ["1.1.1.1", "2606:4700:4700::1111"]);
	console.log("IPv4-unreachable falls back to validated IPv6 ok");
}

{
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "general" }
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		lookup: async () => [
			{ address: "2606:4700:4700::1111", family: 6 },
			{ address: "1.1.1.1", family: 4 }
		],
		requestPinned: async () => {
			const error = new Error("no usable local route");
			error.code = "EADDRNOTAVAIL";
			throw error;
		}
	});
	assert.equal(account.status, "unavailable");
	assert.equal(account.reason, "all-addresses-unreachable");
	assert.equal(account.balance, null);
	console.log("all validated addresses unreachable degrades to safe unavailable snapshot ok");
}

{
	let attempts = 0;
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "general" }
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		lookup: async () => [
			{ address: "2606:4700:4700::1111", family: 6 },
			{ address: "1.1.1.1", family: 4 }
		],
		requestPinned: async () => {
			attempts += 1;
			const error = new Error("certificate expired");
			error.code = "CERT_HAS_EXPIRED";
			throw error;
		}
	});
	assert.equal(account.status, "unavailable");
	assert.equal(account.reason, "unknown", "TLS failures must expose only a fixed diagnostic code");
	assert.equal(attempts, 1, "non-connection failures must not retry another IP");
	console.log("TLS failure does not bypass validation via address fallback ok");
}

{
	const spec = resolveAccountSpec(relay, validateAccountConfig({ monitors: {
		"relay-a": { adapter: "general" }
	} }));
	const account = await queryAccount(spec, credentials({ RELAY_A_KEY: "sk-relay" }), {
		now: () => now,
		lookup: async () => { throw new Error("resolver offline"); }
	});
	assert.equal(account.status, "unavailable");
	assert.equal(account.reason, "dns-resolution-failed");
	console.log("DNS failure exposes only sanitized diagnostic reason ok");
}

{
	// Ollama Cloud: canonical provider id auto-selects the ollama adapter.
	const spec = resolveAccountSpec({ id: "ollama", displayName: "Ollama", apiKeyEnv: "OLLAMA_API_KEY", baseURL: "https://ollama.com" }, validateAccountConfig());
	assert.equal(spec.adapter, "ollama");
	assert.equal(spec.mode, "subscription");
	assert.equal(spec.apiKeyRef, "OLLAMA_API_KEY");
	console.log("Ollama canonical id auto-detection ok");
}

{
	// Ollama Cloud: a custom provider id with an ollama.com baseURL host also
	// auto-selects the adapter (the user's own id/displayName are preserved).
	const spec = resolveAccountSpec({ id: "my-ollama", displayName: "My Ollama", apiKeyEnv: "OLLAMA_API_KEY", baseURL: "https://ollama.com" }, validateAccountConfig());
	assert.equal(spec.adapter, "ollama");
	assert.equal(spec.mode, "subscription");
	assert.equal(spec.id, "my-ollama");
	assert.equal(spec.displayName, "My Ollama");
	const subdomain = resolveAccountSpec({ id: "custom", displayName: "Custom", apiKeyEnv: "OLLAMA_API_KEY", baseURL: "https://api.ollama.com" }, validateAccountConfig());
	assert.equal(subdomain.adapter, "ollama");
	console.log("Ollama baseURL hostname auto-detection ok");
}

{
	// Local Ollama (localhost:11434) must NOT auto-become an Ollama Cloud
	// quota account: no adapter is selected.
	const local = resolveAccountSpec({ id: "ollama-local", displayName: "Local Ollama", apiKeyEnv: "OLLAMA_API_KEY", baseURL: "http://localhost:11434" }, validateAccountConfig());
	assert.equal(local.adapter, null);
	const loopback = resolveAccountSpec({ id: "ollama-local", displayName: "Local Ollama", apiKeyEnv: "OLLAMA_API_KEY", baseURL: "http://127.0.0.1:11434" }, validateAccountConfig());
	assert.equal(loopback.adapter, null);
	// Regression: a local install that happens to use the canonical "ollama"
	// id must still not be misread as a cloud quota account.
	const canonicalLocal = resolveAccountSpec({ id: "ollama", displayName: "Ollama", apiKeyEnv: "OLLAMA_API_KEY", baseURL: "http://localhost:11434" }, validateAccountConfig());
	assert.equal(canonicalLocal.adapter, null, "canonical id + localhost must not select the cloud adapter");
	console.log("Local Ollama is not auto-detected as cloud quota ok");
}

{
	// Explicit monitor.adapter: "ollama" remains the escape hatch for proxies
	// and custom endpoints where hostname detection cannot work.
	const spec = resolveAccountSpec({ id: "relay-ollama", displayName: "Relay", apiKeyEnv: "RELAY_KEY", baseURL: "https://relay.example.com" }, validateAccountConfig({ monitors: {
		"relay-ollama": { adapter: "ollama", usageBaseURL: "https://ollama.example.com" }
	} }));
	assert.equal(spec.adapter, "ollama");
	assert.equal(spec.mode, "subscription");
	assert.equal(spec.baseURL, "https://ollama.example.com");
	console.log("Ollama explicit monitor escape hatch ok");
}

{
	// Ollama Cloud: queryAccount integration — windows, alert, and no key leak.
	const spec = resolveAccountSpec({ id: "ollama", displayName: "Ollama", apiKeyEnv: "OLLAMA_API_KEY", baseURL: "https://ollama.com" }, validateAccountConfig());
	const account = await queryAccount(spec, credentials({ OLLAMA_API_KEY: "sk-ollama-secret" }), {
		now: () => now,
		fetch: async (url, init) => {
			assert.equal(String(url), "https://ollama.com/api/usage");
			assert.equal(init.headers.authorization, "Bearer sk-ollama-secret");
			return jsonResponse({ limits: { session: { usage: 0.3 }, weekly: { usage: 0.1 } } });
		}
	});
	assert.equal(account.status, "ok");
	assert.equal(account.mode, "subscription");
	assert.equal(account.adapter, "ollama");
	assert.equal(account.id, "ollama");
	assert.deepEqual(account.windows.map((window) => [window.kind, window.usedPercent, window.remainingPercent]), [
		["session", 30, 70],
		["weekly", 10, 90]
	]);
	assert.deepEqual(account.alert, { level: "normal", metric: "remaining-percent", value: 70 });
	assert.equal(JSON.stringify(account).includes("sk-ollama-secret"), false, "API key must never cross the account snapshot boundary");
	console.log("Ollama queryAccount integration and alert ok");
}

{
	// Ollama Cloud: no unconditional provider — an unconfigured install must
	// NOT show an Ollama account; only configured providers appear.
	const service = createAccountService({
		credentials: credentials({}),
		getProviders: async () => [{ id: "deepseek-official", displayName: "DeepSeek", apiKeyEnv: "DEEPSEEK_API_KEY", baseURL: "https://api.deepseek.com" }],
		config: validateAccountConfig(),
		deps: { includeLegacyProviders: true, now: () => now }
	});
	const views = await service.providerViews();
	assert.equal(views.some((view) => view.id === "ollama"), false, "unconfigured install must not list an Ollama account");
	assert.equal(views.some((view) => view.id === "deepseek-official"), true);
	console.log("Ollama is not unconditionally added ok");
}

{
	// Ollama Cloud: a configured provider with ollama identity appears with the
	// user's own id and gets the subscription adapter.
	const service = createAccountService({
		credentials: credentials({ OLLAMA_API_KEY: "sk-ollama" }),
		getProviders: async () => [{ id: "my-ollama", displayName: "My Ollama", apiKeyEnv: "OLLAMA_API_KEY", baseURL: "https://ollama.com" }],
		config: validateAccountConfig(),
		deps: {
			includeLegacyProviders: true,
			now: () => now,
			fetch: async () => jsonResponse({ limits: { session: { usage: 0.2 }, weekly: { usage: 0.1 } } })
		}
	});
	const views = await service.providerViews();
	const view = views.find((entry) => entry.id === "my-ollama");
	assert.equal(view?.adapter, "ollama");
	assert.equal(view?.accountMode, "subscription");
	const account = await service.get("my-ollama", { force: true });
	assert.equal(account.status, "ok");
	assert.equal(account.id, "my-ollama");
	assert.equal(account.displayName, "My Ollama");
	assert.equal(account.windows.length, 2);
	console.log("Configured Ollama provider appears with user id ok");
}

console.log("ACCOUNT TESTS PASSED");
