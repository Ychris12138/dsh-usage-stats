import assert from "node:assert/strict";

import { resolveProviderIdentity } from "../lib/provider-identity.js";
import {
	DEEPSEEK_PRICING_RULES,
	estimateTokenCost,
	matchPricingRule,
	resolveUnitPricing,
	validatePricingRules
} from "../lib/pricing.js";

function provider(id, baseURL, displayName = id) {
	return { id, displayName, ...(baseURL === void 0 ? {} : { baseURL }) };
}

function tokenBuckets(overrides = {}) {
	return {
		inputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		outputTokens: 0,
		...overrides
	};
}

const official = resolveProviderIdentity(provider("deepseek-official", "https://api.deepseek.com"));
const canonicalOfficialHost = resolveProviderIdentity(provider("deepseek", "https://api.deepseek.com"));
const officialPath = resolveProviderIdentity(provider("deepseek-official", "https://api.deepseek.com/anthropic"));
const canonicalCustomRelay = resolveProviderIdentity(provider("deepseek", "https://relay.invalid/v1"));
const officialCustomRelay = resolveProviderIdentity(provider("deepseek-official", "https://relay.invalid/v1"));
const malformedCanonical = resolveProviderIdentity(provider("deepseek", "not-a-url"));
const canonicalWithoutBaseURL = resolveProviderIdentity(provider("deepseek"));
const arbitraryWithoutBaseURL = resolveProviderIdentity(provider("arbitrary-route"));
const officialHost = resolveProviderIdentity(provider("direct-deepseek", "https://api.deepseek.com/v1"));
const openrouter = resolveProviderIdentity(provider("openrouter", "https://openrouter.ai/api/v1"));
const customRelay = resolveProviderIdentity(provider("relay-a", "https://relay.example.com/v1", "DeepSeek"));

function estimate({
	identity = official,
	model = "deepseek-v4-flash",
	timestamp = "2026-08-15T00:00:00.000Z",
	currency = "USD",
	buckets = tokenBuckets({ inputTokens: 1_000_000 })
} = {}, rules = DEEPSEEK_PRICING_RULES) {
	return estimateTokenCost({ identity, model, timestamp, currency, buckets }, rules);
}

function tariff(timestamp, model = "deepseek-v4-flash") {
	return estimate({ timestamp, model }).tariff;
}

function closeTo(actual, expected, label) {
	assert.ok(Math.abs(actual - expected) < 1e-12, `${label}: expected ${expected}, got ${actual}`);
}

assert.equal(validatePricingRules(DEEPSEEK_PRICING_RULES), DEEPSEEK_PRICING_RULES);
assert.equal(DEEPSEEK_PRICING_RULES.length, 6, "two exact models × three historical phases");
console.log("DeepSeek pricing catalog validates ok");

{
	const flash = estimate({ model: "deepseek-v4-flash", timestamp: "2026-08-16T15:59:59.999Z" });
	const pro = estimate({ model: "deepseek-v4-pro", timestamp: "2026-08-16T15:59:59.999Z" });
	assert.equal(flash.tariff, "flat");
	assert.equal(flash.ruleId, "deepseek-v4-flash-usd-flat-before-2026-08-16");
	assert.equal(flash.amount, 0.14);
	assert.equal(pro.tariff, "flat");
	assert.equal(pro.ruleId, "deepseek-v4-pro-usd-flat-before-2026-08-16");
	assert.equal(pro.amount, 0.435);
	assert.deepEqual(flash.source, {
		kind: "official",
		provider: "deepseek",
		url: "https://api-docs.deepseek.com/quick_start/pricing/"
	});
	assert.equal(flash.updatedAt, "2026-08-23T00:00:00.000Z");
	console.log("old flat Flash/Pro rules and source metadata ok");
}

{
	const before = matchPricingRule({ identity: official, model: "deepseek-v4-flash", timestamp: "2026-08-16T15:59:59.999Z", currency: "USD" });
	const at = matchPricingRule({ identity: official, model: "deepseek-v4-flash", timestamp: "2026-08-16T16:00:00.000Z", currency: "USD" });
	assert.equal(before.id, "deepseek-v4-flash-usd-flat-before-2026-08-16");
	assert.equal(at.id, "deepseek-v4-flash-usd-time-band-v1");
	assert.equal(tariff("2026-08-17T01:00:00.000Z"), "peak", "Rule B weekday 09:00 Shanghai");
	assert.equal(tariff("2026-08-17T04:00:00.000Z"), "offPeak", "Rule B weekday 12:00 Shanghai");
	assert.equal(tariff("2026-08-22T01:00:00.000Z"), "peak", "Rule B weekend peak-clock remains peak");
	console.log("Rule A/B boundary and time-band-v1 weekend behavior ok");
}

{
	const before = matchPricingRule({ identity: official, model: "deepseek-v4-pro", timestamp: "2026-08-22T15:59:59.999Z", currency: "USD" });
	const at = matchPricingRule({ identity: official, model: "deepseek-v4-pro", timestamp: "2026-08-22T16:00:00.000Z", currency: "USD" });
	assert.equal(before.id, "deepseek-v4-pro-usd-time-band-v1");
	assert.equal(at.id, "deepseek-v4-pro-usd-weekday-schedule");
	assert.equal(tariff("2026-08-24T01:00:00.000Z", "deepseek-v4-pro"), "peak");
	assert.equal(tariff("2026-08-24T04:00:00.000Z", "deepseek-v4-pro"), "offPeak");
	assert.equal(tariff("2026-08-29T01:00:00.000Z", "deepseek-v4-pro"), "offPeak", "Rule C Saturday is all off-peak");
	assert.equal(tariff("2026-08-30T01:00:00.000Z", "deepseek-v4-pro"), "offPeak", "Rule C Sunday is all off-peak");
	console.log("Rule B/C boundary and weekday-only schedule ok");
}

{
	const cases = [
		["2026-08-24T00:59:59.000Z", "offPeak", "08:59:59"],
		["2026-08-24T01:00:00.000Z", "peak", "09:00:00"],
		["2026-08-24T03:59:59.000Z", "peak", "11:59:59"],
		["2026-08-24T04:00:00.000Z", "offPeak", "12:00:00"],
		["2026-08-24T05:59:59.000Z", "offPeak", "13:59:59"],
		["2026-08-24T06:00:00.000Z", "peak", "14:00:00"],
		["2026-08-24T09:59:59.000Z", "peak", "17:59:59"],
		["2026-08-24T10:00:00.000Z", "offPeak", "18:00:00"]
	];
	for (const [timestamp, expected, clock] of cases) assert.equal(tariff(timestamp), expected, `${clock} Shanghai boundary`);
	console.log("half-open 09/12/14/18 Shanghai clock boundaries ok");
}

{
	const template = DEEPSEEK_PRICING_RULES.find((rule) => rule.id === "deepseek-v4-flash-usd-weekday-schedule");
	const midnightRule = (peakDays) => ({
		...template,
		id: `timezone-regression-${peakDays.join("-")}`,
		effectiveFrom: null,
		schedule: {
			...template.schedule,
			peakDays,
			peakWindows: [["00:00", "01:00"]]
		}
	});
	assert.equal(resolveUnitPricing(midnightRule([6]), "2026-08-28T16:30:00.000Z").tariff, "peak", "UTC Friday is Shanghai Saturday");
	assert.equal(resolveUnitPricing(midnightRule([1]), "2026-08-30T16:30:00.000Z").tariff, "peak", "UTC Sunday is Shanghai Monday");
	console.log("Asia/Shanghai weekday derivation is independent of UTC/local timezone ok");
}

{
	const input = estimate({ buckets: tokenBuckets({ inputTokens: 1_000_000 }) });
	const cacheRead = estimate({ buckets: tokenBuckets({ cacheReadTokens: 1_000_000 }) });
	const output = estimate({ buckets: tokenBuckets({ outputTokens: 1_000_000 }) });
	const combined = estimate({ buckets: tokenBuckets({ inputTokens: 2_000_000, cacheReadTokens: 3_000_000, outputTokens: 500_000 }) });
	assert.deepEqual(input.components, { input: 0.14, cacheRead: 0, cacheWrite: 0, output: 0 });
	assert.deepEqual(cacheRead.components, { input: 0, cacheRead: 0.0028, cacheWrite: 0, output: 0 });
	assert.deepEqual(output.components, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0.28 });
	closeTo(combined.components.input, 0.28, "combined input");
	closeTo(combined.components.cacheRead, 0.0084, "combined cache read");
	closeTo(combined.components.output, 0.14, "combined output");
	closeTo(combined.amount, 0.4284, "combined amount");
	assert.equal(estimate({ buckets: tokenBuckets({ cacheWriteTokens: 1 }) }), null, "positive cacheWrite with unknown price invalidates whole estimate");
	assert.equal(estimate({ buckets: tokenBuckets() }).amount, 0, "a matched rule with zero usage has a known zero amount");
	console.log("input/cacheRead/output components and cacheWrite fail-closed policy ok");
}

{
	assert.notEqual(estimate({ identity: official, model: "deepseek-v4-pro" }), null, "official DeepSeek route is priced");
	assert.notEqual(estimate({ identity: canonicalOfficialHost, model: "deepseek-v4-pro" }), null, "canonical DeepSeek id on api.deepseek.com is priced");
	assert.notEqual(estimate({ identity: officialPath, model: "deepseek-v4-pro" }), null, "official DeepSeek path on api.deepseek.com is priced");
	assert.equal(estimate({ identity: canonicalCustomRelay, model: "deepseek-v4-pro" }), null, "canonical DeepSeek id must not override a custom relay");
	assert.equal(estimate({ identity: officialCustomRelay, model: "deepseek-v4-pro" }), null, "deepseek-official id must not override a custom relay");
	assert.equal(estimate({ identity: malformedCanonical, model: "deepseek-v4-pro" }), null, "canonical DeepSeek id with a malformed explicit baseURL is unpriced");
	assert.notEqual(estimate({ identity: canonicalWithoutBaseURL, model: "deepseek-v4-pro" }), null, "canonical DeepSeek id without a baseURL remains priced");
	assert.equal(estimate({ identity: arbitraryWithoutBaseURL, model: "deepseek-v4-pro" }), null, "arbitrary route without a baseURL is unpriced");
	assert.notEqual(estimate({ identity: officialHost, model: "deepseek-v4-pro" }), null, "resolver-confirmed api.deepseek.com route is priced");
	const explicitOfficialHost = resolveProviderIdentity(provider("deepseek-official", "https://api.deepseek.com"), {
		monitors: { "deepseek-official": { adapter: "deepseek-balance" } }
	});
	assert.notEqual(estimate({ identity: explicitOfficialHost, model: "deepseek-v4-pro" }), null, "an explicit official adapter on api.deepseek.com remains eligible");
	assert.equal(estimate({ identity: openrouter, model: "deepseek-v4-pro" }), null, "OpenRouter must not inherit DeepSeek official pricing");
	assert.equal(estimate({ identity: customRelay, model: "deepseek-v4-pro" }), null, "custom relay must remain unpriced");
	const explicitGateway = resolveProviderIdentity(provider("deepseek-official", "https://api.deepseek.com"), {
		monitors: { "deepseek-official": { adapter: "new-api" } }
	});
	assert.equal(estimate({ identity: explicitGateway, model: "deepseek-v4-pro" }), null, "explicit gateway identity must override canonical id pricing");
	console.log("official-route eligibility and cross-provider isolation ok");
}

{
	for (const model of [
		"unknown-model",
		"deepseek-v4-flash-anything",
		"deepseek-v4-flash-vision-exp",
		"z-ai/glm-5",
		"z-ai/glm-5.2"
	]) assert.equal(estimate({ model }), null, `${model} must remain unpriced without an exact rule`);
	assert.equal(estimate({ currency: "CNY" }), null);
	assert.equal(estimate({ currency: "usd" }), null);
	assert.equal(estimate({ timestamp: "not-a-date" }), null);
	assert.equal(estimate({ timestamp: "2026-08-24T09:00:00" }), null, "offset-less timestamps must not depend on the machine timezone");
	assert.equal(estimate({ buckets: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0 } }), null, "missing bucket data must not be undercounted");
	console.log("unknown model/currency/timestamp/buckets fail closed to null ok");
}

{
	const template = DEEPSEEK_PRICING_RULES[0];
	const exactRule = { ...template, id: "exact-zai-model", modelMatcher: { type: "exact", model: "z-ai/glm-5" } };
	assert.notEqual(matchPricingRule({ identity: official, model: "z-ai/glm-5", timestamp: "2026-08-01T00:00:00Z", currency: "USD" }, [exactRule]), null);
	assert.equal(matchPricingRule({ identity: official, model: "z-ai/glm-5.2", timestamp: "2026-08-01T00:00:00Z", currency: "USD" }, [exactRule]), null);
	assert.throws(() => validatePricingRules([{ ...exactRule, modelMatcher: { type: "prefix", model: "z-ai/glm-5" } }]), /exact model identity/);
	assert.throws(() => validatePricingRules([template, { ...template, id: "overlapping-rule" }]), /overlapping pricing rules/);
	assert.throws(() => validatePricingRules([{ ...template, effectiveFrom: "2026-08-01T00:00:00" }]), /invalid pricing effective boundary/);
	console.log("exact matcher and ambiguous-rule validation ok");
}

{
	const template = DEEPSEEK_PRICING_RULES[0];
	const freeRule = {
		...template,
		id: "explicit-free-rule",
		pricing: { flat: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } }
	};
	assert.equal(estimate({ buckets: tokenBuckets({ inputTokens: 123, cacheWriteTokens: 456 }) }, [freeRule]).amount, 0, "an explicit zero price may produce zero cost");
	const first = estimate({ model: "deepseek-v4-pro", timestamp: "2026-08-24T01:30:00Z", buckets: tokenBuckets({ inputTokens: 123456, cacheReadTokens: 654321, outputTokens: 111111 }) });
	const second = estimate({ model: "deepseek-v4-pro", timestamp: "2026-08-24T01:30:00Z", buckets: tokenBuckets({ inputTokens: 123456, cacheReadTokens: 654321, outputTokens: 111111 }) });
	assert.deepEqual(second, first, "historical recomputation must be deterministic");
	console.log("explicit free pricing and deterministic recomputation ok");
}

console.log("PRICING ENGINE TESTS PASSED");
