import assert from "node:assert/strict";
import {
	createAccountService,
	isPrivateAddress,
	queryAccount,
	resolveAccountSpec,
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

assert.equal(isPrivateAddress("127.0.0.1"), true);
assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true);
assert.equal(isPrivateAddress("::ffff:7f00:1"), true);
assert.equal(isPrivateAddress("fc00::1"), true);
assert.equal(isPrivateAddress("fe80::1"), true);
assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
console.log("IPv4/IPv6 private-address classification ok");

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
	assert.equal(account.status, "unsupported");
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
	assert.equal(account.status, "unsupported", "private network access needs its own opt-in");
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
	assert.equal(account.status, "unsupported", "DNS answers pointing at private networks must be rejected before connecting");
	console.log("DNS-to-private-network rejection ok");
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

console.log("ACCOUNT TESTS PASSED");
