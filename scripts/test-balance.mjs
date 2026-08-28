// Unit tests for lib/balance.js (offline: no network).
import assert from "node:assert/strict";
import { balanceSchemeOf, queryBalance, supportedBalanceSchemes } from "../lib/balance.js";

// Scheme mapping: known providers map to their scheme, others have none.
assert.equal(balanceSchemeOf("deepseek-official"), "deepseek");
assert.equal(balanceSchemeOf("deepseek"), "deepseek");
assert.equal(balanceSchemeOf("openrouter"), "openrouter");
assert.equal(balanceSchemeOf("moonshotai"), "moonshot");
assert.equal(balanceSchemeOf("moonshotai-cn"), "moonshot");
assert.equal(balanceSchemeOf("zai"), "zai");
assert.equal(balanceSchemeOf("zai-coding-cn"), "zai");
assert.equal(balanceSchemeOf("orcarouter"), "orcarouter");
assert.equal(balanceSchemeOf("opencode"), null);
assert.equal(balanceSchemeOf("opencode-go"), null);
assert.equal(balanceSchemeOf("ark"), null);
assert.equal(balanceSchemeOf("openai"), null);
assert.equal(balanceSchemeOf("anthropic"), null);
console.log("scheme mapping ok");

// Endpoint derivation from a configured base URL.
async function stubFetchOnce(payload, status = 200) {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		return { ok: status >= 200 && status < 300, status, json: async () => payload };
	};
	return calls;
}

function jsonResponse(value, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => value
	};
}

{
	const calls = await stubFetchOnce({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "36.44", granted_balance: "0.00", topped_up_balance: "36.44" }] });
	const balance = await queryBalance("deepseek", "https://api.deepseek.com/v1", "sk-test");
	assert.equal(calls[0].url, "https://api.deepseek.com/user/balance");
	assert.equal(calls[0].init.headers.authorization, "Bearer sk-test");
	assert.deepEqual(balance, { isAvailable: true, currency: "CNY", total: "36.44", granted: "0.00", toppedUp: "36.44" });
	console.log("deepseek scheme ok:", calls[0].url);
}

{
	const calls = await stubFetchOnce({ data: { total_credits: 100.5, total_usage: 25.75 } });
	const balance = await queryBalance("openrouter", "https://openrouter.ai/api/v1", "management-key");
	assert.equal(calls[0].url, "https://openrouter.ai/api/v1/credits");
	assert.equal(calls[0].init.headers.authorization, "Bearer management-key");
	assert.deepEqual(balance, { isAvailable: true, currency: "USD", total: 74.75, used: 25.75, limit: 100.5, granted: void 0, toppedUp: void 0 });
	console.log("openrouter scheme ok:", calls[0].url);
}

{
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		return jsonResponse({
			object: "balance",
			unit: "USD",
			paid_balance: 1.25,
			free_credit: [{ model: "orcarouter/free", balance_usd: 6 }],
			promo_credits: [{ balance: 0.5, unit: "USD" }]
		});
	};
	const balance = await queryBalance("orcarouter", "https://api.orcarouter.ai/v1", "sk-orca-test");
	assert.deepEqual(calls.map((call) => call.url), ["https://api.orcarouter.ai/v1/balance"]);
	assert.equal(calls[0].init.headers.authorization, "Bearer sk-orca-test");
	assert.deepEqual(balance, {
		isAvailable: true,
		currency: "USD",
		total: 7.75,
		used: void 0,
		limit: void 0,
		unlimited: false,
		granted: void 0,
		toppedUp: void 0
	});
	console.log("OrcaRouter wallet balance scheme ok:", calls[0].url);
}

{
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		if (calls.length === 1) return jsonResponse({}, 404);
		if (String(url).endsWith("/subscription")) return jsonResponse({ soft_limit_usd: 12.5, hard_limit_usd: 12.5, system_hard_limit_usd: 12.5 });
		return jsonResponse({ total_usage: 275 });
	};
	const balance = await queryBalance("orcarouter", "https://api.orcarouter.ai/v1", "sk-orca-test");
	assert.deepEqual(calls, [
		"https://api.orcarouter.ai/v1/balance",
		"https://api.orcarouter.ai/v1/dashboard/billing/subscription",
		"https://api.orcarouter.ai/v1/dashboard/billing/usage"
	]);
	assert.equal(balance.total, 9.75);
	assert.equal(balance.used, 2.75);
	assert.equal(balance.limit, 12.5);
	assert.equal(balance.unlimited, false);
	console.log("OrcaRouter OpenAI billing fallback ok");
}

{
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		if (calls.length === 1) return jsonResponse({}, 404);
		if (String(url).endsWith("/subscription")) return jsonResponse({ soft_limit_usd: 100000000, hard_limit_usd: 100000000, system_hard_limit_usd: 100000000 });
		return jsonResponse({ total_usage: 0 });
	};
	const balance = await queryBalance("orcarouter", "https://api.orcarouter.ai/v1", "sk-orca-test");
	assert.equal(balance.unlimited, true, "the OpenAI-compatible unlimited sentinel must not render as a $100m wallet");
	assert.equal(balance.limit, void 0);
	assert.equal(balance.total, 100000000);
	console.log("OrcaRouter unlimited quota sentinel is preserved safely ok");
}

{
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		return { ok: false, status: 429, json: async () => ({}) };
	};
	await assert.rejects(
		() => queryBalance("orcarouter", "https://api.orcarouter.ai/v1", "sk-orca-test"),
		(error) => error.providerStatus === "rate-limited" && error.httpStatus === 429
	);
	assert.equal(calls.length, 1, "usage endpoint must not be queried after a rate-limited subscription response");
	console.log("OrcaRouter billing HTTP classification ok");
}

{
	let calls = 0;
	globalThis.fetch = async (url) => {
		calls += 1;
		if (calls === 1) return jsonResponse({}, 404);
		if (String(url).endsWith("/subscription")) return jsonResponse({ hard_limit_usd: 12.5 });
		return jsonResponse({ total_usage: "not-a-number" });
	};
	await assert.rejects(
		() => queryBalance("orcarouter", "https://api.orcarouter.ai/v1", "sk-orca-test"),
		(error) => error.providerStatus === "invalid-response"
	);
	console.log("OrcaRouter malformed usage response fails closed ok");
}

{
	const calls = await stubFetchOnce({ data: { available_balance: 5.5, cash_balance: 3.0, voucher_balance: 2.5, currency: "CNY" } });
	const balance = await queryBalance("moonshot", "https://api.moonshot.cn", "sk-test");
	assert.equal(calls[0].url, "https://api.moonshot.cn/v1/users/me/balance");
	assert.deepEqual(balance, { isAvailable: true, currency: "CNY", total: 5.5, granted: 2.5, toppedUp: 3.0 });
	console.log("moonshot scheme ok:", calls[0].url);
}

{
	const calls = await stubFetchOnce({ data: { total_balance: 9.9, available_balance: 8.8, currency: "CNY" } });
	const balance = await queryBalance("zai", "https://api.z.ai/api/paas/v4", "sk-test");
	assert.equal(calls[0].url, "https://api.z.ai/api/paas/v4/balance");
	assert.deepEqual(balance, { isAvailable: true, currency: "CNY", total: 9.9, granted: void 0, toppedUp: 8.8 });
	console.log("zai scheme ok:", calls[0].url);
}

// Upstream HTTP errors surface as throws.
{
	const calls = await stubFetchOnce({}, 429);
	await assert.rejects(
		() => queryBalance("deepseek", "https://api.deepseek.com", "sk-test"),
		(error) => error.providerStatus === "rate-limited" && error.httpStatus === 429
	);
	assert.equal(calls.length, 1);
	console.log("upstream HTTP status classification ok");
}

{
	globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad JSON"); } });
	await assert.rejects(
		() => queryBalance("deepseek", "https://api.deepseek.com", "sk-test"),
		(error) => error.providerStatus === "invalid-response"
	);
	console.log("upstream JSON error classification ok");
}

delete globalThis.fetch;
assert.deepEqual(supportedBalanceSchemes().sort(), ["deepseek", "moonshot", "openrouter", "orcarouter", "zai"]);
console.log("BALANCE TESTS PASSED");
