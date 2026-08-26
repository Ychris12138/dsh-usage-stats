import assert from "node:assert/strict";

import {
	applyCostSample,
	budgetLevel,
	changedProviderPricingRoutes,
	costSampleOf,
	createCostAccumulator,
	createUsageCostEstimator,
	parseCostAccumulator,
	pricingFingerprint,
	providerPricingIdentityProjection,
	renderBudgetSummary,
	renderCost,
	serializeCostAccumulator,
	validateBudgetConfig
} from "../lib/billing.js";
import {
	applyUsageDelta,
	createUsageState,
	mergeBillingInto,
	mergeInto,
	renderSessionUsage,
	renderUsage
} from "../lib/usage.js";

const official = { id: "deepseek-official", displayName: "DeepSeek", baseURL: "https://api.deepseek.com" };
const openrouter = { id: "openrouter", displayName: "OpenRouter", baseURL: "https://openrouter.ai/api/v1" };
const customRelay = { id: "deepseek", displayName: "Corporate Relay", baseURL: "https://relay.invalid/v1" };
const estimator = createUsageCostEstimator([official, openrouter, customRelay]);
assert.match(pricingFingerprint(), /providerIdentityPolicy/, "derived-cost cache identity must include provider classification policy");

{
	const routeOfficial = { id: "route-a", displayName: "Route A", baseURL: "https://api.deepseek.com/v1" };
	const routeCustom = { ...routeOfficial, baseURL: "https://relay.invalid/v1" };
	const stableA = pricingFingerprint({ providers: [routeOfficial, openrouter] });
	const stableB = pricingFingerprint({ providers: [openrouter, { ...routeOfficial }] });
	const custom = pricingFingerprint({ providers: [routeCustom, openrouter] });
	assert.equal(stableA, stableB, "provider pricing identity order and object identity must not affect the fingerprint");
	assert.deepEqual(changedProviderPricingRoutes(stableA, stableB), []);
	assert.deepEqual(changedProviderPricingRoutes(stableA, custom), ["route-a"], "official to custom must change the affected route identity");
	assert.deepEqual(changedProviderPricingRoutes(custom, stableA), ["route-a"], "custom to official must change the affected route identity");
	assert.equal(changedProviderPricingRoutes("legacy-catalog-only", stableA), null, "unprovable old identity must request a global fail-closed transition");
	assert.deepEqual(providerPricingIdentityProjection([routeOfficial]), [{
		routeId: "route-a",
		providerFamily: "deepseek",
		pricingFamily: "deepseek",
		confidence: "canonical-host",
		baseURL: { state: "hostname", hostname: "api.deepseek.com" }
	}]);
	assert.equal(providerPricingIdentityProjection([{ id: "deepseek" }])[0].baseURL.state, "absent");
	assert.equal(providerPricingIdentityProjection([{ id: "deepseek", baseURL: "not a URL" }])[0].baseURL.state, "malformed");
	const credentialURLFingerprint = pricingFingerprint({
		providers: [{ ...routeOfficial, baseURL: "https://username:password@api.deepseek.com/v1?token=secret" }]
	});
	assert.doesNotMatch(credentialURLFingerprint, /username|password|token=|secret/i, "fingerprint must retain only the normalized hostname, never URL credentials/query data");
	console.log("runtime provider pricing fingerprint is deterministic and secret-free");
}

const buckets = (inputTokens, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0) => ({
	inputTokens,
	outputTokens,
	cacheReadTokens,
	cacheWriteTokens
});

function request(seq, time, providerId, model) {
	return {
		seq,
		time,
		type: "request/header",
		data: { header: { config: { provider: providerId, model } } }
	};
}

function usage(seq, time, turn, step, providerId, model, value, type = "assistant/message") {
	if (type === "assistant/chunk") {
		return {
			seq,
			time,
			type,
			data: { turn, step, chunk: { type: "usage", usage: value } }
		};
	}
	return {
		seq,
		time,
		type,
		data: { turn, step, usage: value, message: { source: { provider: providerId, model } } }
	};
}

const ruleA = Date.parse("2026-08-15T02:00:00Z");
const ruleB = Date.parse("2026-08-20T02:00:00Z");
const ruleC = Date.parse("2026-08-24T02:00:00Z");

{
	assert.notEqual(estimator({ providerId: "deepseek-official", model: "deepseek-v4-pro", timestamp: ruleC, buckets: buckets(1_000_000) }), null);
	assert.equal(estimator({ providerId: "openrouter", model: "deepseek-v4-pro", timestamp: ruleC, buckets: buckets(1_000_000) }), null);
	assert.equal(estimator({ providerId: "deepseek", model: "deepseek-v4-pro", timestamp: ruleC, buckets: buckets(1_000_000) }), null);
	assert.equal(estimator({ providerId: "unknown", model: "deepseek-v4-pro", timestamp: ruleC, buckets: buckets(1_000_000) }), null);
	assert.equal(estimator({ providerId: "deepseek-official", model: "unknown-model", timestamp: ruleC, buckets: buckets(1_000_000) }), null);
	assert.equal(estimator({ providerId: "deepseek-official", model: "deepseek-v4-pro", timestamp: ruleC, buckets: buckets(0, 0, 0, 1) }), null);
	console.log("official DeepSeek pricing and unpriced route/cache-write safety ok");
}

{
	const state = createUsageState();
	applyUsageDelta(state, [
		request(0, ruleA, "deepseek-official", "deepseek-v4-pro"),
		usage(1, ruleA, 1, 0, "deepseek-official", "deepseek-v4-pro", buckets(1_000_000)),
		usage(2, ruleB, 2, 0, "deepseek-official", "deepseek-v4-pro", buckets(1_000_000)),
		usage(3, ruleC, 3, 0, "deepseek-official", "deepseek-v4-pro", buckets(1_000_000))
	], { estimateCost: estimator });
	const rendered = renderSessionUsage("historical", state);
	assert.deepEqual(rendered.pricing.ruleIds, [
		"deepseek-v4-pro-usd-flat-before-2026-08-16",
		"deepseek-v4-pro-usd-time-band-v1",
		"deepseek-v4-pro-usd-weekday-schedule"
	]);
	assert.equal(rendered.costComplete, true);
	console.log("Rule A/B/C event-time pricing provenance ok");
}

{
	const peakAt = Date.parse("2026-08-24T02:00:00Z");
	const offPeakAt = Date.parse("2026-08-24T05:00:00Z");
	const state = createUsageState();
	applyUsageDelta(state, [
		usage(1, peakAt, 1, 0, "deepseek-official", "deepseek-v4-pro", buckets(1_000_000)),
		usage(2, offPeakAt, 2, 0, "deepseek-official", "deepseek-v4-pro", buckets(1_000_000))
	], { estimateCost: estimator });
	const peak = estimator({ providerId: "deepseek-official", model: "deepseek-v4-pro", timestamp: peakAt, buckets: buckets(1_000_000) });
	const offPeak = estimator({ providerId: "deepseek-official", model: "deepseek-v4-pro", timestamp: offPeakAt, buckets: buckets(1_000_000) });
	assert.equal(peak.tariff, "peak");
	assert.equal(offPeak.tariff, "offPeak");
	assert.equal(renderSessionUsage("time-bands", state).estimatedCost, peak.amount + offPeak.amount,
		"a session spanning price bands must add event-time estimates, not reprice cumulative tokens");
	console.log("same-rule peak/offPeak session pricing ok");
}

{
	const state = createUsageState();
	const first = buckets(1_000_000);
	const replacement = buckets(2_000_000, 100_000);
	applyUsageDelta(state, [
		request(0, ruleA, "deepseek-official", "deepseek-v4-pro"),
		usage(1, ruleA, 1, 0, "deepseek-official", "deepseek-v4-pro", first, "assistant/chunk")
	], { estimateCost: estimator });
	const originalCost = renderSessionUsage("replace", state).estimatedCost;
	applyUsageDelta(state, [
		usage(2, ruleC, 1, 0, "deepseek-official", "deepseek-v4-pro", replacement)
	], { estimateCost: estimator });
	const rendered = renderSessionUsage("replace", state);
	const expected = estimator({ providerId: "deepseek-official", model: "deepseek-v4-pro", timestamp: ruleC, buckets: replacement });
	assert.notEqual(originalCost, expected.amount, "fixture must cross a historical/tariff boundary");
	assert.equal(rendered.estimatedCost, expected.amount, "replacement must subtract the old monetary contribution before adding the new one");
	assert.equal(rendered.tokens, 2_100_000);
	assert.equal(rendered.firstAt, new Date(ruleC).toISOString(), "a sole sample replacement must move the session boundary time");
	assert.deepEqual(rendered.pricing.ruleIds, [expected.ruleId]);
	const byDay = new Map();
	const billingByDay = new Map();
	mergeInto(byDay, state.days);
	mergeBillingInto(billingByDay, state.billing.days);
	const days = renderUsage(byDay, ruleC + 1, billingByDay).days;
	assert.equal(days.find((day) => day.date === "2026-08-15").tokens, 0);
	assert.equal(days.find((day) => day.date === "2026-08-15").estimatedCost, null);
	assert.equal(days.find((day) => day.date === "2026-08-24").estimatedCost, expected.amount);
	console.log("cross-day/tariff replace-last-sample billing semantics ok");
}

{
	const state = createUsageState();
	applyUsageDelta(state, [
		usage(1, ruleC, 1, 0, "deepseek-official", "deepseek-v4-pro", buckets(1_000_000)),
		usage(2, ruleC + 1, 2, 0, "openrouter", "deepseek-v4-pro", buckets(1_000_000))
	], { estimateCost: estimator });
	const rendered = renderSessionUsage("partial", state);
	assert.equal(rendered.tokens, 2_000_000);
	assert.equal(rendered.estimatedCost, null);
	assert.equal(rendered.currency, null);
	assert.equal(rendered.costComplete, false, "one unpriced sample must invalidate the whole session estimate");
	console.log("priced + unpriced session fails closed without partial cost");
}

{
	const mixed = createUsageState();
	const mixedEstimator = ({ providerId }) => ({
		amount: 1,
		currency: providerId === "usd" ? "USD" : "CNY",
		ruleId: `rule-${providerId}`,
		source: { kind: "official", provider: providerId, url: `https://${providerId}.invalid/pricing` },
		updatedAt: "2026-08-25T00:00:00.000Z"
	});
	applyUsageDelta(mixed, [
		usage(1, ruleC, 1, 0, "usd", "model", buckets(1)),
		usage(2, ruleC + 1, 2, 0, "cny", "model", buckets(1))
	], { estimateCost: mixedEstimator });
	assert.deepEqual(renderSessionUsage("mixed", mixed), {
		sessionId: "mixed",
		title: null,
		providers: ["cny", "usd"],
		models: ["cny/model", "usd/model"],
		inputTokens: 2,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		tokens: 2,
		estimatedCost: null,
		currency: null,
		costComplete: false,
		pricing: { ruleIds: ["rule-cny", "rule-usd"], source: null, updatedAt: "2026-08-25T00:00:00.000Z" },
		firstAt: new Date(ruleC).toISOString(),
		lastAt: new Date(ruleC + 1).toISOString()
	});
	console.log("mixed currencies are never silently summed");
}

{
	assert.deepEqual(validateBudgetConfig(), { currency: "USD", daily: null, monthly: null });
	assert.deepEqual(validateBudgetConfig({ currency: "CNY", daily: 5, monthly: 100 }), { currency: "CNY", daily: 5, monthly: 100 });
	for (const invalid of [
		{ currency: "usd" },
		{ currency: "USDT" },
		{ daily: 0 },
		{ daily: -1 },
		{ monthly: Infinity }
	]) assert.throws(() => validateBudgetConfig(invalid), /budgets/);
	assert.equal(budgetLevel(79.999), "normal");
	assert.equal(budgetLevel(80), "warning");
	assert.equal(budgetLevel(99.999), "warning");
	assert.equal(budgetLevel(100), "critical");

	const at = new Date(2026, 7, 25, 12).getTime();
	const key = `${new Date(at).getFullYear()}-${String(new Date(at).getMonth() + 1).padStart(2, "0")}-${String(new Date(at).getDate()).padStart(2, "0")}`;
	const dayCosts = new Map([[key, { total: createCostAccumulator(), models: new Map() }]]);
	applyCostSample(dayCosts.get(key).total, costSampleOf({ amount: 8, currency: "USD", ruleId: "r", source: null, updatedAt: null }, buckets(1)));
	const sameMonth = `${key.slice(0, 8)}01`;
	const previousMonth = `${key.slice(0, 5)}${String(Number(key.slice(5, 7)) - 1).padStart(2, "0")}-28`;
	dayCosts.set(sameMonth, { total: createCostAccumulator(), models: new Map() });
	dayCosts.set(previousMonth, { total: createCostAccumulator(), models: new Map() });
	applyCostSample(dayCosts.get(sameMonth).total, costSampleOf({ amount: 1, currency: "USD", ruleId: "r", source: null, updatedAt: null }, buckets(1)));
	applyCostSample(dayCosts.get(previousMonth).total, costSampleOf({ amount: 100, currency: "USD", ruleId: "r", source: null, updatedAt: null }, buckets(1)));
	let summary = renderBudgetSummary(dayCosts, validateBudgetConfig({ daily: 10, monthly: 10 }), at);
	assert.equal(summary.daily.level, "warning");
	assert.equal(summary.monthly.level, "warning");
	assert.equal(summary.daily.estimatedSpend, 8);
	assert.equal(summary.monthly.estimatedSpend, 9, "monthly spend must include the current month and exclude earlier months");
	applyCostSample(dayCosts.get(key).total, costSampleOf({ amount: 2, currency: "USD", ruleId: "r", source: null, updatedAt: null }, buckets(1)));
	summary = renderBudgetSummary(dayCosts, validateBudgetConfig({ daily: 10, monthly: 10 }), at);
	assert.equal(summary.daily.level, "critical");
	assert.equal(summary.monthly.level, "critical");
	const incompatible = renderBudgetSummary(dayCosts, validateBudgetConfig({ currency: "CNY", daily: 10, monthly: 10 }), at);
	assert.equal(incompatible.daily.level, "unknown");
	assert.equal(incompatible.daily.estimatedSpend, null);
	applyCostSample(dayCosts.get(key).total, costSampleOf(null, buckets(1)));
	const incomplete = renderBudgetSummary(dayCosts, validateBudgetConfig({ daily: 10, monthly: 10 }), at);
	assert.equal(incomplete.daily.level, "unknown");
	assert.equal(incomplete.monthly.costComplete, false);
	console.log("budget validation and 80/100 percent boundaries ok");
}

{
	const states = [createUsageState(), createUsageState()];
	let estimates = 0;
	const countingEstimator = (input) => {
		estimates += 1;
		return estimator(input);
	};
	applyUsageDelta(states[0], [usage(1, ruleC, 1, 0, "deepseek-official", "deepseek-v4-pro", buckets(10, 2, 3))], { estimateCost: countingEstimator });
	applyUsageDelta(states[1], [usage(1, ruleC + 1, 1, 0, "deepseek-official", "deepseek-v4-pro", buckets(20, 4, 6))], { estimateCost: countingEstimator });
	applyUsageDelta(states[1], [], { estimateCost: countingEstimator });
	assert.equal(estimates, 2, "steady state must price only new usage samples");
	const byDay = new Map();
	const billingByDay = new Map();
	for (const state of states) {
		mergeInto(byDay, state.days);
		mergeBillingInto(billingByDay, state.billing.days);
	}
	const global = renderUsage(byDay, ruleC + 2, billingByDay);
	const sessions = states.map((state, index) => renderSessionUsage(`s${index}`, state));
	assert.equal(global.total.tokens, sessions.reduce((sum, session) => sum + session.tokens, 0));
	assert.deepEqual({
		inputTokens: global.total.inputTokens,
		outputTokens: global.total.outputTokens,
		cacheReadTokens: global.total.cacheReadTokens,
		cacheWriteTokens: global.total.cacheWriteTokens,
		tokens: global.total.tokens
	}, { inputTokens: 30, outputTokens: 6, cacheReadTokens: 9, cacheWriteTokens: 0, tokens: 45 }, "billing derivation must not change legacy token totals");
	assert.equal(global.days[0].models[0].tokens, 45);
	const restored = parseCostAccumulator(serializeCostAccumulator(states[0].billing.total));
	assert.deepEqual(renderCost(restored), renderCost(states[0].billing.total));
	console.log("session/global reconciliation, unchanged token aggregation, O(new), and cache round-trip ok");
}

console.log("BILLING + BUDGET TESTS PASSED");
