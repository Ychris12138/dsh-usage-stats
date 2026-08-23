/**
 * Provider identity policy shared by account monitoring and session context.
 *
 * Identity is route-aware: a configured route id remains the account boundary,
 * even when two routes use the same upstream model. Classification follows one
 * strict precedence order: explicit monitor adapter, canonical route id,
 * canonical base-URL hostname, then unknown. Display labels are presentation
 * only and never participate in inference.
 *
 * @module dsh-usage-stats/provider-identity
 */

import { isPrivateHostname } from "./network.js";

const ADAPTER_IDENTITIES = Object.freeze({
	"deepseek-balance": { providerFamily: "deepseek", pricingFamily: "deepseek" },
	"openrouter-balance": { providerFamily: "openrouter", pricingFamily: "openrouter" },
	"moonshot-balance": { providerFamily: "moonshot", pricingFamily: "moonshot" },
	"zai-balance": { providerFamily: "zai", pricingFamily: "zai" },
	general: { providerFamily: "unknown", pricingFamily: "unknown" },
	"new-api": { providerFamily: "new-api", pricingFamily: "unknown" },
	sub2api: { providerFamily: "sub2api", pricingFamily: "unknown" },
	"sub2api-auth": { providerFamily: "sub2api", pricingFamily: "unknown" },
	"opencode-go": { providerFamily: "opencode-go", pricingFamily: "opencode-go" },
	"zai-token-plan": { providerFamily: "zai", pricingFamily: "zai" },
	"kimi-token-plan": { providerFamily: "kimi", pricingFamily: "kimi" },
	"minimax-token-plan": { providerFamily: "minimax", pricingFamily: "minimax" },
	ollama: { providerFamily: "ollama", pricingFamily: "ollama" },
	declarative: { providerFamily: "unknown", pricingFamily: "unknown" }
});

const CANONICAL_ROUTES = Object.freeze({
	"deepseek-official": { providerFamily: "deepseek", accountAdapter: "deepseek-balance", balanceScheme: "deepseek" },
	deepseek: { providerFamily: "deepseek", accountAdapter: "deepseek-balance", balanceScheme: "deepseek" },
	openrouter: { providerFamily: "openrouter", accountAdapter: "openrouter-balance", balanceScheme: "openrouter" },
	moonshotai: { providerFamily: "moonshot", accountAdapter: "moonshot-balance", balanceScheme: "moonshot" },
	"moonshotai-cn": { providerFamily: "moonshot", accountAdapter: "moonshot-balance", balanceScheme: "moonshot" },
	kimi: { providerFamily: "moonshot", accountAdapter: "moonshot-balance", balanceScheme: "moonshot" },
	"kimi-coding": { providerFamily: "kimi", accountAdapter: "kimi-token-plan", balanceScheme: "moonshot" },
	"kimi-for-coding": { providerFamily: "kimi", accountAdapter: "kimi-token-plan", balanceScheme: null },
	zai: { providerFamily: "zai", accountAdapter: "zai-token-plan", balanceScheme: "zai" },
	"zai-coding-cn": { providerFamily: "zai", accountAdapter: "zai-token-plan", balanceScheme: "zai" },
	"opencode-go": { providerFamily: "opencode-go", accountAdapter: "opencode-go", balanceScheme: null },
	minimax: { providerFamily: "minimax", accountAdapter: "minimax-token-plan", balanceScheme: null },
	minimaxi: { providerFamily: "minimax", accountAdapter: "minimax-token-plan", balanceScheme: null },
	"minimax-cn": { providerFamily: "minimax", accountAdapter: "minimax-token-plan", balanceScheme: null },
	"minimax-coding": { providerFamily: "minimax", accountAdapter: "minimax-token-plan", balanceScheme: null },
	passion: { providerFamily: "sub2api", accountAdapter: "sub2api", pricingFamily: "unknown", balanceScheme: null }
});

function nonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function hostnameOf(baseURL) {
	if (nonEmptyString(baseURL) === null) return null;
	try {
		return new URL(baseURL).hostname.toLowerCase().replace(/\.$/, "");
	} catch {
		return null;
	}
}

function hostRule(hostname) {
	if (hostname === "api.deepseek.com") return { providerFamily: "deepseek", accountAdapter: "deepseek-balance" };
	if (hostname === "passionapi.com" || hostname.endsWith(".passionapi.com")) return { providerFamily: "sub2api", accountAdapter: "sub2api", pricingFamily: "unknown" };
	if (hostname === "ollama.com" || hostname.endsWith(".ollama.com")) return { providerFamily: "ollama", accountAdapter: "ollama" };
	return null;
}

function buildProviderIdentity(provider, rule, confidence) {
	const routeId = nonEmptyString(provider?.id) ?? "unknown";
	const displayName = nonEmptyString(provider?.displayName) ?? routeId;
	const baseURL = nonEmptyString(provider?.baseURL);
	const providerFamily = rule?.providerFamily ?? "unknown";
	return {
		routeId,
		displayName,
		providerFamily,
		accountAdapter: rule?.accountAdapter ?? null,
		pricingFamily: rule?.pricingFamily ?? providerFamily,
		baseURL,
		confidence
	};
}

/** Return the legacy built-in balance scheme without duplicating route policy. */
export function balanceSchemeForProviderId(providerId) {
	return CANONICAL_ROUTES[providerId]?.balanceScheme ?? null;
}

/**
 * Resolve one configured provider route to stable semantic boundaries.
 * Explicit monitor configuration always wins. Unknown or malformed inputs
 * remain unknown instead of falling back to the human-readable display name.
 */
export function resolveProviderIdentity(provider, config = { monitors: {} }) {
	const routeId = nonEmptyString(provider?.id) ?? "unknown";
	const monitor = config?.monitors?.[routeId];
	const explicitAdapter = nonEmptyString(monitor?.adapter);
	if (explicitAdapter !== null) {
		const identity = ADAPTER_IDENTITIES[explicitAdapter] ?? { providerFamily: "unknown", pricingFamily: "unknown" };
		return buildProviderIdentity(provider, { ...identity, accountAdapter: explicitAdapter }, "explicit");
	}

	const canonical = CANONICAL_ROUTES[routeId];
	if (canonical !== void 0) return buildProviderIdentity(provider, canonical, "canonical-id");

	const hostname = hostnameOf(provider?.baseURL);
	if (hostname !== null) {
		// The canonical Ollama id is meaningful only for a non-private cloud
		// endpoint. This deliberate safety gate prevents local Ollama from being
		// mistaken for a subscription account while retaining canonical-id
		// precedence for actual cloud routes.
		if (routeId === "ollama" && !isPrivateHostname(hostname)) {
			return buildProviderIdentity(provider, { providerFamily: "ollama", accountAdapter: "ollama" }, "canonical-id");
		}
		const canonicalHost = hostRule(hostname);
		if (canonicalHost !== null) return buildProviderIdentity(provider, canonicalHost, "canonical-host");
	}

	return buildProviderIdentity(provider, null, "unknown");
}
