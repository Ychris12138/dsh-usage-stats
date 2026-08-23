/**
 * dsh-usage-stats — server half.
 *
 * Registers six read-only, loopback-only endpoints on the web server:
 *   GET /api/usage-stats/usage         — per-day token usage across every session
 *   GET /api/usage-stats/providers     — configured providers + balance schemes
 *   GET /api/usage-stats/balance       — balance for one provider (?provider=<id>)
 *   GET /api/usage-stats/subscriptions — OpenCode Go + Z.ai quota windows
 *   GET /api/usage-stats/account       — unified account snapshot for one provider
 *   GET /api/usage-stats/session-context — provider/model context for one live session
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
import { applyUsageDelta, createUsageState, currentSessionContext, mergeInto, renderUsage, resetUsageState, totalTokens, zeroBuckets } from "./usage.js";
import { ACCOUNT_REFRESH_MS, createAccountService, validateAccountConfig } from "./accounts.js";

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
const UPSTREAM_TIMEOUT_MS = 15000;
const CACHE_VERSION = 4;

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
		consumed: state.consumed ?? 0,
		...(state.revision === void 0 ? {} : { revision: state.revision }),
		days,
		lastSample: state.lastSample === null ? null : {
			key: state.lastSample.key,
			day: state.lastSample.day,
			model: state.lastSample.model,
			buckets: { ...state.lastSample.buckets }
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
			buckets: {
				inputTokens: Number.isFinite(buckets.inputTokens) ? buckets.inputTokens : 0,
				outputTokens: Number.isFinite(buckets.outputTokens) ? buckets.outputTokens : 0,
				cacheReadTokens: Number.isFinite(buckets.cacheReadTokens) ? buckets.cacheReadTokens : 0,
				cacheWriteTokens: Number.isFinite(buckets.cacheWriteTokens) ? buckets.cacheWriteTokens : 0
			}
		};
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

/** Load the cache once per process; any corruption degrades to a fresh cache. */
async function loadCache() {
	if (loadedCache !== null) return loadedCache;
	loadPromise ??= (async () => {
		const fresh = { version: CACHE_VERSION, sessions: {} };
		try {
			const raw = await readFile(cachePath(), "utf8");
			const parsed = JSON.parse(raw);
			if (parsed !== null && typeof parsed === "object" && parsed.version === CACHE_VERSION && parsed.sessions !== null && typeof parsed.sessions === "object") {
				const sessions = {};
				for (const [id, entry] of Object.entries(parsed.sessions)) {
					if (typeof id === "string" && id.length > 0) sessions[id] = parseSession(entry);
				}
				return { version: CACHE_VERSION, sessions };
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
		const serialized = { version: CACHE_VERSION, sessions: {} };
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
export async function collectUsage(ctx) {
	return withLock(async () => {
		const cache = await loadCache();
		const live = ctx.get("sessions");
		const attached = new Set();
		if (live !== void 0) {
			for (const session of live.list()) {
				attached.add(session.id);
				const state = cache.sessions[session.id] ?? createUsageState();
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
					applyUsageDelta(state, session.events.slice(state.consumed ?? 0));
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
							applyUsageDelta(state, allEvents);
							state.consumed = allEvents.length > 0 ? allEvents[allEvents.length - 1].seq : 0;
						} else if (fresh.length > 0) {
							applyUsageDelta(state, fresh);
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
		for (const state of Object.values(cache.sessions)) mergeInto(byDay, state.days);
		// Keep the atomic cache write inside the single-flight section. Otherwise
		// overlapping saves can race on the same temporary file.
		await saveCache(ctx, cache);
		return renderUsage(byDay, Date.now());
	});
}

async function handleUsage(ctx, req, res) {
	if (rejectForeignCaller(req, res)) return;
	try {
		const result = await collectUsage(ctx);
		json(res, 200, { ok: true, ...result });
	} catch (error) {
		ctx.logger.warn(`usage-stats: usage aggregation failed: ${String(error)}`);
		json(res, 500, { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) });
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
	await collectUsage(ctx);
	const sessions = ctx.get("sessions");
	const live = sessions?.get?.(sessionId) ?? sessions?.list?.().find((session) => session.id === sessionId);
	if (live === void 0) return null;
	const cache = await loadCache();
	const state = cache.sessions[sessionId];
	if (state?.kind !== "live") return null;
	const currentRoute = selectedRoute ?? state.currentRoute;
	if (currentRoute === null || currentRoute === void 0) return null;
	const providers = await configuredProviders(ctx);
	const provider = providers.find((entry) => entry.id === currentRoute.providerId)
		?? { id: currentRoute.providerId, displayName: currentRoute.providerId };
	return currentSessionContext(sessionId, { ...state, currentRoute }, provider, config);
}

/** Session context is explicit in multi-session DSH; a single live session is unambiguous. */
async function handleSessionContext(ctx, config, req, res) {
	if (rejectForeignCaller(req, res)) return;
	try {
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
		json(res, 200, { ok: true, context: await collectSessionContext(ctx, sessionId, config, selectedRoute) });
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
		const account = providerId === null ? null : await accounts.get(providerId, { force: url.searchParams.get("refresh") === "1" });
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

/** Start an immediate refresh and repeat account + local usage refresh every 5 minutes. */
export function startBackgroundRefresh(ctx, accounts, deps = {}) {
	let running = false;
	let stopped = false;
	let active = Promise.resolve();
	const run = async () => {
		if (running || stopped) return;
		running = true;
		active = (async () => {
			const results = await Promise.allSettled([accounts.refreshAll(), collectUsage(ctx)]);
			for (const result of results) if (result.status === "rejected") ctx.logger.warn(`usage-stats: background refresh failed: ${String(result.reason)}`);
		})().finally(() => {
			running = false;
		});
		return active;
	};
	void run();
	const setTimer = deps.setInterval ?? setInterval;
	const clearTimer = deps.clearInterval ?? clearInterval;
	const timer = setTimer(run, deps.intervalMs ?? ACCOUNT_REFRESH_MS);
	timer?.unref?.();
	const stop = async () => {
		stopped = true;
		clearTimer(timer);
		await active;
	};
	stop.refreshNow = async () => {
		await active;
		return run();
	};
	return stop;
}

/**
 * Plugin body: register the five exact routes and start background refresh.
 * @param ctx - plugin context carrying webServer, credentials, sessions, sessionPersistence, settings, and llm.
 */
const Config = {
	"~standard": {
		version: 1,
		vendor: "dsh-usage-stats",
		validate(value) {
			try {
				return { value: validateAccountConfig(value ?? {}) };
			} catch (error) {
				return { issues: [{ message: error instanceof Error ? error.message : String(error) }] };
			}
		}
	}
};

async function apply(ctx, rawConfig = {}, deps = {}) {
	const config = validateAccountConfig(rawConfig);
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
		handler: (req, res) => handleUsage(ctx, req, res)
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
		handler: (req, res) => handleSessionContext(ctx, config, req, res)
	}), "usage-stats: session context route");
	if (deps.disableBackgroundRefresh !== true) ctx.effect(() => startBackgroundRefresh(ctx, accounts), "usage-stats: background account refresh");
}

export { apply, Config, inject, name, USAGE_PATH, PROVIDERS_PATH, BALANCE_PATH, SUBSCRIPTIONS_PATH, ACCOUNT_PATH, SESSION_CONTEXT_PATH, configuredProviders, totalTokens, zeroBuckets };
