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

/** Bump whenever route classification can change pricing eligibility. */
export const PROVIDER_IDENTITY_POLICY_VERSION = 1;

const ADAPTER_IDENTITIES = Object.freeze({
	"deepseek-balance": { providerFamily: "deepseek", pricingFamily: "deepseek" },
	"deepseek-account": { providerFamily: "deepseek", pricingFamily: "unknown" },
	"openrouter-balance": { providerFamily: "openrouter", pricingFamily: "openrouter" },
	"moonshot-balance": { providerFamily: "moonshot", pricingFamily: "moonshot" },
	"zai-balance": { providerFamily: "zai", pricingFamily: "zai" },
	"orcarouter-balance": { providerFamily: "orcarouter", pricingFamily: "unknown" },
	general: { providerFamily: "unknown", pricingFamily: "unknown" },
	"new-api": { providerFamily: "new-api", pricingFamily: "unknown" },
	sub2api: { providerFamily: "sub2api", pricingFamily: "unknown" },
	"sub2api-auth": { providerFamily: "sub2api", pricingFamily: "unknown" },
	"opencode-go": { providerFamily: "opencode-go", pricingFamily: "opencode-go" },
	"zai-token-plan": { providerFamily: "zai", pricingFamily: "zai" },
	"kimi-token-plan": { providerFamily: "kimi", pricingFamily: "kimi" },
	"minimax-token-plan": { providerFamily: "minimax", pricingFamily: "minimax" },
	ollama: { providerFamily: "ollama", pricingFamily: "ollama" },
	// codearts 系由宿主插件（dsh-codearts-auth）持有凭据与签名协议，本插件只读
	// 它算好的积分余额；定价侧不认识这些 route（它们不是公开 API 供应商）。
	"codearts-credits": { providerFamily: "codearts", pricingFamily: "unknown" },
	declarative: { providerFamily: "unknown", pricingFamily: "unknown" }
});

const CANONICAL_ROUTES = Object.freeze({
	"deepseek-official": { providerFamily: "deepseek", accountAdapter: "deepseek-balance", balanceScheme: "deepseek" },
	"deepseek-account": { providerFamily: "deepseek", accountAdapter: "deepseek-account", pricingFamily: "unknown", balanceScheme: null },
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
	// ⚠️ `minimax` 故意**不**列在这里（既不走 token-plan 也不走 codearts-credits）：
	// 两个插件都注册了这个 route id，归属要按「有没有 API Key」现场判定。
	// 见 resolveProviderIdentity() 里的 MINIMAX_ROUTE_IDS 分支——
	//  - 带 apiKeyEnv / baseURL（用户自己配的 Key 路线）→ minimax-token-plan
	//  - 只有 dsh-codearts-auth 注册的反代路线（无 Key，凭据在它账号池里）
	//    → codearts-credits，否则这张卡会永远停在 not-configured
	// API Key 版额度也可用这些独立 route id 显式索取：minimaxi / minimax-cn /
	// minimax-coding。
	minimaxi: { providerFamily: "minimax", accountAdapter: "minimax-token-plan", balanceScheme: null },
	"minimax-cn": { providerFamily: "minimax", accountAdapter: "minimax-token-plan", balanceScheme: null },
	"minimax-coding": { providerFamily: "minimax", accountAdapter: "minimax-token-plan", balanceScheme: null },
	orcarouter: { providerFamily: "orcarouter", accountAdapter: "orcarouter-balance", pricingFamily: "unknown", balanceScheme: "orcarouter" },
	passion: { providerFamily: "sub2api", accountAdapter: "sub2api", pricingFamily: "unknown", balanceScheme: null },
	// dsh-codearts-auth 注册的 12 条反代 route（provider id = 该插件的产品 id）。
	// ⚠️ 这份名单必须与 CreditBalanceService.supportedProviders() 同步；服务在时
	// usage-stats 以服务返回的清单为准（见 accounts.js 的 specs()），这里只负责
	// 「路由 id → adapter」的分类，使 providerViews 能给出 official 出处。
	codearts: { providerFamily: "codearts", accountAdapter: "codearts-credits", balanceScheme: null },
	buddy: { providerFamily: "codearts", accountAdapter: "codearts-credits", balanceScheme: null },
	workbuddy: { providerFamily: "codearts", accountAdapter: "codearts-credits", balanceScheme: null },
	lobsterai: { providerFamily: "codearts", accountAdapter: "codearts-credits", balanceScheme: null },
	qoder: { providerFamily: "codearts", accountAdapter: "codearts-credits", balanceScheme: null },
	qodercn: { providerFamily: "codearts", accountAdapter: "codearts-credits", balanceScheme: null },
	trae: { providerFamily: "codearts", accountAdapter: "codearts-credits", balanceScheme: null },
	cline: { providerFamily: "codearts", accountAdapter: "codearts-credits", balanceScheme: null },
	loomy: { providerFamily: "codearts", accountAdapter: "codearts-credits", balanceScheme: null },
	raccoon: { providerFamily: "codearts", accountAdapter: "codearts-credits", balanceScheme: null },
	zcode: { providerFamily: "codearts", accountAdapter: "codearts-credits", balanceScheme: null },
	minimax: { providerFamily: "minimax", accountAdapter: "codearts-credits", balanceScheme: null }
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
	if (hostname === "api.orcarouter.ai") return { providerFamily: "orcarouter", accountAdapter: "orcarouter-balance", pricingFamily: "unknown" };
	if (hostname === "passionapi.com" || hostname.endsWith(".passionapi.com")) return { providerFamily: "sub2api", accountAdapter: "sub2api", pricingFamily: "unknown" };
	if (hostname === "ollama.com" || hostname.endsWith(".ollama.com")) return { providerFamily: "ollama", accountAdapter: "ollama" };
	return null;
}

/**
 * 两个插件都注册的 route id：归属取决于该路线有没有自带 API Key。
 *
 * `minimax` 这条 id 被 dsh 内置的 llm-pi-ai 与 dsh-codearts-auth 同时注册：
 *  - 用户在 llm-pi-ai 里显式配了 `apiKeyEnv` / `baseURL` → 那是真的 Key 路线，
 *    判给 `minimax-token-plan`（走 /v1/token_plan/remains）；
 *  - 什么凭据都没有，只有 codearts 账号池里的 AK/SK → 判给 `codearts-credits`
 *    （进程内读 `credit/details`），否则这张卡永远 not-configured。
 *
 * ⚠️ 早先用 CANONICAL_ROUTES 静态判给其中一侧，两种配置都会错一份。
 */
const MINIMAX_ROUTE_IDS = new Set(["minimax"]);

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

	// `minimax` 在两个插件里都注册过，静态表无法表达「按凭据归属」，
	// 故在查静态表之前先单独判定。显式 monitor 仍在此之上（见上）。
	if (MINIMAX_ROUTE_IDS.has(routeId)) {
		const hasApiKey = nonEmptyString(provider?.apiKeyEnv) !== null || nonEmptyString(provider?.baseURL) !== null;
		return hasApiKey
			? buildProviderIdentity(provider, CANONICAL_ROUTES["minimaxi"], "canonical-id")
			: buildProviderIdentity(provider, { providerFamily: "codearts", accountAdapter: "codearts-credits", balanceScheme: null }, "codearts-relay");
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
