/**
 * dsh-usage-stats — pure per-day, per-model token-usage aggregation over
 * session event logs. Kept free of cordis imports so it can be unit-tested
 * and validated against real logs outside the running harness.
 *
 * Aggregation semantics mirror `dsh-token-meter`'s `tokenUsage` projection:
 * a usage sample rides an `assistant/chunk` (`data.chunk.type === "usage"`)
 * or an `assistant/message` (`data.usage`); a repeated sample for the same
 * (turn, step) REPLACES the earlier value instead of double counting it, and
 * the replacement is re-attributed to the day of the later event.
 *
 * Each sample is additionally attributed to the model that produced it:
 * `assistant/message` carries `data.message.source.model`; usage chunks fall
 * back to the last `request/header` `data.header.config.model`; samples with
 * no model information land in the `unknown` bucket.
 *
 * @module dsh-usage-stats/usage
 */

import { resolveProviderIdentity } from "./provider-identity.js";
import { applyCostSample, costSampleOf, createCostAccumulator, mergeCostAccumulator, renderCost } from "./billing.js";

/** Local-calendar `YYYY-MM-DD` key for a millisecond epoch. */
export function dayKey(timeMs) {
	const date = new Date(timeMs);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/** Empty token bucket. */
export function zeroBuckets() {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0
	};
}

/** Provider usage → buckets (missing cache fields are absent in some reports). */
export function bucketsOf(usage) {
	return {
		inputTokens: usage.inputTokens ?? 0,
		outputTokens: usage.outputTokens ?? 0,
		cacheReadTokens: usage.cacheReadTokens ?? 0,
		cacheWriteTokens: usage.cacheWriteTokens ?? 0
	};
}

/** Total tokens across all buckets. */
export function totalTokens(buckets) {
	return buckets.inputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens;
}

/**
 * Prompt-side cache hit rate in percent (0–100, one decimal), or null when
 * no prompt tokens were reported at all. Hits over the whole prompt side:
 * cacheRead / (input + cacheRead + cacheWrite).
 */
export function cacheHitRate(buckets) {
	const input = buckets.inputTokens ?? 0;
	const cacheRead = buckets.cacheReadTokens ?? 0;
	const cacheWrite = buckets.cacheWriteTokens ?? 0;
	const promptTokens = input + cacheRead + cacheWrite;
	if (promptTokens <= 0) return null;
	return Math.round((cacheRead / promptTokens) * 1000) / 10;
}

function addInto(target, source) {
	target.inputTokens += source.inputTokens;
	target.outputTokens += source.outputTokens;
	target.cacheReadTokens += source.cacheReadTokens;
	target.cacheWriteTokens += source.cacheWriteTokens;
	return target;
}

function subtractFrom(target, source) {
	target.inputTokens -= source.inputTokens;
	target.outputTokens -= source.outputTokens;
	target.cacheReadTokens -= source.cacheReadTokens;
	target.cacheWriteTokens -= source.cacheWriteTokens;
	return target;
}

function billingEntryOf(byDay, day) {
	let entry = byDay.get(day);
	if (entry === void 0) {
		entry = { total: createCostAccumulator(), models: new Map() };
		byDay.set(day, entry);
	}
	return entry;
}

function modelCostOf(entry, model) {
	let accumulator = entry.models.get(model);
	if (accumulator === void 0) {
		accumulator = createCostAccumulator();
		entry.models.set(model, accumulator);
	}
	return accumulator;
}

function adjustIdentityCount(map, key, direction) {
	const next = (map.get(key) ?? 0) + direction;
	if (next <= 0) map.delete(key);
	else map.set(key, next);
}

function createSessionBillingState() {
	return {
		total: createCostAccumulator(),
		days: new Map(),
		providers: new Map(),
		models: new Map(),
		sampleCount: 0,
		firstAt: null,
		lastAt: null,
		penultimateAt: null
	};
}

function applySessionCost(state, sample, direction) {
	const billing = state.billing;
	applyCostSample(billing.total, sample.cost, direction);
	const dayEntry = billingEntryOf(billing.days, sample.day);
	applyCostSample(dayEntry.total, sample.cost, direction);
	applyCostSample(modelCostOf(dayEntry, sample.model), sample.cost, direction);
	if (sample.cost.counted !== true) return;
	adjustIdentityCount(billing.providers, sample.providerId, direction);
	adjustIdentityCount(billing.models, sample.model, direction);
	if (direction < 0) {
		billing.sampleCount = Math.max(0, billing.sampleCount - 1);
		if (billing.sampleCount === 0) {
			billing.firstAt = null;
			billing.lastAt = null;
			billing.penultimateAt = null;
		} else {
			billing.lastAt = billing.penultimateAt;
			billing.penultimateAt = null;
		}
		return;
	}
	if (billing.sampleCount === 0) billing.firstAt = sample.time;
	billing.penultimateAt = billing.lastAt;
	billing.lastAt = sample.time;
	billing.sampleCount += 1;
}

function routeFromModelKey(key) {
	if (typeof key !== "string") return { providerId: "unknown", model: "unknown" };
	const slash = key.indexOf("/");
	if (slash <= 0 || slash === key.length - 1) return { providerId: "unknown", model: "unknown" };
	return { providerId: key.slice(0, slash), model: key.slice(slash + 1) };
}

/** Extract the usage sample an event carries, if any. */
function sampleOf(event) {
	if (event.type === "assistant/chunk" && event.data?.chunk?.type === "usage") {
		return {
			key: `${event.data.turn}:${event.data.step}`,
			usage: event.data.chunk.usage
		};
	}
	if (event.type === "assistant/message" && event.data?.usage !== void 0) {
		return {
			key: `${event.data.turn}:${event.data.step}`,
			usage: event.data.usage
		};
	}
	return void 0;
}

/**
 * The `provider/model` attribution key of a usage sample: the exact provider
 * route (dsh adapter id or pi-ai route) plus the model id, so the SAME model
 * served by different providers stays distinct. `assistant/message` names
 * its provider via `data.message.source`; usage chunks fall back to the last
 * `request/header` `data.header.config`; samples with no model information
 * land in the `unknown/unknown` bucket.
 */
export function routeModelOf(event) {
	const source = event.data?.message?.source;
	if (source !== void 0 && typeof source.model === "string") {
		return {
			providerId: typeof source.provider === "string" && source.provider.length > 0 ? source.provider : "unknown",
			model: source.model
		};
	}
	const config = event.data?.header?.config;
	if (config !== void 0 && typeof config.model === "string") {
		return {
			providerId: typeof config.provider === "string" && config.provider.length > 0 ? config.provider : "unknown",
			model: config.model
		};
	}
	return void 0;
}

function modelOf(event) {
	const route = routeModelOf(event);
	return route === void 0 ? void 0 : `${route.providerId}/${route.model}`;
}

/** Day entry: totals plus a per-model bucket map. */
function entryOf(byDay, day) {
	let entry = byDay.get(day);
	if (entry === void 0) {
		entry = {
			totals: zeroBuckets(),
			models: new Map()
		};
		byDay.set(day, entry);
	}
	return entry;
}

/**
 * One session's incremental fold state. `days` holds the already-folded
 * per-day entries; `lastSample`/`currentModel` let a later event slice keep
 * the replace-last-sample semantics and model attribution across fold
 * boundaries without replaying the whole log. `currentRoute` is a lightweight
 * provider/model projection over that same cursor, not a second usage ledger.
 */
export function createUsageState() {
	return resetUsageState({});
}

/** Reset only the incremental fold fields while preserving cache metadata. */
export function resetUsageState(state) {
	return Object.assign(state, {
		days: new Map(),
		billing: createSessionBillingState(),
		lastSample: null,
		currentModel: null,
		currentRoute: null,
		consumed: 0
	});
}

/**
 * Render the secret-free context for one session's latest provider/model pair.
 * The provider object supplies connection identity only; credentials and
 * monitor request details are intentionally excluded from the wire shape.
 */
export function currentSessionContext(sessionId, state, provider, config = { monitors: {} }) {
	const current = state?.currentRoute;
	if (current === null || current === void 0) return null;
	const identity = resolveProviderIdentity({
		...(provider ?? {}),
		id: current.providerId
	}, config);
	return {
		sessionId,
		providerId: identity.routeId,
		providerFamily: identity.providerFamily,
		model: current.model,
		accountId: identity.routeId,
		updatedAt: current.updatedAt
	};
}

/**
 * Fold a slice of NEW events onto an existing session state (mutating).
 * Replacements for the same (turn, step) subtract the previous sample's
 * buckets from the day/model bucket they were attributed to, so a slice
 * starting mid-step (e.g. a usage chunk at the tail of the previous fold)
 * stays exact.
 * @param state - session fold state (mutated in place).
 * @param events - the new events, in seq order, starting after the last fold.
 */
export function applyUsageDelta(state, events, options = {}) {
	let last = state.lastSample;
	let currentModel = state.currentModel;
	let currentRoute = state.currentRoute ?? null;
	const estimateCost = typeof options.estimateCost === "function" ? options.estimateCost : null;
	for (const event of events) {
		if (event.type === "request/header" || event.type === "assistant/message") {
			const route = routeModelOf(event);
			if (route !== void 0) {
				// Keep token attribution semantics unchanged: currentModel remains
				// request/header-driven, while currentRoute may also use the model
				// source on assistant/message for live context switching.
				if (event.type === "request/header") currentModel = `${route.providerId}/${route.model}`;
				currentRoute = {
					providerId: route.providerId,
					model: route.model,
					updatedAt: Number.isFinite(event.time) ? event.time : currentRoute?.updatedAt ?? null
				};
			}
		}
		const sample = sampleOf(event);
		if (sample === void 0) continue;
		const buckets = bucketsOf(sample.usage);
		const model = modelOf(event) ?? currentModel ?? "unknown/unknown";
		const route = routeModelOf(event) ?? routeFromModelKey(model);
		const day = dayKey(event.time);
		const entry = entryOf(state.days, day);
		if (last !== null && last.key === sample.key) {
			// Same turn/step re-reported: replace instead of double counting.
			const previous = state.days.get(last.day);
			if (previous !== void 0) {
				subtractFrom(previous.totals, last.buckets);
				const previousModel = previous.models.get(last.model);
				if (previousModel !== void 0) subtractFrom(previousModel, last.buckets);
			}
			if (last.cost !== void 0) applySessionCost(state, last, -1);
		}
		addInto(entry.totals, buckets);
		let modelBucket = entry.models.get(model);
		if (modelBucket === void 0) {
			modelBucket = zeroBuckets();
			entry.models.set(model, modelBucket);
		}
		addInto(modelBucket, buckets);
		const estimate = estimateCost === null ? null : estimateCost({
			providerId: route.providerId,
			model: route.model,
			timestamp: event.time,
			buckets
		});
		last = {
			key: sample.key,
			day,
			model,
			providerId: route.providerId,
			time: event.time,
			buckets,
			cost: costSampleOf(estimate, buckets)
		};
		applySessionCost(state, last, 1);
	}
	state.lastSample = last;
	state.currentModel = currentModel;
	state.currentRoute = currentRoute;
}

/**
 * Fold one session's events into per-day, per-model token buckets.
 * @param events - session event log in seq order.
 * @returns Map<`YYYY-MM-DD`, { totals, models: Map<model, buckets> }> with
 *   only days that saw usage.
 */
export function foldUsage(events) {
	const state = createUsageState();
	applyUsageDelta(state, events);
	return state.days;
}

/**
 * Merge one session's folded days into a global per-day map.
 * @param byDay - global map to mutate.
 * @param sessionDays - session day map (from foldUsage or a state).
 */
export function mergeInto(byDay, sessionDays) {
	for (const [day, entry] of sessionDays) {
		const target = entryOf(byDay, day);
		addInto(target.totals, entry.totals);
		for (const [model, buckets] of entry.models) {
			let modelBucket = target.models.get(model);
			if (modelBucket === void 0) {
				modelBucket = zeroBuckets();
				target.models.set(model, modelBucket);
			}
			addInto(modelBucket, buckets);
		}
	}
}

/** Merge one session's monetary derivation into a global day map. */
export function mergeBillingInto(byDay, sessionDays) {
	for (const [day, entry] of sessionDays) {
		const target = billingEntryOf(byDay, day);
		mergeCostAccumulator(target.total, entry.total);
		for (const [model, accumulator] of entry.models) mergeCostAccumulator(modelCostOf(target, model), accumulator);
	}
}

/**
 * Merge one session fold into a global per-day map (convenience wrapper).
 * @param byDay - global map to mutate.
 * @param events - session events.
 */
export function consumeEvents(byDay, events) {
	mergeInto(byDay, foldUsage(events));
}

/**
 * Render a global per-day map into the wire shape for the usage endpoint.
 * @param byDay - day → entry map.
 * @param updatedAt - computation timestamp.
 * @returns `{ days, total, updatedAt }` with `days` sorted ascending; each
 *   day carries `models` (descending by tokens) and a `cacheHitRate` percent.
 */
export function renderUsage(byDay, updatedAt, billingByDay = new Map()) {
	const days = [...byDay.entries()]
		.map(([date, entry]) => {
			const billing = billingByDay.get(date);
			const models = [...entry.models.entries()]
				.map(([model, buckets]) => ({
					model,
					...buckets,
					tokens: totalTokens(buckets),
					cacheHitRate: cacheHitRate(buckets),
					...renderCost(billing?.models.get(model) ?? createCostAccumulator())
				}))
				// All-zero buckets come from warmup requests that report
				// {input:0, output:0}; rendering them produces empty "0 tokens"
				// model rows (#23).
				.filter((entry) => entry.tokens > 0)
				.sort((a, b) => b.tokens - a.tokens);
			return {
				date,
				...entry.totals,
				tokens: totalTokens(entry.totals),
				cacheHitRate: cacheHitRate(entry.totals),
				...renderCost(billing?.total ?? createCostAccumulator()),
				models
			};
		})
		.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
	const total = zeroBuckets();
	for (const [, entry] of byDay) addInto(total, entry.totals);
	const totalCost = createCostAccumulator();
	for (const [, entry] of billingByDay) mergeCostAccumulator(totalCost, entry.total);
	return {
		days,
		total: {
			...total,
			tokens: totalTokens(total),
			cacheHitRate: cacheHitRate(total),
			...renderCost(totalCost)
		},
		updatedAt
	};
}

/** Render one cached session without maintaining a second token total. */
export function renderSessionUsage(sessionId, state) {
	const totals = zeroBuckets();
	for (const [, entry] of state.days) addInto(totals, entry.totals);
	return {
		sessionId,
		title: typeof state.title === "string" && state.title !== "" ? state.title : null,
		providers: [...state.billing.providers.keys()].sort(),
		models: [...state.billing.models.keys()].sort(),
		...totals,
		tokens: totalTokens(totals),
		...renderCost(state.billing.total),
		firstAt: Number.isFinite(state.billing.firstAt) ? new Date(state.billing.firstAt).toISOString() : null,
		lastAt: Number.isFinite(state.billing.lastAt) ? new Date(state.billing.lastAt).toISOString() : null
	};
}
