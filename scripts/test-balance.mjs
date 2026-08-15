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
assert.deepEqual(supportedBalanceSchemes().sort(), ["deepseek", "moonshot", "openrouter", "zai"]);
console.log("BALANCE TESTS PASSED");
