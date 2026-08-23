/**
 * dsh-usage-stats — provider balance schemes.
 *
 * Pure, testable balance-query registry. Each scheme knows the endpoint path
 * (relative to the provider's configured base URL) and how to parse the
 * response into a normalized `{ isAvailable, currency, total, used, limit,
 * granted, toppedUp }` view. Providers without a public balance API (OpenCode Go,
 * Volcano Ark, OpenAI, Anthropic, …) map to no scheme — the UI shows an
 * explicit "no public balance interface" state instead of guessing.
 *
 * @module dsh-usage-stats/balance
 */

import { balanceSchemeForProviderId } from "./provider-identity.js";

const SCHEMES = {
	/** DeepSeek: GET {origin}/user/balance — CNY balance_infos entry. */
	deepseek: {
		url: (baseURL) => new URL("/user/balance", baseURL).href,
		parse: (json) => {
			const infos = Array.isArray(json?.balance_infos) ? json.balance_infos : [];
			const info = infos.find((entry) => entry?.currency === "CNY") ?? infos[0];
			return {
				isAvailable: json?.is_available === true,
				currency: info?.currency ?? void 0,
				total: info?.total_balance ?? void 0,
				granted: info?.granted_balance ?? void 0,
				toppedUp: info?.topped_up_balance ?? void 0
			};
		}
	},
	/** OpenRouter account credits; the endpoint requires a Management Key. */
	openrouter: {
		url: (baseURL) => new URL("/api/v1/credits", baseURL).href,
		parse: (json) => {
			const totalCredits = typeof json?.data?.total_credits === "number" ? json.data.total_credits : void 0;
			const totalUsage = typeof json?.data?.total_usage === "number" ? json.data.total_usage : void 0;
			const remaining = totalCredits !== void 0 && totalUsage !== void 0 ? totalCredits - totalUsage : void 0;
			return {
				isAvailable: remaining !== void 0 ? remaining > 0 : void 0,
				currency: "USD",
				total: remaining,
				used: totalUsage,
				limit: totalCredits,
				granted: void 0,
				toppedUp: void 0
			};
		}
	},
	/** Moonshot / Kimi: GET {origin}/v1/users/me/balance — available/cash/voucher. */
	moonshot: {
		url: (baseURL) => new URL("/v1/users/me/balance", baseURL).href,
		parse: (json) => {
			const data = json?.data;
			const available = typeof data?.available_balance === "number" ? data.available_balance : void 0;
			const cash = typeof data?.cash_balance === "number" ? data.cash_balance : void 0;
			const voucher = typeof data?.voucher_balance === "number" ? data.voucher_balance : void 0;
			return {
				isAvailable: available !== void 0 ? available > 0 : void 0,
				currency: typeof data?.currency === "string" ? data.currency : void 0,
				total: available,
				granted: voucher,
				toppedUp: cash
			};
		}
	},
	/** Z.AI / GLM: GET {origin}/api/paas/v4/balance — total + available. */
	zai: {
		url: (baseURL) => new URL("/api/paas/v4/balance", baseURL).href,
		parse: (json) => {
			const data = json?.data;
			const total = typeof data?.total_balance === "number" ? data.total_balance : typeof data?.available_balance === "number" ? data.available_balance : void 0;
			const available = typeof data?.available_balance === "number" ? data.available_balance : void 0;
			return {
				isAvailable: total !== void 0 ? total > 0 : void 0,
				currency: typeof data?.currency === "string" ? data.currency : void 0,
				total,
				granted: void 0,
				toppedUp: available
			};
		}
	}
};

function providerError(status, message, httpStatus) {
	const error = new Error(message);
	error.providerStatus = status;
	if (httpStatus !== void 0) error.httpStatus = httpStatus;
	return error;
}

function responseStatus(status) {
	if (status === 401 || status === 403) return "unauthorized";
	if (status === 429) return "rate-limited";
	return status >= 500 ? "unavailable" : "invalid-response";
}

/** Map a provider id (dsh adapter id or pi-ai route) to a balance scheme id. */
export function balanceSchemeOf(providerId) {
	return balanceSchemeForProviderId(providerId);
}

/** Query one provider's balance. Throws on transport/HTTP errors. */
export async function queryBalance(scheme, baseURL, apiKey, timeoutMs = 15000, fetchImpl = fetch) {
	const spec = SCHEMES[scheme];
	if (spec === void 0) throw new Error(`no balance scheme "${scheme}"`);
	const response = await fetchImpl(spec.url(baseURL), {
		headers: { authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (!response.ok) throw providerError(responseStatus(response.status), `balance API returned HTTP ${response.status}`, response.status);
	let body;
	try {
		body = await response.json();
	} catch {
		throw providerError("invalid-response", "balance API returned invalid JSON");
	}
	return spec.parse(body);
}

/** Scheme ids with built-in support (for docs/tests). */
export function supportedBalanceSchemes() {
	return Object.keys(SCHEMES);
}
