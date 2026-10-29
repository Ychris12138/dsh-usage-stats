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

import { createHash } from "node:crypto";
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

function webSearchUsageOf(usage, reasoningTokensMode) {
	if (usage === null || typeof usage !== "object" || Array.isArray(usage)) return void 0;
	const fields = ["inputTokens", "input_tokens", "outputTokens", "output_tokens", "reasoningTokens", "reasoning_tokens", "cacheReadTokens", "cache_read_input_tokens", "cacheWriteTokens", "cache_creation_input_tokens"];
	if (!fields.some((field) => usage[field] !== void 0)) return void 0;
	if (fields.some((field) => usage[field] !== void 0 && (!Number.isSafeInteger(usage[field]) || usage[field] < 0))) return void 0;
	const inputTokens = usage.inputTokens ?? usage.input_tokens ?? 0;
	const outputTokens = usage.outputTokens ?? usage.output_tokens ?? 0;
	const reasoningTokens = usage.reasoningTokens ?? usage.reasoning_tokens ?? 0;
	// A detail field alone cannot establish whether the output total includes it.
	if (reasoningTokens > 0 && !["included", "additional"].includes(reasoningTokensMode)) return void 0;
	const additionalReasoning = reasoningTokensMode === "additional" ? reasoningTokens : 0;
	for (const [camel, snake] of [["inputTokens", "input_tokens"], ["outputTokens", "output_tokens"], ["reasoningTokens", "reasoning_tokens"], ["cacheReadTokens", "cache_read_input_tokens"], ["cacheWriteTokens", "cache_creation_input_tokens"]]) {
		if (usage[camel] !== void 0 && usage[snake] !== void 0 && usage[camel] !== usage[snake]) return void 0;
	}
	if (!Number.isSafeInteger(inputTokens + outputTokens + additionalReasoning
		+ (usage.cacheReadTokens ?? usage.cache_read_input_tokens ?? 0)
		+ (usage.cacheWriteTokens ?? usage.cache_creation_input_tokens ?? 0))) return void 0;
	return {
		inputTokens,
		// Only producers that explicitly report disjoint output may add reasoning.
		outputTokens: outputTokens + additionalReasoning,
		cacheReadTokens: usage.cacheReadTokens ?? usage.cache_read_input_tokens ?? 0,
		cacheWriteTokens: usage.cacheWriteTokens ?? usage.cache_creation_input_tokens ?? 0
	};
}

function webSearchSampleKey(event) {
	const data = event.data ?? {};
	const identity = data.eventId ?? data.requestId ?? event.seq;
	if (typeof identity === "string" && identity.trim().length > 0) return `web-search:${JSON.stringify(["id", identity])}`;
	if (Number.isSafeInteger(identity) && identity >= 0) return `web-search:${JSON.stringify(["seq", identity])}`;
	return void 0;
}

/**
 * Extract the usage sample an event carries, if any. A compaction summary is an
 * LLM call of its own: its usage belongs to the provider/model that ran it, and
 * its compaction id keeps a re-reported summary from counting twice.
 */
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
	if (event.type === "compaction/summary" && event.data?.usage !== void 0) {
		return {
			key: `compaction:${event.data.compactionId ?? event.seq}`,
			usage: event.data.usage
		};
	}
	if (event.type === "web/deepseek-search-usage") {
		const route = routeModelOf(event);
		const usage = webSearchUsageOf(event.data?.usage, event.data?.reasoningTokensMode);
		const key = webSearchSampleKey(event);
		if (route === void 0 || usage === void 0 || key === void 0 || !Number.isFinite(event.time) || !Number.isFinite(new Date(event.time).getTime())) return void 0;
		return { key, usage };
	}
	return void 0;
}

/**
 * The `provider/model` attribution key of a usage sample: the exact provider
 * route (dsh adapter id or pi-ai route) plus the model id, so the SAME model
 * served by different providers stays distinct. `assistant/message` names
 * its provider via `data.message.source`; a compaction summary names it
 * directly; usage chunks fall back to the last `request/header`
 * `data.header.config`; samples with no model information land in the
 * `unknown/unknown` bucket.
 */
export function routeModelOf(event) {
	if (event.type === "web/deepseek-search-usage") {
		const provider = event.data?.provider;
		const model = event.data?.model;
		if (typeof provider !== "string" || provider.trim().length === 0 || typeof model !== "string" || model.trim().length === 0) return void 0;
		return {
			providerId: provider,
			model
		};
	}
	const source = event.data?.message?.source;
	if (source !== void 0 && typeof source.model === "string") {
		return {
			providerId: typeof source.provider === "string" && source.provider.length > 0 ? source.provider : "unknown",
			model: source.model
		};
	}
	if (typeof event.data?.model === "string") {
		return {
			providerId: typeof event.data.provider === "string" && event.data.provider.length > 0 ? event.data.provider : "unknown",
			model: event.data.model
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
		compactionSamples: new Map(),
		webSearchSamples: new Map(),
		usageSamples: new Map(),
		inheritedEventCount: null,
		currentModel: null,
		currentRoute: null,
		consumed: 0
	});
}

/**
 * Drop one session's derived billing while keeping its token folds. Token
 * buckets are pricing-independent, so a pricing-identity or catalog change must
 * not blank usage: the caller clears billing, marks the session for a refold,
 * and the next scan rebuilds the cost from the stored log.
 * @param state - session usage state to clear.
 * @returns the same state, with an empty billing accumulator.
 */
export function clearSessionBilling(state) {
	state.billing = createSessionBillingState();
	for (const sample of state.usageSamples?.values() ?? []) sample.cost = costSampleOf(null, sample.buckets);
	return state;
}

/** Exact inherited offset paired with a live Session or persistence read handle. */
export function inheritedCutOf(source) {
	const count = source?.inheritedEventCount;
	return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/**
 * Project copied samples once across sessions, preserving the only surviving
 * copy when its original is absent. Aliases are SHA-256 of normalized usage
 * evidence (seq/time/kind/turn-step/route/buckets), never messages or credentials.
 * Own calls remain distinct even if their evidence happens to match exactly.
 */
export function projectSessionUsage(sessions) {
	const entries = [];
	const projected = {};
	for (const [id, state] of Object.entries(sessions)) {
		if (!(state.usageSamples?.size > 0)) { projected[id] = state; continue; }
		projected[id] = { ...state, ...createUsageState(), title: state.title };
		for (const sample of state.usageSamples.values()) entries.push({ id, sample,
			inherited: state.inheritedEventCount !== null && sample.seq < state.inheritedEventCount });
	}
	const parents = entries.map((_, index) => index);
	const root = (i) => { while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; } return i; };
	const aliases = new Map();
	entries.forEach((entry, i) => {
		for (const alias of entry.sample.aliases ?? []) {
			const other = aliases.get(alias);
			if (other !== void 0) parents[root(i)] = root(other);
			else aliases.set(alias, i);
		}
	});
	const groups = new Map();
	entries.forEach((entry, i) => {
		const key = root(i);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(entry);
	});
	const chosen = [];
	for (const group of groups.values()) {
		const own = group.filter((entry) => !entry.inherited);
		if (own.length > 1) { chosen.push(...own); continue; }
		group.sort((a, b) => (b.sample.seq - a.sample.seq) || (b.sample.time - a.sample.time)
			|| (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		chosen.push({ id: own[0]?.id ?? group[0].id, sample: group[0].sample });
	}
	chosen.sort((a, b) => a.sample.time - b.sample.time || a.sample.seq - b.sample.seq);
	for (const { id, sample } of chosen) {
		const state = projected[id];
		const entry = entryOf(state.days, sample.day);
		addInto(entry.totals, sample.buckets);
		if (!entry.models.has(sample.model)) entry.models.set(sample.model, zeroBuckets());
		addInto(entry.models.get(sample.model), sample.buckets);
		applySessionCost(state, sample, 1);
	}
	return projected;
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
 *
 * Inherited samples remain in each source ledger. Cross-session projection
 * uses exact inherited offsets and matching usage evidence, never wall clocks.
 * @param state - session fold state (mutated in place).
 * @param events - the new events, in seq order, starting after the last fold.
 */
export function applyUsageDelta(state, events, options = {}) {
	let last = state.lastSample;
	let currentModel = state.currentModel;
	let currentRoute = state.currentRoute ?? null;
	const marker = events.find((event) => event.type === "session/end-seed" && event.data?.inherited === true);
	if (marker !== void 0 && Number.isSafeInteger(marker.seq)) state.inheritedEventCount = marker.seq;
	const usageSamples = state.usageSamples ??= new Map();
	const compactionSamples = state.compactionSamples ??= new Map();
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
		// Summary calls have their own identities and may interleave with assistant
		// chunks/messages. They must not overwrite the assistant replacement cursor.
		const compaction = event.type === "compaction/summary";
		const search = event.type === "web/deepseek-search-usage";
		const previousSample = search ? state.webSearchSamples.get(sample.key) ?? null : compaction ? compactionSamples.get(sample.key) ?? null : last;
		if (previousSample !== null && previousSample.key === sample.key) {
			// Same turn/step re-reported: replace instead of double counting.
			const previous = state.days.get(previousSample.day);
			if (previous !== void 0) {
				subtractFrom(previous.totals, previousSample.buckets);
				const previousModel = previous.models.get(previousSample.model);
				if (previousModel !== void 0) subtractFrom(previousModel, previousSample.buckets);
			}
			if (previousSample.cost !== void 0) applySessionCost(state, previousSample, -1);
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
		const replacing = previousSample?.key === sample.key ? previousSample : null;
		const ledgerKey = replacing?.ledgerKey ?? (compaction || search ? sample.key : `assistant:${event.seq}`);
		const alias = createHash("sha256").update(JSON.stringify([
			event.seq, event.time, event.type, sample.key, model,
			buckets.inputTokens, buckets.outputTokens, buckets.cacheReadTokens, buckets.cacheWriteTokens
		])).digest("hex");
		const nextSample = {
			ledgerKey, seq: event.seq,
			aliases: [...new Set([...(replacing?.aliases ?? []), alias])],
			key: sample.key,
			day,
			model,
			providerId: route.providerId,
			time: event.time,
			buckets,
			cost: costSampleOf(estimate, buckets)
		};
		usageSamples.set(ledgerKey, nextSample);
		if (search) state.webSearchSamples.set(sample.key, nextSample);
		else if (compaction) compactionSamples.set(sample.key, nextSample);
		else last = nextSample;
		applySessionCost(state, nextSample, 1);
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
