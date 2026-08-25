/**
 * Pure, provider-aware token pricing primitives.
 *
 * Pricing is derived from route identity, exact model id, event timestamp,
 * token buckets, and an immutable historical rule catalog. This module owns no
 * network access, timer, cache, UI, endpoint, or token aggregation state.
 *
 * @module dsh-usage-stats/pricing
 */

const TOKENS_PER_MILLION = 1_000_000;
const DEEPSEEK_PRICE_SOURCE = Object.freeze({
	kind: "official",
	provider: "deepseek",
	url: "https://api-docs.deepseek.com/quick_start/pricing/"
});
const CATALOG_UPDATED_AT = "2026-08-23T00:00:00.000Z";
const TIME_BAND_V1_FROM = "2026-08-16T16:00:00.000Z";
const WEEKDAY_SCHEDULE_FROM = "2026-08-22T16:00:00.000Z";
const SHANGHAI_TIME_BANDS = Object.freeze([
	Object.freeze(["09:00", "12:00"]),
	Object.freeze(["14:00", "18:00"])
]);
const BUCKET_COMPONENTS = Object.freeze([
	Object.freeze(["inputTokens", "input"]),
	Object.freeze(["cacheReadTokens", "cacheRead"]),
	Object.freeze(["cacheWriteTokens", "cacheWrite"]),
	Object.freeze(["outputTokens", "output"])
]);
const WEEKDAY_NUMBER = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 });

function exactModel(model) {
	return Object.freeze({ type: "exact", model });
}

function unitPrices({ input, cacheRead, cacheWrite = null, output }) {
	return Object.freeze({ input, cacheRead, cacheWrite, output });
}

function flatRule({ id, model, effectiveFrom = null, effectiveTo = null, prices }) {
	return Object.freeze({
		id,
		providerFamily: "deepseek",
		pricingFamily: "deepseek",
		modelMatcher: exactModel(model),
		effectiveFrom,
		effectiveTo,
		pricing: Object.freeze({ flat: unitPrices(prices) }),
		currency: "USD",
		schedule: null,
		source: DEEPSEEK_PRICE_SOURCE,
		updatedAt: CATALOG_UPDATED_AT
	});
}

function timeBandRule({ id, model, effectiveFrom, effectiveTo = null, peakDays, offPeak, peak }) {
	return Object.freeze({
		id,
		providerFamily: "deepseek",
		pricingFamily: "deepseek",
		modelMatcher: exactModel(model),
		effectiveFrom,
		effectiveTo,
		pricing: Object.freeze({
			offPeak: unitPrices(offPeak),
			peak: unitPrices(peak)
		}),
		currency: "USD",
		schedule: Object.freeze({
			timezone: "Asia/Shanghai",
			peakDays: Object.freeze([...peakDays]),
			peakWindows: SHANGHAI_TIME_BANDS,
			otherwise: "offPeak"
		}),
		source: DEEPSEEK_PRICE_SOURCE,
		updatedAt: CATALOG_UPDATED_AT
	});
}

/** Immutable first-party DeepSeek USD rule catalog (prices per 1M tokens). */
export const DEEPSEEK_PRICING_RULES = Object.freeze([
	flatRule({
		id: "deepseek-v4-flash-usd-flat-before-2026-08-16",
		model: "deepseek-v4-flash",
		effectiveTo: TIME_BAND_V1_FROM,
		prices: { cacheRead: 0.0028, input: 0.14, output: 0.28 }
	}),
	flatRule({
		id: "deepseek-v4-pro-usd-flat-before-2026-08-16",
		model: "deepseek-v4-pro",
		effectiveTo: TIME_BAND_V1_FROM,
		prices: { cacheRead: 0.003625, input: 0.435, output: 0.87 }
	}),
	timeBandRule({
		id: "deepseek-v4-flash-usd-time-band-v1",
		model: "deepseek-v4-flash",
		effectiveFrom: TIME_BAND_V1_FROM,
		effectiveTo: WEEKDAY_SCHEDULE_FROM,
		peakDays: [0, 1, 2, 3, 4, 5, 6],
		offPeak: { cacheRead: 0.007, input: 0.22, output: 0.66 },
		peak: { cacheRead: 0.014, input: 0.44, output: 1.32 }
	}),
	timeBandRule({
		id: "deepseek-v4-pro-usd-time-band-v1",
		model: "deepseek-v4-pro",
		effectiveFrom: TIME_BAND_V1_FROM,
		effectiveTo: WEEKDAY_SCHEDULE_FROM,
		peakDays: [0, 1, 2, 3, 4, 5, 6],
		offPeak: { cacheRead: 0.022, input: 0.66, output: 1.98 },
		peak: { cacheRead: 0.044, input: 1.32, output: 3.96 }
	}),
	timeBandRule({
		id: "deepseek-v4-flash-usd-weekday-schedule",
		model: "deepseek-v4-flash",
		effectiveFrom: WEEKDAY_SCHEDULE_FROM,
		peakDays: [1, 2, 3, 4, 5],
		offPeak: { cacheRead: 0.007, input: 0.22, output: 0.66 },
		peak: { cacheRead: 0.014, input: 0.44, output: 1.32 }
	}),
	timeBandRule({
		id: "deepseek-v4-pro-usd-weekday-schedule",
		model: "deepseek-v4-pro",
		effectiveFrom: WEEKDAY_SCHEDULE_FROM,
		peakDays: [1, 2, 3, 4, 5],
		offPeak: { cacheRead: 0.022, input: 0.66, output: 1.98 },
		peak: { cacheRead: 0.044, input: 1.32, output: 3.96 }
	})
]);

/** Alias reserved for future additive provider catalogs. */
export const PRICING_RULES = DEEPSEEK_PRICING_RULES;

function nonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function timestampOf(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (value instanceof Date) {
		const timestamp = value.getTime();
		return Number.isFinite(timestamp) ? timestamp : null;
	}
	if (typeof value === "string" && value.trim() !== "") {
		const normalized = value.trim();
		// Date.parse() interprets offset-less date-times in the machine's local
		// timezone. Pricing timestamps must name an instant so recomputation is
		// deterministic across hosts.
		if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized)) return null;
		const timestamp = Date.parse(normalized);
		return Number.isFinite(timestamp) ? timestamp : null;
	}
	return null;
}

function boundaryOf(value, fallback) {
	if (value === null || value === void 0) return fallback;
	const timestamp = timestampOf(value);
	if (timestamp === null) throw new Error(`invalid pricing effective boundary: ${String(value)}`);
	return timestamp;
}

function minuteOf(clock) {
	const match = /^(\d{2}):(\d{2})$/.exec(clock);
	if (match === null) return null;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
	return hour * 60 + minute;
}

function validateUnitPrices(prices, label) {
	if (prices === null || typeof prices !== "object" || Array.isArray(prices)) throw new Error(`${label} must be an object`);
	for (const component of ["input", "cacheRead", "cacheWrite", "output"]) {
		if (!Object.hasOwn(prices, component)) throw new Error(`${label}.${component} is required`);
		const value = prices[component];
		if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
			throw new Error(`${label}.${component} must be a non-negative number or null`);
		}
	}
}

function validateSchedule(schedule, label) {
	if (schedule === null || typeof schedule !== "object" || Array.isArray(schedule)) throw new Error(`${label} must be an object`);
	if (nonEmptyString(schedule.timezone) === null) throw new Error(`${label}.timezone is required`);
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone }).format(0);
	} catch {
		throw new Error(`${label}.timezone is invalid`);
	}
	if (!Array.isArray(schedule.peakDays) || schedule.peakDays.length === 0) throw new Error(`${label}.peakDays must be non-empty`);
	const days = new Set();
	for (const day of schedule.peakDays) {
		if (!Number.isInteger(day) || day < 0 || day > 6 || days.has(day)) throw new Error(`${label}.peakDays must contain unique integers from 0 to 6`);
		days.add(day);
	}
	if (!Array.isArray(schedule.peakWindows) || schedule.peakWindows.length === 0) throw new Error(`${label}.peakWindows must be non-empty`);
	for (const [index, window] of schedule.peakWindows.entries()) {
		if (!Array.isArray(window) || window.length !== 2) throw new Error(`${label}.peakWindows[${index}] must be [start, end]`);
		const start = minuteOf(window[0]);
		const end = minuteOf(window[1]);
		if (start === null || end === null || start >= end) throw new Error(`${label}.peakWindows[${index}] must be a non-empty same-day half-open interval`);
	}
	if (schedule.otherwise !== "offPeak") throw new Error(`${label}.otherwise must be offPeak`);
}

function pricingKey(rule) {
	return JSON.stringify([rule.providerFamily, rule.pricingFamily, rule.modelMatcher.model, rule.currency]);
}

/**
 * Validate rule shape and reject overlapping effective windows for one exact
 * provider/pricing/model/currency key. Invalid catalogs are programmer errors.
 */
export function validatePricingRules(rules) {
	if (!Array.isArray(rules) || rules.length === 0) throw new Error("pricing rules must be a non-empty array");
	const ids = new Set();
	const intervals = new Map();
	for (const [index, rule] of rules.entries()) {
		const label = `pricingRules[${index}]`;
		if (rule === null || typeof rule !== "object" || Array.isArray(rule)) throw new Error(`${label} must be an object`);
		if (nonEmptyString(rule.id) === null || ids.has(rule.id)) throw new Error(`${label}.id must be unique and non-empty`);
		ids.add(rule.id);
		if (nonEmptyString(rule.providerFamily) === null || nonEmptyString(rule.pricingFamily) === null) throw new Error(`${label} provider/pricing family is required`);
		if (rule.modelMatcher?.type !== "exact" || nonEmptyString(rule.modelMatcher?.model) === null) throw new Error(`${label}.modelMatcher must be an exact model identity`);
		if (typeof rule.currency !== "string" || !/^[A-Z]{3}$/.test(rule.currency)) throw new Error(`${label}.currency must be an uppercase ISO-style code`);
		const from = boundaryOf(rule.effectiveFrom, -Infinity);
		const to = boundaryOf(rule.effectiveTo, Infinity);
		if (from >= to) throw new Error(`${label} effectiveFrom must be earlier than effectiveTo`);
		if (timestampOf(rule.updatedAt) === null) throw new Error(`${label}.updatedAt must be a timestamp`);
		if (rule.source?.kind !== "official" || nonEmptyString(rule.source?.provider) === null) throw new Error(`${label}.source must identify an official provider`);
		try {
			const sourceURL = new URL(rule.source.url);
			if (sourceURL.protocol !== "https:") throw new Error("not HTTPS");
		} catch {
			throw new Error(`${label}.source.url must be HTTPS`);
		}
		const pricingKeys = Object.keys(rule.pricing ?? {}).sort();
		if (rule.schedule === null) {
			if (pricingKeys.join(",") !== "flat") throw new Error(`${label}.pricing must contain only flat without a schedule`);
			validateUnitPrices(rule.pricing.flat, `${label}.pricing.flat`);
		} else {
			validateSchedule(rule.schedule, `${label}.schedule`);
			if (pricingKeys.join(",") !== "offPeak,peak") throw new Error(`${label}.pricing must contain peak and offPeak with a schedule`);
			validateUnitPrices(rule.pricing.peak, `${label}.pricing.peak`);
			validateUnitPrices(rule.pricing.offPeak, `${label}.pricing.offPeak`);
		}
		const key = pricingKey(rule);
		const previous = intervals.get(key) ?? [];
		for (const interval of previous) {
			if (Math.max(from, interval.from) < Math.min(to, interval.to)) {
				throw new Error(`overlapping pricing rules for ${key}: ${interval.id} and ${rule.id}`);
			}
		}
		previous.push({ id: rule.id, from, to });
		intervals.set(key, previous);
	}
	return rules;
}

function ensureValidatedRules(rules) {
	// The immutable built-in catalog is validated once at module load. Custom
	// catalogs stay fail-fast without imposing repeated schema work on PR5's
	// future per-sample estimation path.
	if (rules !== PRICING_RULES) validatePricingRules(rules);
}

function isEffective(rule, timestamp) {
	return timestamp >= boundaryOf(rule.effectiveFrom, -Infinity)
		&& timestamp < boundaryOf(rule.effectiveTo, Infinity);
}

function hostnameOf(baseURL) {
	if (nonEmptyString(baseURL) === null) return null;
	try {
		return new URL(baseURL).hostname.toLowerCase().replace(/\.$/, "");
	} catch {
		return null;
	}
}

function isOfficialDeepSeekIdentity(identity) {
	if (identity?.providerFamily !== "deepseek" || identity?.pricingFamily !== "deepseek") return false;
	const configuredBaseURL = nonEmptyString(identity.baseURL);
	// An exact official billing host remains authoritative even when an explicit
	// account monitor caused the shared resolver's confidence to be `explicit`.
	if (configuredBaseURL !== null) return hostnameOf(configuredBaseURL) === "api.deepseek.com";
	// Without a configured URL, a canonical route id is the remaining safe
	// signal. An explicit custom or malformed URL must never be overridden by it.
	if (identity.confidence === "canonical-id" && (identity.routeId === "deepseek" || identity.routeId === "deepseek-official")) return true;
	return false;
}

function isEligibleIdentity(identity, rule) {
	if (identity?.providerFamily !== rule.providerFamily || identity?.pricingFamily !== rule.pricingFamily) return false;
	if (rule.providerFamily === "deepseek" && rule.pricingFamily === "deepseek") return isOfficialDeepSeekIdentity(identity);
	return false;
}

/** Match one exact historical rule, or null when the route/model/currency is unpriced. */
export function matchPricingRule({ identity, model, timestamp, currency }, rules = PRICING_RULES) {
	ensureValidatedRules(rules);
	const at = timestampOf(timestamp);
	if (at === null || nonEmptyString(model) === null || typeof currency !== "string") return null;
	const matches = rules.filter((rule) => (
		isEligibleIdentity(identity, rule)
		&& rule.modelMatcher.model === model
		&& rule.currency === currency
		&& isEffective(rule, at)
	));
	if (matches.length > 1) throw new Error(`ambiguous pricing rules at ${new Date(at).toISOString()}: ${matches.map((rule) => rule.id).join(", ")}`);
	return matches[0] ?? null;
}

function zonedClock(timestamp, timezone) {
	const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23"
	}).formatToParts(new Date(timestamp)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
	return {
		weekday: WEEKDAY_NUMBER[parts.weekday],
		minute: Number(parts.hour) * 60 + Number(parts.minute)
	};
}

function tariffForSchedule(schedule, timestamp) {
	const clock = zonedClock(timestamp, schedule.timezone);
	if (!schedule.peakDays.includes(clock.weekday)) return schedule.otherwise;
	return schedule.peakWindows.some(([start, end]) => clock.minute >= minuteOf(start) && clock.minute < minuteOf(end))
		? "peak"
		: schedule.otherwise;
}

function resolveUnitPricingUnchecked(rule, timestamp) {
	if (!isEffective(rule, timestamp)) return null;
	const tariff = rule.schedule === null ? "flat" : tariffForSchedule(rule.schedule, timestamp);
	return { tariff, unitPricing: { ...rule.pricing[tariff] } };
}

/** Resolve the applicable tariff and per-million unit prices for one rule. */
export function resolveUnitPricing(rule, timestamp) {
	validatePricingRules([rule]);
	const at = timestampOf(timestamp);
	return at === null ? null : resolveUnitPricingUnchecked(rule, at);
}

function normalizedBuckets(buckets) {
	if (buckets === null || typeof buckets !== "object" || Array.isArray(buckets)) return null;
	const normalized = {};
	for (const [bucket] of BUCKET_COMPONENTS) {
		const value = buckets[bucket];
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
		normalized[bucket] = value;
	}
	return normalized;
}

/**
 * Estimate cost without rounding. Unknown route/model/currency or a positive
 * bucket with no reliable unit price makes the whole estimate unknown (null).
 */
export function estimateTokenCost(input, rules = PRICING_RULES) {
	if (input === null || typeof input !== "object") return null;
	const at = timestampOf(input.timestamp);
	const buckets = normalizedBuckets(input.buckets);
	if (at === null || buckets === null) return null;
	const rule = matchPricingRule(input, rules);
	if (rule === null) return null;
	const resolved = resolveUnitPricingUnchecked(rule, at);
	if (resolved === null) return null;
	const components = {};
	for (const [bucket, component] of BUCKET_COMPONENTS) {
		const tokens = buckets[bucket];
		const price = resolved.unitPricing[component];
		if (tokens > 0 && price === null) return null;
		components[component] = tokens === 0 ? 0 : tokens / TOKENS_PER_MILLION * price;
	}
	return {
		amount: components.input + components.cacheRead + components.cacheWrite + components.output,
		currency: rule.currency,
		components,
		tariff: resolved.tariff,
		ruleId: rule.id,
		source: { ...rule.source },
		updatedAt: rule.updatedAt
	};
}

validatePricingRules(PRICING_RULES);
