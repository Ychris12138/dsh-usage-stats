/**
 * dsh-usage-stats — server half.
 *
 * Registers nine read-only, loopback-only data endpoints plus one explicit
 * loopback-only OrcaRouter settings action on the web server:
 *   GET /api/usage-stats/usage         — per-day token usage across every session
 *   GET /api/usage-stats/providers     — configured providers + balance schemes
 *   GET /api/usage-stats/balance       — balance for one provider (?provider=<id>)
 *   GET /api/usage-stats/subscriptions — OpenCode Go + Z.ai quota windows
 *   GET /api/usage-stats/account       — unified account snapshot for one provider
 *   GET /api/usage-stats/session-context — provider/model context for one live session
 *   GET /api/usage-stats/export/daily.csv — daily provider/model usage export
 *   GET /api/usage-stats/export/sessions.csv — per-session usage export
 *   GET /api/usage-stats/export.json — versioned usage/account-safe export
 *   GET|POST /api/usage-stats/integrations/orcarouter — status / explicit add
 *
 * Provider configuration is read straight from the harness settings
 * (`llm-deepseek` for the official DeepSeek route, `llm-pi-ai` for every
 * configured pi-ai provider profile), and each provider's API key is resolved
 * through the credentials seam at request time — nothing is stored by this
 * plugin.
 *
 * The endpoints live under the `/api` prefix as exact routes, so they win
 * over the connection plugin's `/api` prefix handler; each handler applies
 * its own peer-socket loopback fence (the exact routes bypass the RPC trust
 * fence); Host is checked only as an additional defense.
 *
 * Usage aggregation is INCREMENTAL: per-session fold state (day/model
 * buckets plus the last usage sample) is cached in memory and persisted to
 * `<DSH_HOME>/storages/usage-stats-cache.json`. On each request only the
 * events added since the last fold are processed — live sessions fold their
 * in-memory tail, while persisted sessions use the storage backend's opaque
 * revision when available. Steady-state cost stays O(new events) no matter
 * how large the logs grow.
 *
 * @module dsh-usage-stats
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { applyUsageDelta, createUsageState, currentSessionContext, mergeBillingInto, mergeInto, renderSessionUsage, renderUsage, resetUsageState, totalTokens, zeroBuckets } from "./usage.js";
import { ACCOUNT_REFRESH_MS, createAccountService, validateAccountConfig } from "./accounts.js";
import { changedProviderPricingRoutes, createUsageCostEstimator, parseCostAccumulator, pricingFingerprint, renderBudgetSummary, serializeCostAccumulator, validateBudgetConfig } from "./billing.js";
import { dailyCsv, jsonExport, sessionsCsv } from "./export.js";
import { addOrcaRouterPreset, orcaRouterIntegrationState } from "./orcarouter.js";

/** Stable Cordis plugin name. */
const name = "usage-stats";

/** Services required before this plugin activates. */
const inject = ["webServer", "credentials", "sessions", "sessionPersistence", "settings", "llm"];

const USAGE_PATH = "/api/usage-stats/usage";
const PROVIDERS_PATH = "/api/usage-stats/providers";
const BALANCE_PATH = "/api/usage-stats/balance";
const SUBSCRIPTIONS_PATH = "/api/usage-stats/subscriptions";
const ACCOUNT_PATH = "/api/usage-stats/account";
const SESSION_CONTEXT_PATH = "/api/usage-stats/session-context";
const DAILY_EXPORT_PATH = "/api/usage-stats/export/daily.csv";
const SESSIONS_EXPORT_PATH = "/api/usage-stats/export/sessions.csv";
const JSON_EXPORT_PATH = "/api/usage-stats/export.json";
const ORCAROUTER_INTEGRATION_PATH = "/api/usage-stats/integrations/orcarouter";
const UPSTREAM_TIMEOUT_MS = 15000;
const CACHE_VERSION = 5;

/** Default DeepSeek connection facts when the settings namespace is absent. */
const DEEPSEEK_DEFAULTS = {
	apiKeyEnv: "DEEPSEEK_API_KEY",
	baseURL: "https://api.deepseek.com"
};

/** Write a JSON response. */
function json(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-cache"
	});
	res.end(body);
}

function attachment(res, contentType, filename, body) {
	res.writeHead(200, {
		"content-type": contentType,
		"content-disposition": `attachment; filename="${filename}"`,
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	});
	res.end(body);
}

/**
 * Loopback fence, primary on the PEER SOCKET address (not the
 * client-controllable Host header): the request must come from a loopback
 * interface. IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is normalized. The Host
 * header is kept as an additional check, never as the deciding one.
 */
function isLoopbackAddress(address) {
	if (typeof address !== "string") return false;
	const a = address.toLowerCase();
	if (a === "::1") return true;
	const ipv4 = a.startsWith("::ffff:") ? a.slice(7) : a;
	const octets = ipv4.split(".");
	return octets.length === 4 && octets[0] === "127" && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Parse a Host header without breaking bracketed or bare IPv6 literals. */
function hostNameOf(value) {
	if (typeof value !== "string") return null;
	const host = value.trim().toLowerCase();
	if (host.startsWith("[")) {
		const close = host.indexOf("]");
		if (close <= 1) return null;
		const suffix = host.slice(close + 1);
		if (suffix !== "" && !/^:\d+$/.test(suffix)) return null;
		return host.slice(1, close);
	}
	const firstColon = host.indexOf(":");
	const lastColon = host.lastIndexOf(":");
	if (firstColon !== lastColon) return host;
	if (lastColon === -1) return host.replace(/\.$/, "");
	if (!/^\d+$/.test(host.slice(lastColon + 1))) return null;
	return host.slice(0, lastColon).replace(/\.$/, "");
}

function isLoopbackHostHeader(req) {
	const name = hostNameOf(req.headers.host);
	return name === "localhost" || isLoopbackAddress(name);
}

/** Refuse non-loopback callers and non-GET methods before any work. */
function rejectForeignCaller(req, res) {
	if (req.method !== "GET") {
		res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
		return true;
	}
	const peer = req.socket?.remoteAddress;
	if (isLoopbackAddress(peer) && isLoopbackHostHeader(req)) return false;
	json(res, 403, { ok: false, error: "forbidden" });
	return true;
}

/**
 * Fence the sole settings mutation. The custom action header makes this a
 * non-simple browser request, so a foreign page cannot CSRF the loopback route
 * without a CORS preflight (the exact route never grants CORS).
 */
function rejectForeignMutation(req, res) {
	if (req.method !== "POST") {
		json(res, 405, { ok: false, error: "method-not-allowed" });
		return true;
	}
	const peer = req.socket?.remoteAddress;
	if (!isLoopbackAddress(peer) || !isLoopbackHostHeader(req)) {
		json(res, 403, { ok: false, error: "forbidden" });
		return true;
	}
	const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"].toLowerCase() : "";
	if (!contentType.startsWith("application/json") || req.headers["x-dsh-usage-stats-action"] !== "add-orcarouter") {
		json(res, 403, { ok: false, error: "forbidden-action" });
		return true;
	}
	return false;
}

//#region incremental cache
/** Cache file location under the dsh home. */
function cachePath() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "storages", "usage-stats-cache.json");
}

let loadedCache = null;
let loadPromise = null;
let inflight = null;

/** Serialize one session's fold state (Maps → plain objects). */
function serializeSession(state) {
	const days = {};
	for (const [date, entry] of state.days) {
		const models = {};
		for (const [model, buckets] of entry.models) models[model] = { ...buckets };
		days[date] = { totals: { ...entry.totals }, models };
	}
	return {
		kind: state.kind ?? "persisted",
		title: typeof state.title === "string" ? state.title : null,
		consumed: state.consumed ?? 0,
		...(state.revision === void 0 ? {} : { revision: state.revision }),
		days,
		lastSample: state.lastSample === null ? null : {
			key: state.lastSample.key,
			day: state.lastSample.day,
			model: state.lastSample.model,
			providerId: state.lastSample.providerId,
			time: state.lastSample.time,
			cost: state.lastSample.cost,
			buckets: { ...state.lastSample.buckets }
		},
		billing: {
			total: serializeCostAccumulator(state.billing.total),
			days: Object.fromEntries([...state.billing.days].map(([date, entry]) => [date, {
				total: serializeCostAccumulator(entry.total),
				models: Object.fromEntries([...entry.models].map(([model, accumulator]) => [model, serializeCostAccumulator(accumulator)]))
			}])),
			providers: Object.fromEntries(state.billing.providers),
			models: Object.fromEntries(state.billing.models),
			sampleCount: state.billing.sampleCount,
			firstAt: state.billing.firstAt,
			lastAt: state.billing.lastAt,
			penultimateAt: state.billing.penultimateAt
		},
		currentModel: state.currentModel,
		currentRoute: state.currentRoute === null || state.currentRoute === void 0 ? null : {
			providerId: state.currentRoute.providerId,
			model: state.currentRoute.model,
			updatedAt: state.currentRoute.updatedAt
		}
	};
}

/** Parse a serialized session entry back into fold state (lenient). */
function parseSession(raw) {
	const state = createUsageState();
	if (raw === null || typeof raw !== "object") return state;
	state.kind = typeof raw.kind === "string" ? raw.kind : "persisted";
	state.title = typeof raw.title === "string" ? raw.title : null;
	state.consumed = Number.isSafeInteger(raw.consumed) ? raw.consumed : 0;
	if (typeof raw.revision === "string") state.revision = raw.revision;
	if (raw.days !== null && typeof raw.days === "object") {
		for (const [date, entry] of Object.entries(raw.days)) {
			if (entry === null || typeof entry !== "object") continue;
			const target = { totals: zeroBuckets(), models: new Map() };
			const totals = entry.totals;
			if (totals !== null && typeof totals === "object") {
				target.totals.inputTokens = Number.isFinite(totals.inputTokens) ? totals.inputTokens : 0;
				target.totals.outputTokens = Number.isFinite(totals.outputTokens) ? totals.outputTokens : 0;
				target.totals.cacheReadTokens = Number.isFinite(totals.cacheReadTokens) ? totals.cacheReadTokens : 0;
				target.totals.cacheWriteTokens = Number.isFinite(totals.cacheWriteTokens) ? totals.cacheWriteTokens : 0;
			}
			if (entry.models !== null && typeof entry.models === "object") {
				for (const [model, buckets] of Object.entries(entry.models)) {
					if (buckets === null || typeof buckets !== "object") continue;
					target.models.set(model, {
						inputTokens: Number.isFinite(buckets.inputTokens) ? buckets.inputTokens : 0,
						outputTokens: Number.isFinite(buckets.outputTokens) ? buckets.outputTokens : 0,
						cacheReadTokens: Number.isFinite(buckets.cacheReadTokens) ? buckets.cacheReadTokens : 0,
						cacheWriteTokens: Number.isFinite(buckets.cacheWriteTokens) ? buckets.cacheWriteTokens : 0
					});
				}
			}
			state.days.set(date, target);
		}
	}
	if (raw.lastSample !== null && raw.lastSample !== void 0 && typeof raw.lastSample === "object" && typeof raw.lastSample.key === "string" && typeof raw.lastSample.day === "string") {
		const buckets = raw.lastSample.buckets ?? {};
		state.lastSample = {
			key: raw.lastSample.key,
			day: raw.lastSample.day,
			model: typeof raw.lastSample.model === "string" ? raw.lastSample.model : "unknown",
			providerId: typeof raw.lastSample.providerId === "string" ? raw.lastSample.providerId : "unknown",
			time: Number.isFinite(raw.lastSample.time) ? raw.lastSample.time : null,
			cost: raw.lastSample.cost !== null && typeof raw.lastSample.cost === "object" ? { ...raw.lastSample.cost } : { counted: true, complete: false },
			buckets: {
				inputTokens: Number.isFinite(buckets.inputTokens) ? buckets.inputTokens : 0,
				outputTokens: Number.isFinite(buckets.outputTokens) ? buckets.outputTokens : 0,
				cacheReadTokens: Number.isFinite(buckets.cacheReadTokens) ? buckets.cacheReadTokens : 0,
				cacheWriteTokens: Number.isFinite(buckets.cacheWriteTokens) ? buckets.cacheWriteTokens : 0
			}
		};
	}
	if (raw.billing !== null && typeof raw.billing === "object" && !Array.isArray(raw.billing)) {
		state.billing.total = parseCostAccumulator(raw.billing.total);
		for (const [date, entry] of Object.entries(raw.billing.days ?? {})) {
			if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
			const restored = { total: parseCostAccumulator(entry.total), models: new Map() };
			for (const [model, accumulator] of Object.entries(entry.models ?? {})) restored.models.set(model, parseCostAccumulator(accumulator));
			state.billing.days.set(date, restored);
		}
		for (const [providerId, count] of Object.entries(raw.billing.providers ?? {})) if (Number.isSafeInteger(count) && count > 0) state.billing.providers.set(providerId, count);
		for (const [model, count] of Object.entries(raw.billing.models ?? {})) if (Number.isSafeInteger(count) && count > 0) state.billing.models.set(model, count);
		state.billing.sampleCount = Number.isSafeInteger(raw.billing.sampleCount) && raw.billing.sampleCount >= 0 ? raw.billing.sampleCount : 0;
		state.billing.firstAt = Number.isFinite(raw.billing.firstAt) ? raw.billing.firstAt : null;
		state.billing.lastAt = Number.isFinite(raw.billing.lastAt) ? raw.billing.lastAt : null;
		state.billing.penultimateAt = Number.isFinite(raw.billing.penultimateAt) ? raw.billing.penultimateAt : null;
	}
	if (typeof raw.currentModel === "string") state.currentModel = raw.currentModel;
	if (raw.currentRoute !== null && typeof raw.currentRoute === "object"
		&& typeof raw.currentRoute.providerId === "string" && raw.currentRoute.providerId.length > 0
		&& typeof raw.currentRoute.model === "string" && raw.currentRoute.model.length > 0) {
		state.currentRoute = {
			providerId: raw.currentRoute.providerId,
			model: raw.currentRoute.model,
			updatedAt: Number.isFinite(raw.currentRoute.updatedAt) ? raw.currentRoute.updatedAt : null
		};
	}
	return state;
}

function parsePricingIdentityCutoffs(raw) {
	const cutoffs = Object.create(null);
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return cutoffs;
	for (const [routeId, cutoff] of Object.entries(raw)) {
		if (routeId !== "" && Number.isFinite(cutoff) && cutoff >= 0) cutoffs[routeId] = cutoff;
	}
	return cutoffs;
}

function freshCache(pricingFingerprintValue, previous = null, transitionAt = Date.now()) {
	const pricingIdentityCutoffs = parsePricingIdentityCutoffs(previous?.pricingIdentityCutoffs);
	let pricingIdentityCutoffAll = Number.isFinite(previous?.pricingIdentityCutoffAll) && previous.pricingIdentityCutoffAll >= 0
		? previous.pricingIdentityCutoffAll
		: null;
	if (previous !== null && previous.pricingFingerprint !== pricingFingerprintValue) {
		const changedRoutes = changedProviderPricingRoutes(previous.pricingFingerprint, pricingFingerprintValue);
		if (changedRoutes === null) pricingIdentityCutoffAll = Math.max(pricingIdentityCutoffAll ?? 0, transitionAt);
		else for (const routeId of changedRoutes) pricingIdentityCutoffs[routeId] = Math.max(pricingIdentityCutoffs[routeId] ?? 0, transitionAt);
	}
	return {
		version: CACHE_VERSION,
		pricingFingerprint: pricingFingerprintValue,
		pricingIdentityCutoffAll,
		pricingIdentityCutoffs,
		sessions: {}
	};
}

function restoredCache(parsed, pricingFingerprintValue) {
	const sessions = {};
	for (const [id, entry] of Object.entries(parsed.sessions)) {
		if (typeof id === "string" && id.length > 0) sessions[id] = parseSession(entry);
	}
	return {
		version: CACHE_VERSION,
		pricingFingerprint: pricingFingerprintValue,
		pricingIdentityCutoffAll: Number.isFinite(parsed.pricingIdentityCutoffAll) && parsed.pricingIdentityCutoffAll >= 0
			? parsed.pricingIdentityCutoffAll
			: null,
		pricingIdentityCutoffs: parsePricingIdentityCutoffs(parsed.pricingIdentityCutoffs),
		sessions
	};
}

/** Load against the current runtime provider/pricing fingerprint. */
async function loadCache(pricingFingerprintValue) {
	if (loadedCache !== null) {
		if (loadedCache.pricingFingerprint !== pricingFingerprintValue) {
			loadedCache = freshCache(pricingFingerprintValue, loadedCache);
			loadPromise = Promise.resolve(loadedCache);
		}
		return loadedCache;
	}
	loadPromise ??= (async () => {
		const fresh = freshCache(pricingFingerprintValue);
		try {
			const raw = await readFile(cachePath(), "utf8");
			const parsed = JSON.parse(raw);
			if (parsed !== null && typeof parsed === "object" && parsed.version === CACHE_VERSION
				&& typeof parsed.pricingFingerprint === "string"
				&& parsed.sessions !== null && typeof parsed.sessions === "object") {
				if (parsed.pricingFingerprint === pricingFingerprintValue) return restoredCache(parsed, pricingFingerprintValue);
				return freshCache(pricingFingerprintValue, parsed);
			}
		} catch {
			/* first run or corrupt cache */
		}
		return fresh;
	})();
	loadedCache = await loadPromise;
	return loadedCache;
}

/** Persist the cache atomically (temp + rename); failures are logged, never fatal. */
async function saveCache(ctx, cache) {
	try {
		const path = cachePath();
		await mkdir(dirname(path), { recursive: true });
		const serialized = {
			version: CACHE_VERSION,
			pricingFingerprint: cache.pricingFingerprint,
			pricingIdentityCutoffAll: cache.pricingIdentityCutoffAll,
			pricingIdentityCutoffs: cache.pricingIdentityCutoffs,
			sessions: {}
		};
		for (const [id, state] of Object.entries(cache.sessions)) serialized.sessions[id] = serializeSession(state);
		const tmp = `${path}.tmp`;
		await writeFile(tmp, JSON.stringify(serialized), "utf8");
		await rename(tmp, path);
	} catch (error) {
		ctx.logger.warn(`usage-stats: saving usage cache failed: ${String(error)}`);
	}
}

/** Single-flight guard: concurrent requests share one aggregation run. */
function withLock(run) {
	if (inflight !== null) return inflight;
	inflight = run().finally(() => {
		inflight = null;
	});
	return inflight;
}
//#endregion

/**
 * Collect per-day usage across live and persisted sessions, incrementally.
 *
 * Live sessions: fold only the in-memory events added since the last fold;
 * an in-memory log that SHRANK below the folded cursor was rebuilt (DSH
 * restores compressed summaries after a restart), so the session is refolded
 * from scratch instead of freezing its stats (#23).
 * Persisted sessions: skipped when the backend's opaque revision is
 * unchanged (`sessionPersistence.listSnapshots`, falling back to always
 * reading the delta); when the revision changes, the new events are verified
 * to be contiguous with the last folded seq — a gap or an empty delta means
 * the log was truncated/rewritten, so the session is refolded from scratch.
 * Sessions that vanished are dropped, and a session switching between
 * live/persisted is refolded from scratch to stay exact.
 */
export async function collectUsage(ctx, config = { monitors: {}, budgets: validateBudgetConfig() }) {
	return withLock(async () => {
		const providers = await configuredProviders(ctx);
		const runtimePricingFingerprint = pricingFingerprint({ providers, config });
		const cache = await loadCache(runtimePricingFingerprint);
		const estimateCurrentCost = createUsageCostEstimator(providers, config);
		const estimateCost = (input) => {
			const routeCutoff = Object.hasOwn(cache.pricingIdentityCutoffs, input.providerId)
				? cache.pricingIdentityCutoffs[input.providerId]
				: null;
			const cutoff = Math.max(cache.pricingIdentityCutoffAll ?? 0, routeCutoff ?? 0);
			if (cutoff > 0 && (!Number.isFinite(input.timestamp) || input.timestamp <= cutoff)) return null;
			return estimateCurrentCost(input);
		};
		const live = ctx.get("sessions");
		const attached = new Set();
		if (live !== void 0) {
			for (const session of live.list()) {
				attached.add(session.id);
				const state = cache.sessions[session.id] ?? createUsageState();
				if (typeof session.title === "string") state.title = session.title;
				if (state.kind !== "live") {
					// Live/persisted transition: refold the whole in-memory log.
					resetUsageState(state);
				}
				const count = session.events.length;
				if (count < (state.consumed ?? 0)) {
					// The in-memory log shrank below the folded cursor — DSH
					// restores sessions from disk as compressed summaries after
					// a restart, so a positional cursor from the pre-restart
					// full log would silently freeze this session's stats
					// forever (#23). The cursor is meaningless against the
					// rebuilt log: refold it from scratch.
					resetUsageState(state);
				}
				if ((state.consumed ?? 0) < count) {
					applyUsageDelta(state, session.events.slice(state.consumed ?? 0), { estimateCost });
					state.consumed = count;
				}
				state.kind = "live";
				cache.sessions[session.id] = state;
			}
		}
		const persistence = ctx.get("sessionPersistence");
		const persistedIds = new Set();
		if (persistence !== void 0) {
			// Prefer the backend's opaque per-log revisions (no file I/O in the
			// plugin, works for any backend that exposes listSnapshots).
			let snapshots = null;
			if (typeof persistence.listSnapshots === "function") {
				try {
					snapshots = await persistence.listSnapshots();
				} catch (error) {
					ctx.logger.warn(`usage-stats: listSnapshots failed, falling back to list(): ${String(error)}`);
				}
			}
			const metas = snapshots !== null ? snapshots.map((entry) => entry.header) : await persistence.list();
			const revisionOf = new Map();
			if (snapshots !== null) for (const entry of snapshots) revisionOf.set(entry.header.id, entry.revision);
			for (const meta of metas) {
				persistedIds.add(meta.id);
				if (attached.has(meta.id)) continue;
				const state = cache.sessions[meta.id] ?? createUsageState();
				if (typeof meta.title === "string") state.title = meta.title;
				const revision = revisionOf.get(meta.id);
				const changed = state.kind !== "persisted" || (revision !== void 0 && revision !== state.revision) || revision === void 0;
				if (changed) {
					try {
						const wasPersisted = state.kind === "persisted";
						const fromSeq = wasPersisted ? state.consumed : 0;
						const { events } = await persistence.readFrom(meta.id, fromSeq);
						if (!wasPersisted) {
							resetUsageState(state);
						}
						const fresh = wasPersisted ? events.filter((event) => event.seq > (state.consumed ?? 0)) : events;
						const contiguous = fresh.length === 0 ? state.consumed === 0 : fresh[0].seq === state.consumed + 1;
						if (!contiguous && state.consumed > 0) {
							// Log truncated or rewritten: refold the whole log.
							resetUsageState(state);
							const { events: allEvents } = await persistence.readFrom(meta.id, 0);
							applyUsageDelta(state, allEvents, { estimateCost });
							state.consumed = allEvents.length > 0 ? allEvents[allEvents.length - 1].seq : 0;
						} else if (fresh.length > 0) {
							applyUsageDelta(state, fresh, { estimateCost });
							state.consumed = fresh[fresh.length - 1].seq;
						}
						state.kind = "persisted";
						if (revision !== void 0) state.revision = revision;
					} catch (error) {
						ctx.logger.warn(`usage-stats: reading persisted session "${meta.id}" failed: ${String(error)}`);
					}
				}
				cache.sessions[meta.id] = state;
			}
		}
		for (const id of Object.keys(cache.sessions)) {
			if (!attached.has(id) && !persistedIds.has(id)) delete cache.sessions[id];
		}
		const byDay = new Map();
		const billingByDay = new Map();
		for (const state of Object.values(cache.sessions)) {
			mergeInto(byDay, state.days);
			mergeBillingInto(billingByDay, state.billing.days);
		}
		// Keep the atomic cache write inside the single-flight section. Otherwise
		// overlapping saves can race on the same temporary file.
		await saveCache(ctx, cache);
		const updatedAt = Date.now();
		const rendered = renderUsage(byDay, updatedAt, billingByDay);
		return {
			...rendered,
			sessions: Object.entries(cache.sessions).map(([sessionId, state]) => renderSessionUsage(sessionId, state)).filter((session) => session.tokens > 0),
			budgets: renderBudgetSummary(billingByDay, config.budgets ?? validateBudgetConfig(), updatedAt)
		};
	});
}

async function handleUsage(ctx, config, req, res) {
	if (rejectForeignCaller(req, res)) return;
	try {
		const result = await collectUsage(ctx, config);
		json(res, 200, { ok: true, ...result });
	} catch (error) {
		ctx.logger.warn(`usage-stats: usage aggregation failed: ${String(error)}`);
		json(res, 500, { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) });
	}
}

function exportFailure(ctx, kind, error, res) {
	const name = error instanceof Error && typeof error.name === "string" ? error.name : "Error";
	ctx.logger.warn(`usage-stats: ${kind} export failed (${name})`);
	json(res, 500, { ok: false, error: "internal", message: "export failed" });
}

async function handleDailyExport(ctx, config, req, res) {
	if (rejectForeignCaller(req, res)) return;
	try {
		attachment(res, "text/csv; charset=utf-8", "dsh-usage-daily.csv", dailyCsv(await collectUsage(ctx, config)));
	} catch (error) {
		exportFailure(ctx, "daily CSV", error, res);
	}
}

async function handleSessionsExport(ctx, config, req, res) {
	if (rejectForeignCaller(req, res)) return;
	try {
		attachment(res, "text/csv; charset=utf-8", "dsh-usage-sessions.csv", sessionsCsv(await collectUsage(ctx, config)));
	} catch (error) {
		exportFailure(ctx, "session CSV", error, res);
	}
}

async function handleJsonExport(ctx, config, accounts, req, res) {
	if (rejectForeignCaller(req, res)) return;
	try {
		const [usage, providerViews] = await Promise.all([collectUsage(ctx, config), accounts.providerViews()]);
		attachment(res, "application/json; charset=utf-8", "dsh-usage-stats.json", JSON.stringify(jsonExport(usage, providerViews)));
	} catch (error) {
		exportFailure(ctx, "JSON", error, res);
	}
}

/**
 * Enumerate the harness's configured providers: the official DeepSeek route
 * (`llm-deepseek` settings namespace) plus every pi-ai provider profile
 * (`llm-pi-ai` settings namespace). Each entry carries the connection facts
 * (credential ref + base URL) needed to query a balance — no keys here.
 */
async function configuredProviders(ctx) {
	const settings = ctx.get("settings");
	const providers = [];
	const deepseek = settings?.get?.("llm-deepseek");
	if (deepseek !== void 0 && deepseek !== null && typeof deepseek === "object") {
		providers.push({
			id: "deepseek-official",
			displayName: "DeepSeek",
			apiKeyEnv: typeof deepseek.apiKeyEnv === "string" ? deepseek.apiKeyEnv : DEEPSEEK_DEFAULTS.apiKeyEnv,
			baseURL: typeof deepseek.baseURL === "string" ? deepseek.baseURL : DEEPSEEK_DEFAULTS.baseURL
		});
	} else {
		providers.push({
			id: "deepseek-official",
			displayName: "DeepSeek",
			apiKeyEnv: DEEPSEEK_DEFAULTS.apiKeyEnv,
			baseURL: DEEPSEEK_DEFAULTS.baseURL
		});
	}
	const pi = settings?.get?.("llm-pi-ai");
	if (pi !== void 0 && pi !== null && typeof pi === "object" && pi.providers !== void 0 && typeof pi.providers === "object") {
		for (const [route, profile] of Object.entries(pi.providers)) {
			if (profile === null || typeof profile !== "object") continue;
			providers.push({
				id: route,
				displayName: typeof profile.displayName === "string" && profile.displayName.length > 0 ? profile.displayName : route,
				apiKeyEnv: typeof profile.apiKeyEnv === "string" ? profile.apiKeyEnv : void 0,
				baseURL: typeof profile.baseURL === "string" ? profile.baseURL : void 0
			});
		}
	}
	return providers;
}

/**
 * Resolve one live DSH session's provider/model pair. A bounded route hint from
 * the formal per-session model selector wins for immediate pre-turn switches;
 * the incremental event fold remains the no-hint source and history fallback.
 * Both paths still pass through the shared identity resolver, remain O(new
 * events), and add no stream listener, provider request, cache, or usage ledger.
 */
export async function collectSessionContext(ctx, sessionId, config = { monitors: {} }, selectedRoute = null) {
	await collectUsage(ctx, config);
	const sessions = ctx.get("sessions");
	const live = sessions?.get?.(sessionId) ?? sessions?.list?.().find((session) => session.id === sessionId);
	if (live === void 0) return null;
	const cache = loadedCache;
	if (cache === null) return null;
	const state = cache.sessions[sessionId];
	if (state?.kind !== "live") return null;
	const currentRoute = selectedRoute ?? state.currentRoute;
	if (currentRoute === null || currentRoute === void 0) return null;
	const providers = await configuredProviders(ctx);
	const provider = providers.find((entry) => entry.id === currentRoute.providerId)
		?? { id: currentRoute.providerId, displayName: currentRoute.providerId };
	return {
		...currentSessionContext(sessionId, { ...state, currentRoute }, provider, config),
		session: renderSessionUsage(sessionId, state)
	};
}

/** Resolve the current account ids for every live session without a new ledger or provider guess. */
export async function collectActiveAccountIds(ctx, config = { monitors: {} }) {
	await collectUsage(ctx, config);
	const sessions = ctx.get("sessions")?.list?.() ?? [];
	const cache = loadedCache;
	if (cache === null) return [];
	const providers = await configuredProviders(ctx);
	const byId = new Map(providers.map((provider) => [provider.id, provider]));
	const accountIds = new Set();
	for (const session of sessions) {
		const state = cache.sessions[session.id];
		if (state?.kind !== "live" || state.currentRoute === null || state.currentRoute === void 0) continue;
		const provider = byId.get(state.currentRoute.providerId)
			?? { id: state.currentRoute.providerId, displayName: state.currentRoute.providerId };
		const context = currentSessionContext(session.id, state, provider, config);
		if (typeof context?.accountId === "string" && context.accountId !== "") accountIds.add(context.accountId);
	}
	return [...accountIds];
}

/** Session context is explicit in multi-session DSH; a single live session is unambiguous. */
async function handleSessionContext(ctx, config, accounts, req, res) {
	if (rejectForeignCaller(req, res)) return;
	try {
		// Client loader entries carry module identity, not the server Cordis
		// config. Keep the display policy server-owned on this existing request:
		// A hidden inline summary performs no usage fold or account read and renders null.
		if (config.display?.currentSessionPill === false) {
			json(res, 200, { ok: true, context: null, display: { currentSessionPill: false } });
			return;
		}
		const url = new URL(req.url ?? "/", "http://x");
		const requested = url.searchParams.get("session");
		const selectedProvider = url.searchParams.get("provider");
		const selectedModel = url.searchParams.get("model");
		if ((selectedProvider === null) !== (selectedModel === null)
			|| selectedProvider !== null && (selectedProvider === "" || selectedProvider.length > 256 || selectedProvider.includes("\0"))
			|| selectedModel !== null && (selectedModel === "" || selectedModel.length > 512 || selectedModel.includes("\0"))) {
			json(res, 400, { ok: false, error: "invalid-selection", message: "provider and model must be supplied together as bounded non-empty values" });
			return;
		}
		const sessions = ctx.get("sessions")?.list?.() ?? [];
		let sessionId = requested === null || requested === "" ? null : requested;
		if (sessionId === null && sessions.length === 1) sessionId = sessions[0].id;
		if (sessionId === null && sessions.length > 1) {
			json(res, 400, { ok: false, error: "session-required", message: "session query parameter is required when multiple sessions are live" });
			return;
		}
		if (sessionId === null) {
			json(res, 200, { ok: true, context: null });
			return;
		}
		if (!sessions.some((session) => session.id === sessionId)) {
			json(res, 404, { ok: false, error: "unknown-session", message: `session "${sessionId}" is not live` });
			return;
		}
		// The browser hint comes from DSH's formal per-session model directory.
		// It carries route identity only; configuredProviders + the shared resolver
		// below remain authoritative for family/account normalization.
		const selectedRoute = selectedProvider === null ? null : {
			providerId: selectedProvider,
			model: selectedModel,
			updatedAt: null
		};
		const context = await collectSessionContext(ctx, sessionId, config, selectedRoute);
		if (typeof context?.accountId === "string" && context.accountId !== "") accounts.touch?.(context.accountId, "active");
		json(res, 200, { ok: true, context, display: { currentSessionPill: true } });
	} catch (error) {
		ctx.logger.warn(`usage-stats: session context failed: ${String(error)}`);
		json(res, 500, { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) });
	}
}

async function handleProviders(ctx, accounts, req, res) {
	if (rejectForeignCaller(req, res)) return;
	try {
		json(res, 200, { ok: true, providers: await accounts.providerViews() });
	} catch (error) {
		ctx.logger.warn(`usage-stats: providers enumeration failed: ${String(error)}`);
		json(res, 500, { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) });
	}
}

/** Read secret-free preset state or perform the user's explicit path mutation. */
async function handleOrcaRouterIntegration(ctx, req, res) {
	if (req.method === "GET") {
		if (rejectForeignCaller(req, res)) return;
		try {
			json(res, 200, { ok: true, integration: orcaRouterIntegrationState(ctx.get("settings")) });
		} catch (error) {
			ctx.logger.warn(`usage-stats: OrcaRouter integration status failed: ${String(error)}`);
			json(res, 500, { ok: false, error: "internal", message: "settings status unavailable" });
		}
		return;
	}
	if (rejectForeignMutation(req, res)) return;
	try {
		const integration = await addOrcaRouterPreset(ctx.get("settings"));
		if (!integration.available) {
			json(res, 409, { ok: false, error: "settings-unavailable", message: "DSH provider settings are not writable" });
			return;
		}
		json(res, 200, { ok: true, integration });
	} catch (error) {
		const conflict = error?.code === "SETTINGS_CONFLICT";
		ctx.logger.warn(`usage-stats: OrcaRouter settings mutation failed (${conflict ? "conflict" : "rejected"})`);
		json(res, conflict ? 409 : 422, {
			ok: false,
			error: conflict ? "settings-conflict" : "settings-update-rejected",
			message: conflict ? "provider settings changed; retry the action" : "DSH rejected the provider preset"
		});
	}
}

async function selectedProviderId(req, accounts) {
	const url = new URL(req.url ?? "/", "http://x");
	const requested = url.searchParams.get("provider");
	if (requested !== null && requested !== "") return requested;
	const providers = await accounts.providerViews();
	return providers.find((entry) => entry.id === "deepseek-official")?.id
		?? providers.find((entry) => entry.configured)?.id
		?? providers[0]?.id
		?? null;
}

/** Unified account endpoint; cached by default, `refresh=1` forces upstream. */
async function handleAccount(ctx, accounts, req, res) {
	if (rejectForeignCaller(req, res)) return;
	try {
		const url = new URL(req.url ?? "/", "http://x");
		const providerId = await selectedProviderId(req, accounts);
		const requestedActivity = url.searchParams.get("activity");
		const activity = requestedActivity === "active" || requestedActivity === "detail" ? requestedActivity : null;
		const account = providerId === null ? null : await accounts.get(providerId, { force: url.searchParams.get("refresh") === "1", activity });
		if (account === null) {
			json(res, 200, { ok: false, error: "unknown-provider", message: `provider "${providerId}" is not configured` });
			return;
		}
		json(res, 200, { ok: true, account });
	} catch (error) {
		ctx.logger.warn(`usage-stats: account fetch failed: ${String(error)}`);
		json(res, 500, { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) });
	}
}

/** Backward-compatible balance route delegated to the account registry. */
async function handleBalance(ctx, accounts, req, res) {
	if (rejectForeignCaller(req, res)) return;
	try {
		const providerId = await selectedProviderId(req, accounts);
		const account = providerId === null ? null : await accounts.get(providerId);
		if (account === null) {
			json(res, 200, { ok: false, error: "unknown-provider", message: `provider "${providerId}" is not configured` });
			return;
		}
		if (account.mode !== "balance" || account.status === "unsupported") {
			json(res, 200, {
				ok: false,
				error: "unsupported",
				message: `${account.displayName} has no public balance interface`,
				provider: account.id
			});
			return;
		}
		if (account.status === "not-configured") {
			json(res, 200, {
				ok: false,
				error: "no-credential",
				message: account.missingCredentials?.[0] ?? "api key",
				provider: account.id
			});
			return;
		}
		if (account.balance === null || account.balance === void 0) {
			json(res, 502, { ok: false, error: "failed", message: account.status });
			return;
		}
		json(res, 200, {
			ok: true,
			provider: account.id,
			balance: {
				isAvailable: account.status === "ok" || account.stale === true,
				currency: account.balance.currency,
				total: account.balance.remaining,
				granted: account.balance.breakdown?.granted,
				toppedUp: account.balance.breakdown?.toppedUp
			},
			fetchedAt: account.fetchedAt
		});
	} catch (error) {
		ctx.logger.warn(`usage-stats: balance fetch failed: ${String(error)}`);
		json(res, 502, { ok: false, error: "failed", message: error instanceof Error ? error.message : String(error) });
	}
}

/** Query normalized percentage windows for subscription-style providers. */
async function handleSubscriptions(ctx, accounts, req, res) {
	if (rejectForeignCaller(req, res)) return;
	try {
		const subscriptions = (await accounts.subscriptionAccounts()).filter(Boolean).map((account) => (
			account.adapter === "zai-token-plan" ? { ...account, id: "zai" } : account
		));
		json(res, 200, { ok: true, subscriptions, fetchedAt: Date.now() });
	} catch (error) {
		ctx.logger.warn(`usage-stats: subscription usage failed: ${String(error)}`);
		json(res, 500, { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) });
	}
}

/** Existing five-minute usage fold plus an optional adaptive account scheduler. */
export function startBackgroundRefresh(ctx, accounts, deps = {}) {
	let running = false;
	let stopped = false;
	let active = Promise.resolve();
	let timer = null;
	let scheduleGeneration = 0;
	let nextUsageAt = 0;
	const now = deps.now ?? Date.now;
	const usageIntervalMs = deps.usageIntervalMs ?? ACCOUNT_REFRESH_MS;
	const setTimer = deps.setTimeout ?? setTimeout;
	const clearTimer = deps.clearTimeout ?? clearTimeout;
	const config = deps.config ?? { monitors: {} };
	const accountRefreshEnabled = deps.accountRefreshEnabled !== false;

	const clearScheduled = () => {
		if (timer === null) return;
		clearTimer(timer);
		timer = null;
	};

	const schedule = async () => {
		if (stopped) return;
		const generation = ++scheduleGeneration;
		clearScheduled();
		let accountNext = null;
		if (accountRefreshEnabled) {
			try {
				accountNext = await accounts.nextRefreshAt();
			} catch (error) {
				ctx.logger.warn(`usage-stats: refresh scheduling failed: ${String(error)}`);
			}
		}
		if (stopped || generation !== scheduleGeneration) return;
		const target = Math.min(accountNext ?? Infinity, nextUsageAt);
		const delay = Math.max(1000, Number.isFinite(target) ? target - now() : usageIntervalMs);
		timer = setTimer(() => {
			timer = null;
			void run();
		}, delay);
		timer?.unref?.();
	};

	const run = async (force = false) => {
		if (stopped) return;
		if (running) {
			await active;
			return force && !stopped ? run(true) : void 0;
		}
		clearScheduled();
		running = true;
		active = (async () => {
			const at = now();
			if (force || at >= nextUsageAt) {
				try {
					if (accountRefreshEnabled) accounts.setActiveProviders(await collectActiveAccountIds(ctx, config));
					else await collectUsage(ctx, config);
				} catch (error) {
					ctx.logger.warn(`usage-stats: background usage refresh failed: ${String(error)}`);
				}
				nextUsageAt = now() + usageIntervalMs;
			}
			if (accountRefreshEnabled) {
				try {
					await accounts.refreshDue({ force });
				} catch (error) {
					ctx.logger.warn(`usage-stats: background account refresh failed: ${String(error)}`);
				}
			}
		})().finally(() => {
			running = false;
		});
		await active;
		await schedule();
	};
	let unsubscribePolicyChanges = () => {};
	if (accountRefreshEnabled) {
		unsubscribePolicyChanges = accounts.subscribePolicyChanges?.(() => {
			// Activity changes only rearm this one central timer. The service remains
			// responsible for deciding whether an upstream refresh is actually due.
			if (!stopped && !running) void schedule();
		}) ?? unsubscribePolicyChanges;
	}
	const ready = run();
	const stop = async () => {
		stopped = true;
		scheduleGeneration += 1;
		clearScheduled();
		unsubscribePolicyChanges();
		await active;
	};
	stop.ready = ready;
	stop.refreshNow = () => run(true);
	return stop;
}

/**
 * Plugin body: register nine data routes plus the explicit integration route,
 * then start background refresh.
 * @param ctx - plugin context carrying webServer, credentials, sessions, sessionPersistence, settings, and llm.
 */
const Config = {
	"~standard": {
		version: 1,
		vendor: "dsh-usage-stats",
		validate(value) {
			try {
				return { value: validateConfig(value ?? {}) };
			} catch (error) {
				return { issues: [{ message: error instanceof Error ? error.message : String(error) }] };
			}
		}
	}
};

function validateConfig(raw = {}) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("plugin config must be an object");
	const display = raw.display ?? {};
	if (display === null || typeof display !== "object" || Array.isArray(display)) throw new Error("display must be an object");
	if (display.currentSessionPill !== void 0 && typeof display.currentSessionPill !== "boolean") {
		throw new Error("display.currentSessionPill must be a boolean");
	}
	return {
		...validateAccountConfig(raw),
		budgets: validateBudgetConfig(raw.budgets),
		display: { currentSessionPill: display.currentSessionPill !== false }
	};
}

async function apply(ctx, rawConfig = {}, deps = {}) {
	const config = validateConfig(rawConfig);
	const accounts = deps.accounts ?? createAccountService({
		credentials: ctx.get("credentials") ?? ctx.credentials,
		getProviders: () => configuredProviders(ctx),
		config,
		deps: { timeoutMs: UPSTREAM_TIMEOUT_MS }
	});
	// Provider ids come from the async Harness settings service, so this dynamic
	// part of config validation must finish before any routes or timers start.
	await accounts.validate();
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: USAGE_PATH,
		handler: (req, res) => handleUsage(ctx, config, req, res)
	}), "usage-stats: usage route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: PROVIDERS_PATH,
		handler: (req, res) => handleProviders(ctx, accounts, req, res)
	}), "usage-stats: providers route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: ACCOUNT_PATH,
		handler: (req, res) => handleAccount(ctx, accounts, req, res)
	}), "usage-stats: account route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: BALANCE_PATH,
		handler: (req, res) => handleBalance(ctx, accounts, req, res)
	}), "usage-stats: balance route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: SUBSCRIPTIONS_PATH,
		handler: (req, res) => handleSubscriptions(ctx, accounts, req, res)
	}), "usage-stats: subscriptions route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: SESSION_CONTEXT_PATH,
		handler: (req, res) => handleSessionContext(ctx, config, accounts, req, res)
	}), "usage-stats: session context route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: ORCAROUTER_INTEGRATION_PATH,
		handler: (req, res) => handleOrcaRouterIntegration(ctx, req, res)
	}), "usage-stats: optional OrcaRouter integration route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: DAILY_EXPORT_PATH,
		handler: (req, res) => handleDailyExport(ctx, config, req, res)
	}), "usage-stats: daily CSV export route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: SESSIONS_EXPORT_PATH,
		handler: (req, res) => handleSessionsExport(ctx, config, req, res)
	}), "usage-stats: sessions CSV export route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: JSON_EXPORT_PATH,
		handler: (req, res) => handleJsonExport(ctx, config, accounts, req, res)
	}), "usage-stats: JSON export route");
	if (deps.disableBackgroundRefresh !== true) ctx.effect(() => startBackgroundRefresh(ctx, accounts, {
		config,
		accountRefreshEnabled: config.refresh.enabled
	}), "usage-stats: background usage/account refresh");
}

export { apply, Config, inject, name, USAGE_PATH, PROVIDERS_PATH, BALANCE_PATH, SUBSCRIPTIONS_PATH, ACCOUNT_PATH, SESSION_CONTEXT_PATH, DAILY_EXPORT_PATH, SESSIONS_EXPORT_PATH, JSON_EXPORT_PATH, ORCAROUTER_INTEGRATION_PATH, configuredProviders, totalTokens, validateConfig, zeroBuckets };
