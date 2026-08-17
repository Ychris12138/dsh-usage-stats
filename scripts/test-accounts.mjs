import assert from "node:assert/strict";
import {
	createAccountService,
	isPrivateAddress,
	queryAccount,
	resolveAccountSpec,
	selectResolvedAddress,
	validateAccountConfig
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
				if (phase === "auth") return jsonResponse({}, 401);
				return jsonResponse({ code: true, data: { total_granted: 10, total_used: 2, total_available: 8 } });
			}
		}
	});
	assert.equal((await service.get("relay-a")).status, "ok");
	phase = "transient";
	clock += 300000;
	const stale = await service.get("relay-a", { force: true });
	assert.equal(stale.status, "unavailable");
	assert.equal(stale.stale, true);
	assert.equal(stale.balance.remaining, 8);
	phase = "auth";
	clock += 300000;
	const unauthorized = await service.get("relay-a", { force: true });
	assert.equal(unauthorized.status, "unauthorized");
	assert.equal(unauthorized.balance, null, "auth failures must not retain stale account data");
	console.log("transient stale retention and auth clearing ok");
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

console.log("ACCOUNT TESTS PASSED");
