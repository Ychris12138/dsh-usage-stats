/**
 * Pure billing derivation over provider-reported usage samples.
 *
 * Token accounting remains owned by usage.js/DSH. This module only carries
 * monetary contributions produced by pricing.js, their provenance, and
 * fail-closed budget state.
 *
 * @module dsh-usage-stats/billing
 */

import { estimateTokenCost, PRICING_RULES } from "./pricing.js";
import { PROVIDER_IDENTITY_POLICY_VERSION, resolveProviderIdentity } from "./provider-identity.js";

const ISO_CURRENCY = /^[A-Z]{3}$/;

export const DEFAULT_BUDGET_CONFIG = Object.freeze({
	currency: "USD",
	daily: null,
	monthly: null
});

function optionalLimit(value, label) {
	if (value === void 0 || value === null) return null;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${label} must be a positive finite number or null`);
	}
	return value;
}

/** Validate the public, secret-free daily/monthly budget configuration. */
export function validateBudgetConfig(raw = {}) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("budgets must be an object");
	const currency = raw.currency ?? DEFAULT_BUDGET_CONFIG.currency;
	if (typeof currency !== "string" || !ISO_CURRENCY.test(currency)) throw new Error("budgets.currency must be an uppercase three-letter currency code");
	return {
		currency,
		daily: optionalLimit(raw.daily, "budgets.daily"),
		monthly: optionalLimit(raw.monthly, "budgets.monthly")
	};
}

/** Exact pricing catalog + identity-policy fingerprint for cached costs. */
export function pricingFingerprint(rules = PRICING_RULES) {
	return JSON.stringify({ providerIdentityPolicy: PROVIDER_IDENTITY_POLICY_VERSION, rules });
}

/** Empty additive monetary accumulator. */
export function createCostAccumulator() {
	return {
		pricedSamples: 0,
		incompleteSamples: 0,
		currencies: new Map(),
		rules: new Map()
	};
}

function tokenCount(buckets) {
	if (buckets === null || typeof buckets !== "object") return 0;
	return ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]
		.reduce((sum, key) => sum + (typeof buckets[key] === "number" && Number.isFinite(buckets[key]) && buckets[key] > 0 ? buckets[key] : 0), 0);
}

function safeSource(source) {
	if (source === null || typeof source !== "object" || Array.isArray(source)) return null;
	const kind = typeof source.kind === "string" ? source.kind : null;
	const provider = typeof source.provider === "string" ? source.provider : null;
	const url = typeof source.url === "string" ? source.url : null;
	return kind === null || provider === null || url === null ? null : { kind, provider, url };
}

/**
 * Convert one pricing result into an additive contribution. Positive token
 * usage with no trustworthy estimate is explicitly incomplete.
 */
export function costSampleOf(estimate, buckets) {
	if (tokenCount(buckets) === 0) return { counted: false };
	if (estimate === null || typeof estimate !== "object"
		|| typeof estimate.amount !== "number" || !Number.isFinite(estimate.amount) || estimate.amount < 0
		|| typeof estimate.currency !== "string" || !ISO_CURRENCY.test(estimate.currency)) {
		return { counted: true, complete: false };
	}
	return {
		counted: true,
		complete: true,
		amount: estimate.amount,
		currency: estimate.currency,
		ruleId: typeof estimate.ruleId === "string" && estimate.ruleId !== "" ? estimate.ruleId : null,
		source: safeSource(estimate.source),
		updatedAt: typeof estimate.updatedAt === "string" ? estimate.updatedAt : null
	};
}

function adjustCount(map, key, amount, countDelta) {
	const previous = map.get(key) ?? { amount: 0, count: 0 };
	const next = { amount: previous.amount + amount, count: previous.count + countDelta };
	if (next.count <= 0) map.delete(key);
	else map.set(key, next);
}

/** Add (`direction=1`) or subtract (`direction=-1`) one cost contribution. */
export function applyCostSample(target, sample, direction = 1) {
	if (sample?.counted !== true) return target;
	if (direction !== 1 && direction !== -1) throw new Error("cost sample direction must be 1 or -1");
	if (sample.complete !== true) {
		target.incompleteSamples = Math.max(0, target.incompleteSamples + direction);
		return target;
	}
	target.pricedSamples = Math.max(0, target.pricedSamples + direction);
	adjustCount(target.currencies, sample.currency, direction * sample.amount, direction);
	if (sample.ruleId !== null) {
		const previous = target.rules.get(sample.ruleId) ?? { count: 0, source: sample.source, updatedAt: sample.updatedAt };
		const count = previous.count + direction;
		if (count <= 0) target.rules.delete(sample.ruleId);
		else target.rules.set(sample.ruleId, {
			count,
			source: previous.source ?? sample.source,
			updatedAt: previous.updatedAt ?? sample.updatedAt
		});
	}
	return target;
}

/** Merge one complete accumulator into another. */
export function mergeCostAccumulator(target, source) {
	target.pricedSamples += source.pricedSamples;
	target.incompleteSamples += source.incompleteSamples;
	for (const [currency, entry] of source.currencies) adjustCount(target.currencies, currency, entry.amount, entry.count);
	for (const [ruleId, entry] of source.rules) {
		const previous = target.rules.get(ruleId);
		target.rules.set(ruleId, previous === void 0 ? { ...entry } : {
			count: previous.count + entry.count,
			source: previous.source ?? entry.source,
			updatedAt: previous.updatedAt ?? entry.updatedAt
		});
	}
	return target;
}

function provenanceOf(accumulator) {
	const entries = [...accumulator.rules.entries()].filter(([, entry]) => entry.count > 0).sort(([a], [b]) => a.localeCompare(b));
	const sources = new Map();
	let updatedAt = null;
	for (const [, entry] of entries) {
		if (entry.source !== null) sources.set(JSON.stringify(entry.source), entry.source);
		if (typeof entry.updatedAt === "string" && (updatedAt === null || entry.updatedAt > updatedAt)) updatedAt = entry.updatedAt;
	}
	return {
		ruleIds: entries.map(([ruleId]) => ruleId),
		source: sources.size === 1 ? [...sources.values()][0] : null,
		updatedAt
	};
}

/** Render an accumulator; any unpriced sample or mixed currency fails closed. */
export function renderCost(accumulator) {
	const sampleCount = accumulator.pricedSamples + accumulator.incompleteSamples;
	const complete = sampleCount > 0 && accumulator.incompleteSamples === 0 && accumulator.currencies.size === 1;
	const [currency, currencyEntry] = complete ? [...accumulator.currencies.entries()][0] : [null, null];
	return {
		estimatedCost: complete ? currencyEntry.amount : null,
		currency,
		costComplete: complete,
		pricing: provenanceOf(accumulator)
	};
}

/** JSON-safe cost accumulator for the incremental cache. */
export function serializeCostAccumulator(accumulator) {
	return {
		pricedSamples: accumulator.pricedSamples,
		incompleteSamples: accumulator.incompleteSamples,
		currencies: Object.fromEntries([...accumulator.currencies].map(([currency, entry]) => [currency, { ...entry }])),
		rules: Object.fromEntries([...accumulator.rules].map(([ruleId, entry]) => [ruleId, { ...entry }]))
	};
}

/** Lenient cache restore; invalid fields degrade to an empty/incomplete-safe state. */
export function parseCostAccumulator(raw) {
	const accumulator = createCostAccumulator();
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return accumulator;
	accumulator.pricedSamples = Number.isSafeInteger(raw.pricedSamples) && raw.pricedSamples >= 0 ? raw.pricedSamples : 0;
	accumulator.incompleteSamples = Number.isSafeInteger(raw.incompleteSamples) && raw.incompleteSamples >= 0 ? raw.incompleteSamples : 0;
	for (const [currency, entry] of Object.entries(raw.currencies ?? {})) {
		if (!ISO_CURRENCY.test(currency) || entry === null || typeof entry !== "object"
			|| typeof entry.amount !== "number" || !Number.isFinite(entry.amount)
			|| !Number.isSafeInteger(entry.count) || entry.count <= 0) continue;
		accumulator.currencies.set(currency, { amount: entry.amount, count: entry.count });
	}
	for (const [ruleId, entry] of Object.entries(raw.rules ?? {})) {
		if (ruleId === "" || entry === null || typeof entry !== "object" || !Number.isSafeInteger(entry.count) || entry.count <= 0) continue;
		accumulator.rules.set(ruleId, {
			count: entry.count,
			source: safeSource(entry.source),
			updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null
		});
	}
	return accumulator;
}

/** Build the only provider-aware bridge from session route identity to pricing.js. */
export function createUsageCostEstimator(providers, config = { monitors: {} }, currency = "USD", rules = PRICING_RULES) {
	const byId = new Map((Array.isArray(providers) ? providers : []).map((provider) => [provider.id, provider]));
	return ({ providerId, model, timestamp, buckets }) => {
		const provider = byId.get(providerId) ?? { id: providerId, displayName: providerId };
		const identity = resolveProviderIdentity(provider, config);
		return estimateTokenCost({ identity, model, timestamp, currency, buckets }, rules);
	};
}

/** Budget threshold policy: 80% warns, 100% is critical. */
export function budgetLevel(percent) {
	if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0) return "unknown";
	if (percent >= 100) return "critical";
	if (percent >= 80) return "warning";
	return "normal";
}

function budgetWindow(limit, currency, accumulator) {
	const sampleCount = accumulator.pricedSamples + accumulator.incompleteSamples;
	const rendered = renderCost(accumulator);
	const knownEmpty = sampleCount === 0;
	const compatible = knownEmpty || rendered.costComplete && rendered.currency === currency;
	const estimatedSpend = compatible ? (knownEmpty ? 0 : rendered.estimatedCost) : null;
	const percent = limit === null || estimatedSpend === null ? null : estimatedSpend / limit * 100;
	return {
		limit,
		currency,
		estimatedSpend,
		percent,
		costComplete: compatible,
		level: limit === null ? "disabled" : budgetLevel(percent)
	};
}

function localDayKey(timeMs) {
	const date = new Date(timeMs);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Render current local-day and local-month budget state from day costs. */
export function renderBudgetSummary(dayCosts, config = DEFAULT_BUDGET_CONFIG, now = Date.now()) {
	const day = localDayKey(now);
	const month = day.slice(0, 7);
	const daily = dayCosts.get(day)?.total ?? createCostAccumulator();
	const monthly = createCostAccumulator();
	for (const [date, entry] of dayCosts) if (date.startsWith(month)) mergeCostAccumulator(monthly, entry.total);
	return {
		currency: config.currency,
		daily: budgetWindow(config.daily, config.currency, daily),
		monthly: budgetWindow(config.monthly, config.currency, monthly)
	};
}
