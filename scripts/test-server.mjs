import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pricingFingerprint } from "../lib/billing.js";

function usageEvent(seq, inputTokens) {
	return {
		seq,
		time: Date.UTC(2026, 7, 13),
		type: "assistant/message",
		data: {
			turn: `turn-${seq}`,
			step: 0,
			usage: { inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
			message: { source: { model: "deepseek-chat" } }
		}
	};
}

function routeEvent(seq, provider, model) {
	return {
		seq,
		time: Date.UTC(2026, 7, 23, 12, 0, seq),
		type: "request/header",
		data: { header: { config: { provider, model } } }
	};
}

function pricedUsageEvent(seq, time, provider, model, inputTokens) {
	return {
		seq,
		time,
		type: "assistant/message",
		data: {
			turn: `priced-${seq}`,
			step: 0,
			usage: { inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
			message: { source: { provider, model } }
		}
	};
}

async function freshModule(label, home) {
	process.env.DSH_HOME = home;
	return import(new URL(`../lib/index.js?test=${label}-${Date.now()}-${Math.random()}`, import.meta.url));
}

function makeResponse() {
	return {
		status: null,
		headers: {},
		body: "",
		writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
		end(body = "") { this.body = body; }
	};
}

function makeContext({ sessions, persistence, routes, settings } = {}) {
	return {
		logger: { warn: () => {} },
		credentials: { resolve: async () => void 0 },
		webServer: { register: (entry) => { routes?.set(entry.path, entry.handler); return () => {}; } },
		effect: (register) => register(),
		get: (name) => name === "sessions" ? sessions : name === "sessionPersistence" ? persistence : name === "settings" ? settings : void 0
	};
}

async function testRouteFence(root) {
	const plugin = await freshModule("routes", join(root, "routes"));
	const routes = new Map();
	const empty = { list: () => [] };
	const persistence = { listSnapshots: async () => [], list: async () => [] };
	await plugin.apply(makeContext({ sessions: empty, persistence, routes }), {}, { disableBackgroundRefresh: true });
	const handler = routes.get(plugin.USAGE_PATH);
	assert.equal(typeof handler, "function");

	const ipv6 = makeResponse();
	await handler({ method: "GET", headers: { host: "[::1]:3080" }, socket: { remoteAddress: "::1" } }, ipv6);
	assert.equal(ipv6.status, 200, "bracketed IPv6 loopback must be accepted");

	const foreign = makeResponse();
	await handler({ method: "GET", headers: { host: "localhost:3080" }, socket: { remoteAddress: "203.0.113.7" } }, foreign);
	assert.equal(foreign.status, 403, "a spoofed Host must not bypass the peer fence");

	const head = makeResponse();
	await handler({ method: "HEAD", headers: { host: "localhost:3080" }, socket: { remoteAddress: "127.0.0.1" } }, head);
	assert.equal(head.status, 405, "the endpoints are GET-only");

	const subscriptions = makeResponse();
	await routes.get(plugin.SUBSCRIPTIONS_PATH)({ method: "GET", url: plugin.SUBSCRIPTIONS_PATH, headers: { host: "localhost:3080" }, socket: { remoteAddress: "127.0.0.1" } }, subscriptions);
	assert.equal(subscriptions.status, 200);
	assert.deepEqual(JSON.parse(subscriptions.body).subscriptions.map((provider) => provider.status), ["not-configured", "not-configured"]);

	const account = makeResponse();
	await routes.get(plugin.ACCOUNT_PATH)({ method: "GET", url: `${plugin.ACCOUNT_PATH}?provider=deepseek-official`, headers: { host: "localhost:3080" }, socket: { remoteAddress: "127.0.0.1" } }, account);
	assert.equal(account.status, 200);
	assert.equal(JSON.parse(account.body).account.status, "not-configured");
	assert.equal(typeof routes.get(plugin.SESSION_CONTEXT_PATH), "function");
}

async function testOrcaRouterIntegrationRoute(root) {
	const plugin = await freshModule("orcarouter-integration", join(root, "orcarouter-integration"));
	const routes = new Map();
	let revision = 3;
	let providers = { company: { displayName: "Company", baseURL: "https://relay.invalid/v1" } };
	let writes = 0;
	const settings = {
		describe: (options) => {
			assert.equal(options?.redactSecrets, true);
			return [{ ns: "llm-pi-ai", revision, value: { providers: structuredClone(providers) } }];
		},
		mutate: async (ns, ops, expectedRevision) => {
			writes += 1;
			assert.equal(ns, "llm-pi-ai");
			assert.equal(expectedRevision, revision);
			assert.deepEqual(ops[0].path, ["providers", "orcarouter"]);
			assert.deepEqual(Object.keys(ops[0].value).sort(), ["api", "apiKeyEnv", "baseURL", "displayName", "models"]);
			providers = { ...providers, orcarouter: structuredClone(ops[0].value) };
			revision += 1;
		}
	};
	const accounts = {
		validate: async () => {},
		providerViews: async () => [],
		get: async () => null,
		subscriptionAccounts: async () => []
	};
	await plugin.apply(makeContext({
		sessions: { list: () => [] },
		persistence: { listSnapshots: async () => [], list: async () => [] },
		routes,
		settings
	}), {}, { disableBackgroundRefresh: true, accounts });
	const handler = routes.get(plugin.ORCAROUTER_INTEGRATION_PATH);
	assert.equal(typeof handler, "function");

	const status = makeResponse();
	await handler({
		method: "GET",
		headers: { host: "localhost:3080" },
		socket: { remoteAddress: "127.0.0.1" }
	}, status);
	assert.equal(status.status, 200);
	assert.deepEqual(JSON.parse(status.body), { ok: true, integration: { available: true, installed: false } });
	assert.doesNotMatch(status.body, /ORCAROUTER_API_KEY|baseURL|company|relay\.invalid/i, "the status wire must not expose settings or credential references");

	const missingActionHeader = makeResponse();
	await handler({
		method: "POST",
		headers: { host: "localhost:3080", "content-type": "application/json" },
		socket: { remoteAddress: "127.0.0.1" }
	}, missingActionHeader);
	assert.equal(missingActionHeader.status, 403, "the write endpoint must require a non-simple same-origin action header");
	assert.equal(writes, 0);

	const foreign = makeResponse();
	await handler({
		method: "POST",
		headers: {
			host: "localhost:3080",
			"content-type": "application/json",
			"x-dsh-usage-stats-action": "add-orcarouter"
		},
		socket: { remoteAddress: "203.0.113.8" }
	}, foreign);
	assert.equal(foreign.status, 403);
	assert.equal(writes, 0);

	const add = makeResponse();
	await handler({
		method: "POST",
		headers: {
			host: "localhost:3080",
			"content-type": "application/json; charset=utf-8",
			"x-dsh-usage-stats-action": "add-orcarouter"
		},
		socket: { remoteAddress: "::1" }
	}, add);
	assert.equal(add.status, 200);
	assert.deepEqual(JSON.parse(add.body), { ok: true, integration: { available: true, installed: true, added: true } });
	assert.deepEqual(providers.company, { displayName: "Company", baseURL: "https://relay.invalid/v1" }, "the exact path mutation must preserve unrelated providers");
	assert.equal(writes, 1);

	const repeated = makeResponse();
	await handler({
		method: "POST",
		headers: {
			host: "localhost:3080",
			"content-type": "application/json",
			"x-dsh-usage-stats-action": "add-orcarouter"
		},
		socket: { remoteAddress: "127.0.0.1" }
	}, repeated);
	assert.deepEqual(JSON.parse(repeated.body), { ok: true, integration: { available: true, installed: true, added: false } });
	assert.equal(writes, 1, "the HTTP action must also be idempotent");
}

async function testSessionContext(root) {
	const plugin = await freshModule("session-context", join(root, "session-context"));
	const routes = new Map();
	const events = [routeEvent(0, "route-a", "shared-model")];
	const session = { id: "live-session", events };
	let liveSessions = [session];
	const sessions = {
		get: (id) => liveSessions.find((entry) => entry.id === id),
		list: () => liveSessions
	};
	const persistence = { listSnapshots: async () => [], list: async () => [] };
	const settings = {
		get: (name) => name === "llm-pi-ai" ? {
			providers: {
				"route-a": {
					displayName: "Friendly label",
					baseURL: "https://api.deepseek.com/v1",
					apiKeyEnv: "SECRET_API_KEY_REFERENCE"
				},
				"route-b": {
					displayName: "Another label",
					baseURL: "https://api.ollama.com/v1",
					apiKeyEnv: "OTHER_SECRET_REFERENCE"
				}
			}
		} : void 0
	};
	const touches = [];
	const accounts = {
		validate: async () => {},
		touch: (providerId, activity) => touches.push([providerId, activity]),
		providerViews: async () => [],
		get: async () => null,
		subscriptionAccounts: async () => []
	};
	await plugin.apply(makeContext({ sessions, persistence, routes, settings }), {}, { disableBackgroundRefresh: true, accounts });
	const handler = routes.get(plugin.SESSION_CONTEXT_PATH);

	const first = makeResponse();
	await handler({ method: "GET", url: `${plugin.SESSION_CONTEXT_PATH}?session=live-session`, headers: { host: "localhost:3080" }, socket: { remoteAddress: "127.0.0.1" } }, first);
	assert.equal(first.status, 200);
	const firstContext = JSON.parse(first.body).context;
	assert.deepEqual({ ...firstContext, session: void 0 }, {
		sessionId: "live-session",
		providerId: "route-a",
		providerFamily: "deepseek",
		model: "shared-model",
		accountId: "route-a",
		updatedAt: Date.UTC(2026, 7, 23, 12, 0, 0),
		session: void 0
	});
	assert.equal(firstContext.session.sessionId, "live-session");
	assert.equal(firstContext.session.tokens, 0);
	assert.doesNotMatch(first.body, /SECRET|apiKey|baseURL/i, "session context must not expose connection or credential fields");
	assert.deepEqual(touches.at(-1), ["route-a", "active"], "session context must signal only its resolver-owned account identity");

	const selectorSwitched = makeResponse();
	await handler({ method: "GET", url: `${plugin.SESSION_CONTEXT_PATH}?session=live-session&provider=route-b&model=shared-model`, headers: { host: "localhost:3080" }, socket: { remoteAddress: "127.0.0.1" } }, selectorSwitched);
	const switchedContext = JSON.parse(selectorSwitched.body).context;
	assert.deepEqual({ ...switchedContext, session: void 0 }, {
		sessionId: "live-session",
		providerId: "route-b",
		providerFamily: "ollama",
		model: "shared-model",
		accountId: "route-b",
		updatedAt: null,
		session: void 0
	}, "an accepted selector route must override the last request/header immediately");
	assert.deepEqual(switchedContext.session, firstContext.session, "selector hints must not rewrite historical session billing");
	assert.deepEqual(touches.at(-1), ["route-b", "active"], "selector route changes must update central scheduler activity");
	const hiddenRoutes = new Map();
	const touchCountBeforeHidden = touches.length;
	await plugin.apply(makeContext({ sessions, persistence, routes: hiddenRoutes, settings }), {
		display: { currentSessionPill: false }
	}, { disableBackgroundRefresh: true, accounts });
	const hidden = makeResponse();
	await hiddenRoutes.get(plugin.SESSION_CONTEXT_PATH)({
		method: "GET",
		url: `${plugin.SESSION_CONTEXT_PATH}?session=live-session`,
		headers: { host: "localhost:3080" },
		socket: { remoteAddress: "127.0.0.1" }
	}, hidden);
	assert.equal(hidden.status, 200);
	assert.deepEqual(JSON.parse(hidden.body), { ok: true, context: null, display: { currentSessionPill: false } });
	assert.equal(touches.length, touchCountBeforeHidden, "a hidden Pill must not touch the account scheduler");
	const invalidSelectionQueries = [
		"provider=route-b",
		"provider=route-b&model=",
		`provider=${"p".repeat(257)}&model=m`,
		`provider=p&model=${"m".repeat(513)}`,
		"provider=route%00b&model=m",
		"provider=route-b&model=m%00"
	];
	for (const query of invalidSelectionQueries) {
		const invalidSelection = makeResponse();
		await handler({ method: "GET", url: `${plugin.SESSION_CONTEXT_PATH}?session=live-session&${query}`, headers: { host: "localhost:3080" }, socket: { remoteAddress: "127.0.0.1" } }, invalidSelection);
		assert.equal(invalidSelection.status, 400, `invalid selector hint must fail closed: ${query.slice(0, 80)}`);
		assert.equal(JSON.parse(invalidSelection.body).error, "invalid-selection");
	}
	const boundaryProvider = "p".repeat(256);
	const boundaryModel = "m".repeat(512);
	const boundarySelection = makeResponse();
	await handler({ method: "GET", url: `${plugin.SESSION_CONTEXT_PATH}?session=live-session&provider=${boundaryProvider}&model=${boundaryModel}`, headers: { host: "localhost:3080" }, socket: { remoteAddress: "127.0.0.1" } }, boundarySelection);
	assert.equal(boundarySelection.status, 200, "bounded selector hint limits must be inclusive");
	assert.equal(JSON.parse(boundarySelection.body).context.providerId, boundaryProvider);
	assert.equal(JSON.parse(boundarySelection.body).context.model, boundaryModel);

	events.push(routeEvent(1, "route-b", "shared-model"));
	const switched = makeResponse();
	await handler({ method: "GET", url: plugin.SESSION_CONTEXT_PATH, headers: { host: "localhost:3080" }, socket: { remoteAddress: "127.0.0.1" } }, switched);
	assert.equal(switched.status, 200, "one live session may be selected without guessing");
	assert.equal(JSON.parse(switched.body).context.providerId, "route-b");
	assert.equal(JSON.parse(switched.body).context.providerFamily, "ollama");
	assert.equal(JSON.parse(switched.body).context.model, "shared-model");

	const missing = makeResponse();
	await handler({ method: "GET", url: `${plugin.SESSION_CONTEXT_PATH}?session=missing`, headers: { host: "localhost:3080" }, socket: { remoteAddress: "127.0.0.1" } }, missing);
	assert.equal(missing.status, 404);
	assert.equal(JSON.parse(missing.body).error, "unknown-session");

	liveSessions = [session, { id: "second-session", events: [] }];
	const ambiguous = makeResponse();
	await handler({ method: "GET", url: plugin.SESSION_CONTEXT_PATH, headers: { host: "localhost:3080" }, socket: { remoteAddress: "127.0.0.1" } }, ambiguous);
	assert.equal(ambiguous.status, 400, "multiple live sessions require an explicit id instead of guessing the active browser session");
	assert.equal(JSON.parse(ambiguous.body).error, "session-required");
}

async function testV4CacheUpgradeRefoldsBilling(root) {
	const home = join(root, "v4-cache-upgrade");
	const storage = join(home, "storages");
	await mkdir(storage, { recursive: true });
	const sessionId = "cached-live-session";
	await writeFile(join(storage, "usage-stats-cache.json"), JSON.stringify({
		version: 4,
		sessions: {
			[sessionId]: {
				kind: "live",
				consumed: 2,
				days: {},
				lastSample: null,
				currentModel: "route-a/deepseek-chat"
			}
		}
	}), "utf8");
	const plugin = await freshModule("v4-cache-upgrade", home);
	const eventTime = Date.UTC(2026, 7, 24, 2, 0, 0);
	const session = { id: sessionId, events: [
		routeEvent(0, "route-a", "deepseek-v4-pro"),
		pricedUsageEvent(1, eventTime, "route-a", "deepseek-v4-pro", 1_000_000)
	] };
	const settings = {
		get: (name) => name === "llm-pi-ai" ? {
			providers: {
				"route-a": { displayName: "Route A", baseURL: "https://api.deepseek.com/v1" }
			}
		} : void 0
	};
	const context = makeContext({
		sessions: { get: (id) => id === sessionId ? session : void 0, list: () => [session] },
		persistence: { listSnapshots: async () => [], list: async () => [] },
		settings
	});

	const migratedContext = await plugin.collectSessionContext(context, sessionId);
	assert.deepEqual({ ...migratedContext, session: void 0 }, {
		sessionId,
		providerId: "route-a",
		providerFamily: "deepseek",
		model: "deepseek-v4-pro",
		accountId: "route-a",
		updatedAt: eventTime,
		session: void 0
	}, "a v4 cache without billing must be invalidated and refolded even when no event is new");
	assert.equal(migratedContext.session.costComplete, true);
	assert.equal(migratedContext.session.currency, "USD");
	assert.equal(migratedContext.session.tokens, 1_000_000);
	const migrated = JSON.parse(await readFile(join(storage, "usage-stats-cache.json"), "utf8"));
	assert.equal(migrated.version, 5, "the rewritten cache must use schema v5");
	assert.equal(typeof migrated.pricingFingerprint, "string");
	assert.equal(migrated.sessions[sessionId].currentRoute.providerId, "route-a");
	assert.equal(migrated.sessions[sessionId].billing.sampleCount, 1);
}

async function testPricingFingerprintInvalidatesDerivedCosts(root) {
	const home = join(root, "pricing-fingerprint");
	const storage = join(home, "storages");
	await mkdir(storage, { recursive: true });
	const sessionId = "fingerprint-session";
	const oldFingerprint = JSON.parse(pricingFingerprint({ providers: [{
		id: "deepseek-official",
		displayName: "DeepSeek",
		baseURL: "https://api.deepseek.com"
	}] }));
	oldFingerprint.pricingCatalog = [];
	await writeFile(join(storage, "usage-stats-cache.json"), JSON.stringify({
		version: 5,
		pricingFingerprint: JSON.stringify(oldFingerprint),
		sessions: {
			[sessionId]: {
				kind: "live",
				consumed: 1,
				days: {},
				lastSample: null,
				currentModel: "deepseek-official/deepseek-v4-pro"
			}
		}
	}), "utf8");
	const plugin = await freshModule("pricing-fingerprint", home);
	const eventTime = Date.UTC(2026, 7, 24, 2, 0, 0);
	const session = { id: sessionId, events: [pricedUsageEvent(0, eventTime, "deepseek-official", "deepseek-v4-pro", 1_000_000)] };
	const usage = await plugin.collectUsage(makeContext({
		sessions: { list: () => [session] },
		persistence: { listSnapshots: async () => [], list: async () => [] },
		settings: { get: () => void 0 }
	}));
	assert.equal(usage.sessions[0].costComplete, true, "a catalog-only fingerprint change with unchanged provider identity may safely refold event-time costs");
	assert.equal(usage.sessions[0].tokens, 1_000_000);
	const rewritten = JSON.parse(await readFile(join(storage, "usage-stats-cache.json"), "utf8"));
	assert.notEqual(rewritten.pricingFingerprint, JSON.stringify(oldFingerprint));
	assert.equal(rewritten.pricingIdentityCutoffAll, null, "catalog-only changes must not invent a provider identity cutoff");
}

async function testRuntimeProviderPricingIdentityChange(root) {
	const home = join(root, "runtime-provider-pricing-identity");
	const plugin = await freshModule("runtime-provider-pricing-identity", home);
	const eventTime = Date.UTC(2026, 7, 24, 2, 0, 0);
	const oldSession = { id: "old-route-session", events: [pricedUsageEvent(0, eventTime, "route-a", "deepseek-v4-pro", 1_000_000)] };
	const liveSessions = [oldSession];
	let baseURL = "https://api.deepseek.com/v1";
	const settings = {
		get: (name) => name === "llm-pi-ai" ? {
			providers: { "route-a": { displayName: "Route A", baseURL } }
		} : void 0
	};
	const context = makeContext({
		sessions: { list: () => liveSessions },
		persistence: { listSnapshots: async () => [], list: async () => [] },
		settings
	});

	const official = await plugin.collectUsage(context);
	assert.equal(official.sessions.find((session) => session.sessionId === oldSession.id).costComplete, true);
	const officialCache = JSON.parse(await readFile(join(home, "storages", "usage-stats-cache.json"), "utf8"));

	baseURL = "https://username:password@relay.invalid/v1?token=SECRET";
	const custom = await plugin.collectUsage(context);
	assert.equal(custom.sessions.find((session) => session.sessionId === oldSession.id).estimatedCost, null,
		"official to custom must invalidate the already-loaded in-memory billing cache");
	const customCacheText = await readFile(join(home, "storages", "usage-stats-cache.json"), "utf8");
	const customCache = JSON.parse(customCacheText);
	assert.notEqual(customCache.pricingFingerprint, officialCache.pricingFingerprint);
	assert.equal(Number.isFinite(customCache.pricingIdentityCutoffs["route-a"]), true);
	assert.doesNotMatch(customCache.pricingFingerprint, /username|password|token=|SECRET/i,
		"runtime fingerprint must never persist URL credentials or query secrets");

	baseURL = "https://api.deepseek.com/v1";
	const restoredOfficial = await plugin.collectUsage(context);
	assert.equal(restoredOfficial.sessions.find((session) => session.sessionId === oldSession.id).estimatedCost, null,
		"custom to official must not reinterpret historical custom-relay usage as official usage");
	const restoredCache = JSON.parse(await readFile(join(home, "storages", "usage-stats-cache.json"), "utf8"));
	assert.notEqual(restoredCache.pricingFingerprint, customCache.pricingFingerprint);
	assert.equal(restoredCache.pricingIdentityCutoffs["route-a"] >= customCache.pricingIdentityCutoffs["route-a"], true);

	const futureAt = restoredCache.pricingIdentityCutoffs["route-a"] + 1;
	liveSessions.push({ id: "new-official-session", events: [pricedUsageEvent(0, futureAt, "route-a", "deepseek-v4-pro", 1_000_000)] });
	const future = await plugin.collectUsage(context);
	assert.equal(future.sessions.find((session) => session.sessionId === oldSession.id).costComplete, false);
	assert.equal(future.sessions.find((session) => session.sessionId === "new-official-session").costComplete, true,
		"events after the observed identity transition may use the new official pricing identity");
}

async function testConfigValidation(root) {
	const plugin = await freshModule("config", join(root, "config"));
	const validated = plugin.Config["~standard"].validate({
		refresh: { enabled: false, activeMs: 120000, detailMs: 180000, backgroundMs: 240000 },
		monitors: {}
	});
	assert.deepEqual(validated.issues, void 0);
	assert.deepEqual(validated.value.refresh, { enabled: false, activeMs: 120000, detailMs: 180000, backgroundMs: 240000 });
	assert.deepEqual(validated.value.budgets, { currency: "USD", daily: null, monthly: null });
	assert.deepEqual(validated.value.display, { currentSessionPill: true });
	assert.deepEqual(validated.value.monitors, {}, "release hardening must not insert account monitors into normalized user config");
	const legacyMonitor = plugin.Config["~standard"].validate({ monitors: {
		relay: { adapter: "general", usageBaseURL: "https://relay.example.com", credentialRef: "RELAY_KEY" }
	} }).value.monitors.relay;
	assert.equal(legacyMonitor.adapter, "general");
	assert.equal(legacyMonitor.credentialRef, "RELAY_KEY", "existing v0.2.10 monitor references must remain compatible");
	assert.deepEqual(plugin.Config["~standard"].validate({ display: { currentSessionPill: true } }).value.display, { currentSessionPill: true }, "legacy enabled display key must remain an accepted no-op");
	assert.deepEqual(plugin.Config["~standard"].validate({ display: { currentSessionPill: false } }).value.display, { currentSessionPill: false });
	assert.deepEqual(plugin.Config["~standard"].validate({ budgets: { currency: "CNY", daily: 5, monthly: 100 } }).value.budgets, { currency: "CNY", daily: 5, monthly: 100 });
	assert.match(plugin.Config["~standard"].validate({ display: { currentSessionPill: "no" } }).issues[0].message, /display\.currentSessionPill/);
	assert.match(plugin.Config["~standard"].validate({ display: [] }).issues[0].message, /display must be an object/);
	assert.match(plugin.Config["~standard"].validate({ budgets: { daily: 0 } }).issues[0].message, /budgets\.daily/);
	assert.equal(plugin.Config["~standard"].validate({ disableBackgroundRefresh: true }).value.refresh.enabled, false);
	assert.match(plugin.Config["~standard"].validate({ refresh: { activeMs: 1 } }).issues[0].message, /refresh\.activeMs/);
	assert.match(plugin.Config["~standard"].validate({ monitors: { relay: { adapter: "missing" } } }).issues[0].message, /adapter is unsupported/);
	const routes = new Map();
	const context = makeContext({
		sessions: { list: () => [] },
		persistence: { listSnapshots: async () => [], list: async () => [] },
		routes,
		settings: { get: () => void 0 }
	});
	await assert.rejects(
		() => plugin.apply(context, { display: [] }, { disableBackgroundRefresh: true }),
		/display must be an object/
	);
	assert.equal(routes.size, 0, "malformed display settings must fail before routes are registered");
	await assert.rejects(
		() => plugin.apply(context, { monitors: { missing: { adapter: "general" } } }, { disableBackgroundRefresh: true }),
		/unknown provider: missing/
	);
	assert.equal(routes.size, 0, "invalid provider config must fail before routes are registered");
}

async function testExportRoutes(root) {
	const plugin = await freshModule("export-routes", join(root, "export-routes"));
	const routes = new Map();
	const secret = "SECRET_EXPORT_CREDENTIAL";
	const eventTime = Date.UTC(2026, 7, 26, 12, 0, 0);
	const context = makeContext({
		sessions: { list: () => [{
			id: "export-session",
			title: "=1+1 中文,\"quoted\"",
			events: [pricedUsageEvent(0, eventTime, "deepseek-official", "deepseek-v4-pro", 1_000_000)]
		}] },
		persistence: { listSnapshots: async () => [], list: async () => [] },
		routes,
		settings: {
			get: (name) => name === "llm-deepseek" ? {
				apiKeyEnv: secret,
				baseURL: `https://api.deepseek.com/v1?token=${secret}`
			} : void 0
		}
	});
	await plugin.apply(context, {}, { disableBackgroundRefresh: true });
	assert.equal(routes.size, 10, "the plugin must register six data views, three exports, and the explicit OrcaRouter settings action");

	const request = (path) => ({ method: "GET", url: path, headers: { host: "localhost:3080" }, socket: { remoteAddress: "127.0.0.1" } });
	const daily = makeResponse();
	await routes.get(plugin.DAILY_EXPORT_PATH)(request(plugin.DAILY_EXPORT_PATH), daily);
	assert.equal(daily.status, 200);
	assert.equal(daily.headers["content-type"], "text/csv; charset=utf-8");
	assert.equal(daily.headers["content-disposition"], 'attachment; filename="dsh-usage-daily.csv"');
	assert.match(daily.body, /^\uFEFF"date","provider","model"/);
	assert.doesNotMatch(daily.body, new RegExp(secret));

	const sessions = makeResponse();
	await routes.get(plugin.SESSIONS_EXPORT_PATH)(request(plugin.SESSIONS_EXPORT_PATH), sessions);
	assert.equal(sessions.status, 200);
	assert.match(sessions.body, /"'=1\+1 中文,""quoted"""/);
	assert.doesNotMatch(sessions.body, new RegExp(secret));

	const full = makeResponse();
	await routes.get(plugin.JSON_EXPORT_PATH)(request(plugin.JSON_EXPORT_PATH), full);
	assert.equal(full.status, 200);
	assert.equal(full.headers["content-type"], "application/json; charset=utf-8");
	const exported = JSON.parse(full.body);
	assert.equal(exported.schemaVersion, "1.0.0");
	assert.equal(exported.usage.sessions[0].title, "=1+1 中文,\"quoted\"");
	assert.ok(Array.isArray(exported.accounts));
	assert.doesNotMatch(full.body, new RegExp(secret));
	assert.doesNotMatch(full.body, /apiKey|credential|authorization/i);

	const foreign = makeResponse();
	await routes.get(plugin.JSON_EXPORT_PATH)({ ...request(plugin.JSON_EXPORT_PATH), socket: { remoteAddress: "198.51.100.4" } }, foreign);
	assert.equal(foreign.status, 403, "exports must preserve the loopback peer fence");
	const post = makeResponse();
	await routes.get(plugin.DAILY_EXPORT_PATH)({ ...request(plugin.DAILY_EXPORT_PATH), method: "POST" }, post);
	assert.equal(post.status, 405, "exports must remain GET-only");

	const failingRoutes = new Map();
	const failingAccounts = {
		validate: async () => {},
		providerViews: async () => { throw new Error(`Authorization: Bearer ${secret}`); }
	};
	await plugin.apply(makeContext({
		sessions: { list: () => [] },
		persistence: { listSnapshots: async () => [], list: async () => [] },
		routes: failingRoutes,
		settings: { get: () => void 0 }
	}), {}, { accounts: failingAccounts, disableBackgroundRefresh: true });
	const failed = makeResponse();
	await failingRoutes.get(plugin.JSON_EXPORT_PATH)(request(plugin.JSON_EXPORT_PATH), failed);
	assert.equal(failed.status, 500);
	assert.deepEqual(JSON.parse(failed.body), { ok: false, error: "internal", message: "export failed" });
	assert.doesNotMatch(failed.body, new RegExp(secret), "export error responses must not reflect upstream diagnostics");
}

async function testMalformedCacheRebuild(root) {
	const home = join(root, "malformed-cache");
	const storage = join(home, "storages");
	await mkdir(storage, { recursive: true });
	await writeFile(join(storage, "usage-stats-cache.json"), "{malformed v0.2.10 cache", "utf8");
	const plugin = await freshModule("malformed-cache", home);
	const context = makeContext({
		sessions: { list: () => [{ id: "recovered", events: [usageEvent(1, 17)] }] },
		persistence: { listSnapshots: async () => [], list: async () => [] },
		settings: { get: () => void 0 }
	});
	const usage = await plugin.collectUsage(context);
	assert.equal(usage.total.tokens, 17, "a malformed cache must rebuild from authoritative session events");
	const rebuilt = JSON.parse(await readFile(join(storage, "usage-stats-cache.json"), "utf8"));
	assert.equal(rebuilt.version, 5);
	assert.equal(rebuilt.sessions.recovered.consumed, 1);
}

async function testUsageBillingWire(root) {
	const plugin = await freshModule("usage-billing-wire", join(root, "usage-billing-wire"));
	const routes = new Map();
	const eventTime = Date.now();
	const event = pricedUsageEvent(0, eventTime, "deepseek-official", "deepseek-v4-pro", 1_000_000);
	const context = makeContext({
		sessions: { list: () => [{ id: "billed-session", title: "Billing test", events: [event] }] },
		persistence: { listSnapshots: async () => [], list: async () => [] },
		routes,
		settings: { get: () => void 0 }
	});
	await plugin.apply(context, { budgets: { currency: "USD", daily: 0.000001, monthly: 0.000001 } }, { disableBackgroundRefresh: true });
	const response = makeResponse();
	await routes.get(plugin.USAGE_PATH)({ method: "GET", url: plugin.USAGE_PATH, headers: { host: "localhost:3080" }, socket: { remoteAddress: "127.0.0.1" } }, response);
	assert.equal(response.status, 200);
	const payload = JSON.parse(response.body);
	assert.equal(payload.total.tokens, 1_000_000);
	assert.equal(payload.total.inputTokens, 1_000_000);
	assert.equal(payload.total.costComplete, true);
	assert.equal(payload.total.currency, "USD");
	assert.equal(payload.days[0].models[0].tokens, 1_000_000, "legacy day/model token totals must remain unchanged");
	assert.equal(payload.days[0].models[0].costComplete, true);
	assert.deepEqual(payload.sessions[0].providers, ["deepseek-official"]);
	assert.deepEqual(payload.sessions[0].models, ["deepseek-official/deepseek-v4-pro"]);
	assert.equal(payload.sessions[0].title, "Billing test");
	assert.equal(payload.sessions[0].estimatedCost, payload.total.estimatedCost);
	assert.equal(payload.budgets.daily.level, "critical");
	assert.equal(payload.budgets.monthly.level, "critical");
	assert.doesNotMatch(response.body, /apiKey|credential|SECRET/i);
}

async function testLegacyZaiSubscriptionId(root) {
	const plugin = await freshModule("legacy-zai", join(root, "legacy-zai"));
	const routes = new Map();
	const account = {
		id: "zai-coding-cn",
		displayName: "Z.ai CN",
		mode: "subscription",
		adapter: "zai-token-plan",
		status: "ok",
		windows: []
	};
	let accountRead = null;
	const accounts = {
		validate: async () => {},
		subscriptionAccounts: async () => [account],
		providerViews: async () => [{ id: "zai-coding-cn", configured: true }],
		get: async (providerId, options) => {
			accountRead = { providerId, options };
			return account;
		},
		refreshAll: async () => []
	};
	await plugin.apply(makeContext({ sessions: { list: () => [] }, persistence: { listSnapshots: async () => [], list: async () => [] }, routes }), {}, {
		disableBackgroundRefresh: true,
		accounts
	});
	const response = makeResponse();
	await routes.get(plugin.SUBSCRIPTIONS_PATH)({ method: "GET", url: plugin.SUBSCRIPTIONS_PATH, headers: { host: "localhost:3080" }, socket: { remoteAddress: "127.0.0.1" } }, response);
	const legacy = JSON.parse(response.body).subscriptions[0];
	assert.equal(legacy.id, "zai", "0.1.x clients require the canonical Z.ai subscription id");
	assert.equal(account.id, "zai-coding-cn", "legacy canonicalization must not mutate the account protocol");
	const detail = makeResponse();
	await routes.get(plugin.ACCOUNT_PATH)({ method: "GET", url: `${plugin.ACCOUNT_PATH}?provider=zai-coding-cn&activity=detail`, headers: { host: "localhost:3080" }, socket: { remoteAddress: "127.0.0.1" } }, detail);
	assert.equal(detail.status, 200);
	assert.deepEqual(accountRead, { providerId: "zai-coding-cn", options: { force: false, activity: "detail" } }, "detail activity must stay a small server-owned AccountService hint");
}

async function testBackgroundRefresh(root) {
	const plugin = await freshModule("background", join(root, "background"));
	let refreshes = 0;
	let delay = null;
	let tick = null;
	let cleared = false;
	let unsubscribed = false;
	let policyChanged = null;
	let clock = Date.UTC(2026, 7, 24, 0, 0, 0);
	let accountDeadline = clock + 60000;
	const activeSets = [];
	const session = { id: "active-session", events: [routeEvent(0, "route-a", "shared-model")] };
	const ctx = makeContext({
		sessions: { list: () => [session], get: (id) => id === session.id ? session : void 0 },
		persistence: { listSnapshots: async () => [], list: async () => [] }
	});
	const cleanup = plugin.startBackgroundRefresh(ctx, {
		setActiveProviders: (ids) => { activeSets.push([...ids]); },
		refreshDue: async () => { refreshes += 1; },
		nextRefreshAt: async () => accountDeadline,
		subscribePolicyChanges: (listener) => {
			policyChanged = listener;
			return () => { unsubscribed = true; };
		}
	}, {
		config: { monitors: {} },
		now: () => clock,
		setTimeout: (callback, ms) => {
			tick = callback;
			delay = ms;
			return { unref: () => {} };
		},
		clearTimeout: () => { cleared = true; }
	});
	await cleanup.ready;
	assert.equal(delay, 60000, "one central timer must target the earliest account/usage deadline");
	assert.equal(refreshes, 1, "background refresh must run immediately at startup");
	assert.deepEqual(activeSets.at(-1), ["route-a"], "active providers must come from existing session route identity");
	assert.equal(typeof tick, "function");
	accountDeadline = clock + 15000;
	policyChanged();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(delay, 15000, "an activity priority change must rearm the same central timer to the earlier deadline");
	assert.equal(cleared, true, "rearming must clear the previously scheduled central timer");
	clock += 15000;
	await cleanup.refreshNow();
	assert.equal(refreshes, 2, "manual scheduler wake must reuse the central refresh path");
	await cleanup();
	assert.equal(cleared, true);
	assert.equal(unsubscribed, true, "scheduler cleanup must unsubscribe from AccountService policy changes");
}

async function testDisabledAccountRefresh(root) {
	const home = join(root, "refresh-disabled");
	const plugin = await freshModule("refresh-disabled", home);
	const routes = new Map();
	let adaptiveCalls = 0;
	const accounts = {
		validate: async () => {},
		nextRefreshAt: async () => { adaptiveCalls += 1; throw new Error("disabled account scheduler must not request a deadline"); },
		refreshDue: async () => { adaptiveCalls += 1; throw new Error("disabled account scheduler must not refresh accounts"); },
		setActiveProviders: () => { adaptiveCalls += 1; },
		subscribePolicyChanges: () => { adaptiveCalls += 1; return () => {}; },
		providerViews: async () => [],
		get: async () => null,
		subscriptionAccounts: async () => []
	};
	const cleanups = [];
	const ctx = makeContext({
		sessions: { list: () => [] },
		persistence: { listSnapshots: async () => [], list: async () => [] },
		routes,
		settings: { get: () => void 0 }
	});
	ctx.effect = (register) => {
		const cleanup = register();
		if (typeof cleanup === "function") cleanups.push(cleanup);
		return cleanup;
	};
	await plugin.apply(ctx, { refresh: { enabled: false } }, { accounts });
	const schedulerCleanup = cleanups.find((cleanup) => cleanup.ready instanceof Promise);
	assert.notEqual(schedulerCleanup, void 0, "usage aggregation lifecycle must remain registered when account refresh is disabled");
	await schedulerCleanup.ready;
	assert.equal(adaptiveCalls, 0, "disabled mode must not start the adaptive account scheduler");
	const cache = JSON.parse(await readFile(join(home, "storages", "usage-stats-cache.json"), "utf8"));
	assert.equal(cache.version, 5, "the surviving usage lifecycle must still fold and persist usage");
	await schedulerCleanup();
}

async function testPersistedToLive(root) {
	const plugin = await freshModule("transition", join(root, "transition"));
	const id = "transition-session";
	const persisted = usageEvent(100, 11);
	let live = false;
	const sessions = { list: () => live ? [{ id, events: [usageEvent(1, 7)] }] : [] };
	const persistence = {
		listSnapshots: async () => live ? [] : [{ header: { id }, revision: "r1" }],
		list: async () => [],
		readFrom: async () => ({ events: [persisted] })
	};
	const ctx = makeContext({ sessions, persistence });
	assert.equal((await plugin.collectUsage(ctx)).total.tokens, 11);
	live = true;
	assert.equal((await plugin.collectUsage(ctx)).total.tokens, 7, "persisted-to-live must refold the full live log");
}

async function testRevisionRewrite(root) {
	const plugin = await freshModule("rewrite", join(root, "rewrite"));
	const id = "rewritten-session";
	let revision = "r1";
	let reads = 0;
	const persistence = {
		listSnapshots: async () => [{ header: { id }, revision }],
		list: async () => [],
		readFrom: async (_id, fromSeq) => {
			reads += 1;
			if (revision === "r1") return { events: [usageEvent(100, 11)] };
			return { events: fromSeq === 0 ? [usageEvent(1, 5)] : [] };
		}
	};
	const ctx = makeContext({ sessions: { list: () => [] }, persistence });
	assert.equal((await plugin.collectUsage(ctx)).total.tokens, 11);
	await plugin.collectUsage(ctx);
	assert.equal(reads, 1, "an unchanged opaque revision must skip storage reads");
	revision = "r2";
	assert.equal((await plugin.collectUsage(ctx)).total.tokens, 5, "a rewritten log must replace cached usage");
	assert.equal(reads, 3, "rewrite detection must retry from seq 0");
}

async function testFallbackIncremental(root) {
	const plugin = await freshModule("fallback-incremental", join(root, "fallback-incremental"));
	const id = "fallback-session";
	// No listSnapshots (the fallback path) means every cycle re-reads, but an
	// unchanged log must read only the delta tail — not refold from seq 0 —
	// while a truncated log must still refold from scratch.
	const log = [usageEvent(1, 5), usageEvent(2, 7), usageEvent(3, 11)];
	const reads = [];
	const persistence = {
		list: async () => [{ id }],
		readFrom: async (_id, fromSeq) => {
			reads.push(fromSeq);
			return { events: log.filter((event) => event.seq >= fromSeq) };
		}
	};
	const ctx = makeContext({ sessions: { list: () => [] }, persistence });
	assert.equal((await plugin.collectUsage(ctx)).total.tokens, 23);
	assert.deepEqual(reads, [0], "the initial fold reads from seq 0");
	reads.length = 0;
	assert.equal((await plugin.collectUsage(ctx)).total.tokens, 23, "an unchanged fallback log must keep the folded total");
	assert.deepEqual(reads, [3], "an unchanged fallback log must not refold from seq 0");
	log.push(usageEvent(4, 13));
	reads.length = 0;
	assert.equal((await plugin.collectUsage(ctx)).total.tokens, 36, "new events must fold incrementally in the fallback path");
	assert.deepEqual(reads, [3], "only the delta tail is read");
	log.length = 0;
	log.push(usageEvent(1, 5));
	reads.length = 0;
	assert.equal((await plugin.collectUsage(ctx)).total.tokens, 5, "a truncated fallback log must refold");
	assert.deepEqual(reads, [4, 0], "truncation detection retries from seq 0");
}

async function testLiveLogShrink(root) {
	const plugin = await freshModule("shrink", join(root, "shrink"));
	const id = "shrink-session";
	const persistence = { listSnapshots: async () => [], list: async () => [] };
	// Pre-restart: the full live log is folded positionally.
	let events = [usageEvent(1, 5), usageEvent(2, 7), usageEvent(3, 11)];
	const sessions = { list: () => [{ id, events }] };
	const ctx = makeContext({ sessions, persistence });
	assert.equal((await plugin.collectUsage(ctx)).total.tokens, 23);
	// DSH restart restores the session as a SHORTER compressed summary while
	// the folded cursor still points past the summary's end (#23): the session
	// must refold from the summary instead of freezing its stats forever.
	events = [usageEvent(1, 5), usageEvent(3, 11)];
	assert.equal((await plugin.collectUsage(ctx)).total.tokens, 16, "a shrunk live log must refold instead of freezing");
	events = [...events, usageEvent(4, 13)];
	assert.equal((await plugin.collectUsage(ctx)).total.tokens, 29, "new events after a restored summary must keep counting");
}

async function testZeroUsageRowsFiltered(root) {
	const plugin = await freshModule("zero-rows", join(root, "zero-rows"));
	// Warmup requests report an all-zero usage sample; the model bucket they
	// create must not render as an empty "0 tokens" row (#23).
	const zero = {
		seq: 1,
		time: Date.UTC(2026, 7, 13),
		type: "assistant/message",
		data: {
			turn: "turn-1",
			step: 0,
			usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
			message: { source: { model: "modlens-opencode/deepseek-v4-flash-free" } }
		}
	};
	const sessions = { list: () => [{ id: "zero-session", events: [zero, usageEvent(2, 9)] }] };
	const ctx = makeContext({ sessions, persistence: { listSnapshots: async () => [], list: async () => [] } });
	const usage = await plugin.collectUsage(ctx);
	assert.equal(usage.total.tokens, 9);
	const day = usage.days.find((entry) => entry.date === "2026-08-13");
	assert.equal(day.models.length, 1, "all-zero model buckets must not render as rows");
	assert.equal(day.models[0].model, "unknown/deepseek-chat");
}

const root = await mkdtemp(join(tmpdir(), "dsh-usage-stats-"));
try {
	await testRouteFence(root);
	await testOrcaRouterIntegrationRoute(root);
	await testSessionContext(root);
	await testV4CacheUpgradeRefoldsBilling(root);
	await testPricingFingerprintInvalidatesDerivedCosts(root);
	await testRuntimeProviderPricingIdentityChange(root);
	await testConfigValidation(root);
	await testUsageBillingWire(root);
	await testExportRoutes(root);
	await testMalformedCacheRebuild(root);
	await testLegacyZaiSubscriptionId(root);
	await testBackgroundRefresh(root);
	await testDisabledAccountRefresh(root);
	await testPersistedToLive(root);
	await testRevisionRewrite(root);
	await testFallbackIncremental(root);
	await testLiveLogShrink(root);
	await testZeroUsageRowsFiltered(root);
	console.log("SERVER REGRESSION TESTS PASSED");
} finally {
	delete process.env.DSH_HOME;
	await rm(root, { recursive: true, force: true });
}
