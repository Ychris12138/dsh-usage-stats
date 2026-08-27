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
	/** OrcaRouter: wallet balance with an OpenAI-compatible billing fallback. */
	orcarouter: {
		// OrcaRouter exposes these endpoints under the public /v1 prefix. Keep the
		// configured origin/path so the normal pinned-network policy still applies
		// and a provider profile never causes a cross-origin request.
		balanceURL: (baseURL) => orcaBillingURL(baseURL, "/balance"),
		subscriptionURL: (baseURL) => orcaBillingURL(baseURL, "/dashboard/billing/subscription"),
		usageURL: (baseURL) => orcaBillingURL(baseURL, "/dashboard/billing/usage"),
		query: async (baseURL, apiKey, timeoutMs, fetchImpl) => {
			// Current deployments expose the wallet's paid/free/promo balance. Older
			// deployments may not have it, so retain the documented OpenAI-shaped
			// subscription + usage fallback for compatibility.
			try {
				return parseOrcaRouterWallet(await requestJSON(orcaBillingURL(baseURL, "/balance"), apiKey, timeoutMs, fetchImpl));
			} catch (error) {
				if (error?.providerStatus !== "unsupported") throw error;
			}
			const subscription = await requestJSON(orcaBillingURL(baseURL, "/dashboard/billing/subscription"), apiKey, timeoutMs, fetchImpl);
			const usage = await requestJSON(orcaBillingURL(baseURL, "/dashboard/billing/usage"), apiKey, timeoutMs, fetchImpl);
			return parseOrcaRouter(subscription, usage);
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

function orcaBillingURL(baseURL, path) {
	const base = new URL(baseURL);
	const pathname = base.pathname.replace(/\/+$/, "");
	const prefix = pathname === "" ? "/v1" : pathname.endsWith("/v1") ? pathname : `${pathname}/v1`;
	return new URL(`${prefix}${path}`, base.origin).href;
}

function parseOrcaRouter(subscription, usage) {
	const total = numberOrNull(subscription?.hard_limit_usd ?? subscription?.soft_limit_usd);
	// OpenAI-compatible dashboard usage is reported in cents. Keep the unit
	// conversion in this adapter so `remaining`, `used`, and `limit` share one
	// consistent currency basis.
	const usageCents = numberOrNull(usage?.total_usage);
	if (total === null || usageCents === null || total < 0 || usageCents < 0) {
		throw providerError("invalid-response", "OrcaRouter billing response is missing numeric quota data");
	}
	const used = usageCents / 100;
	const unlimited = total === 100000000
		&& numberOrNull(subscription?.soft_limit_usd) === total
		&& numberOrNull(subscription?.system_hard_limit_usd) === total;
	return {
		isAvailable: unlimited || total - used > 0,
		currency: "USD",
		total: unlimited ? total : total - used,
		used,
		limit: unlimited ? void 0 : total,
		unlimited,
		granted: void 0,
		toppedUp: void 0
	};
}

function creditArrayTotal(value, currency, label) {
	if (value === void 0 || value === null) return 0;
	if (!Array.isArray(value)) throw providerError("invalid-response", `OrcaRouter ${label} credits are invalid`);
	let total = 0;
	for (const entry of value) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw providerError("invalid-response", `OrcaRouter ${label} credits are invalid`);
		const entryCurrency = typeof entry.unit === "string" && entry.unit.trim() !== "" ? entry.unit.trim().toUpperCase() : currency;
		if (entryCurrency !== currency) throw providerError("invalid-response", `OrcaRouter ${label} credits use a different currency`);
		const amount = numberOrNull(entry.balance_usd ?? entry.balance);
		if (amount === null || amount < 0) throw providerError("invalid-response", `OrcaRouter ${label} credits are missing a numeric balance`);
		total += amount;
	}
	return total;
}

function parseOrcaRouterWallet(body) {
	if (body === null || typeof body !== "object" || Array.isArray(body)) throw providerError("invalid-response", "OrcaRouter wallet response is invalid");
	const currency = typeof body.unit === "string" && body.unit.trim() !== "" ? body.unit.trim().toUpperCase() : null;
	if (currency === null) throw providerError("invalid-response", "OrcaRouter wallet response is missing currency");
	const paid = numberOrNull(body.paid_balance);
	if (paid === null || paid < 0) throw providerError("invalid-response", "OrcaRouter wallet response is missing paid balance");
	const remaining = paid
		+ creditArrayTotal(body.free_credit, currency, "free")
		+ creditArrayTotal(body.promo_credits, currency, "promo");
	return {
		isAvailable: remaining > 0,
		currency,
		total: remaining,
		used: void 0,
		limit: void 0,
		unlimited: false,
		granted: void 0,
		toppedUp: void 0
	};
}

function providerError(status, message, httpStatus) {
	const error = new Error(message);
	error.providerStatus = status;
	if (httpStatus !== void 0) error.httpStatus = httpStatus;
	return error;
}

function responseStatus(status) {
	if (status === 401 || status === 403) return "unauthorized";
	if (status === 429) return "rate-limited";
	if (status === 404 || status === 405) return "unsupported";
	return status >= 500 ? "unavailable" : "invalid-response";
}

function numberOrNull(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

async function requestJSON(url, apiKey, timeoutMs, fetchImpl) {
	const response = await fetchImpl(url, {
		headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (!response.ok) throw providerError(responseStatus(response.status), `balance API returned HTTP ${response.status}`, response.status);
	try {
		return await response.json();
	} catch {
		throw providerError("invalid-response", "balance API returned invalid JSON");
	}
}

/** Map a provider id (dsh adapter id or pi-ai route) to a balance scheme id. */
export function balanceSchemeOf(providerId) {
	return balanceSchemeForProviderId(providerId);
}

/** Query one provider's balance. Throws on transport/HTTP errors. */
export async function queryBalance(scheme, baseURL, apiKey, timeoutMs = 15000, fetchImpl = fetch) {
	const spec = SCHEMES[scheme];
	if (spec === void 0) throw new Error(`no balance scheme "${scheme}"`);
	if (typeof spec.query === "function") return spec.query(baseURL, apiKey, timeoutMs, fetchImpl);
	return spec.parse(await requestJSON(spec.url(baseURL), apiKey, timeoutMs, fetchImpl));
}

/** Scheme ids with built-in support (for docs/tests). */
export function supportedBalanceSchemes() {
	return Object.keys(SCHEMES);
}
