import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

async function freshModule(label, home) {
	process.env.DSH_HOME = home;
	return import(new URL(`../lib/index.js?test=${label}-${Date.now()}-${Math.random()}`, import.meta.url));
}

function makeResponse() {
	return {
		status: null,
		body: "",
		writeHead(status) { this.status = status; },
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
	await plugin.apply(makeContext({ sessions, persistence, routes, settings }), {}, { disableBackgroundRefresh: true });
	const handler = routes.get(plugin.SESSION_CONTEXT_PATH);

	const first = makeResponse();
	await handler({ method: "GET", url: `${plugin.SESSION_CONTEXT_PATH}?session=live-session`, headers: { host: "localhost:3080" }, socket: { remoteAddress: "127.0.0.1" } }, first);
	assert.equal(first.status, 200);
	assert.deepEqual(JSON.parse(first.body).context, {
		sessionId: "live-session",
		providerId: "route-a",
		providerFamily: "deepseek",
		model: "shared-model",
		accountId: "route-a",
		updatedAt: Date.UTC(2026, 7, 23, 12, 0, 0)
	});
	assert.doesNotMatch(first.body, /SECRET|apiKey|baseURL/i, "session context must not expose connection or credential fields");

	const selectorSwitched = makeResponse();
	await handler({ method: "GET", url: `${plugin.SESSION_CONTEXT_PATH}?session=live-session&provider=route-b&model=shared-model`, headers: { host: "localhost:3080" }, socket: { remoteAddress: "127.0.0.1" } }, selectorSwitched);
	assert.deepEqual(JSON.parse(selectorSwitched.body).context, {
		sessionId: "live-session",
		providerId: "route-b",
		providerFamily: "ollama",
		model: "shared-model",
		accountId: "route-b",
		updatedAt: null
	}, "an accepted selector route must override the last request/header immediately");
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

async function testV3CacheUpgradeRefoldsCurrentRoute(root) {
	const home = join(root, "v3-cache-upgrade");
	const storage = join(home, "storages");
	await mkdir(storage, { recursive: true });
	const sessionId = "cached-live-session";
	await writeFile(join(storage, "usage-stats-cache.json"), JSON.stringify({
		version: 3,
		sessions: {
			[sessionId]: {
				kind: "live",
				consumed: 1,
				days: {},
				lastSample: null,
				currentModel: "route-a/deepseek-chat"
			}
		}
	}), "utf8");
	const plugin = await freshModule("v3-cache-upgrade", home);
	const session = { id: sessionId, events: [routeEvent(0, "route-a", "deepseek-chat")] };
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

	assert.deepEqual(await plugin.collectSessionContext(context, sessionId), {
		sessionId,
		providerId: "route-a",
		providerFamily: "deepseek",
		model: "deepseek-chat",
		accountId: "route-a",
		updatedAt: Date.UTC(2026, 7, 23, 12, 0, 0)
	}, "a v3 cache without currentRoute must be invalidated and refolded even when no event is new");
	const migrated = JSON.parse(await readFile(join(storage, "usage-stats-cache.json"), "utf8"));
	assert.equal(migrated.version, 4, "the rewritten cache must use schema v4");
	assert.equal(migrated.sessions[sessionId].currentRoute.providerId, "route-a");
}

async function testConfigValidation(root) {
	const plugin = await freshModule("config", join(root, "config"));
	assert.deepEqual(plugin.Config["~standard"].validate({ monitors: {} }).issues, void 0);
	assert.match(plugin.Config["~standard"].validate({ monitors: { relay: { adapter: "missing" } } }).issues[0].message, /adapter is unsupported/);
	const routes = new Map();
	const context = makeContext({
		sessions: { list: () => [] },
		persistence: { listSnapshots: async () => [], list: async () => [] },
		routes,
		settings: { get: () => void 0 }
	});
	await assert.rejects(
		() => plugin.apply(context, { monitors: { missing: { adapter: "general" } } }, { disableBackgroundRefresh: true }),
		/unknown provider: missing/
	);
	assert.equal(routes.size, 0, "invalid provider config must fail before routes are registered");
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
	const accounts = {
		validate: async () => {},
		subscriptionAccounts: async () => [account],
		providerViews: async () => [],
		get: async () => null,
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
}

async function testBackgroundRefresh(root) {
	const plugin = await freshModule("background", join(root, "background"));
	let refreshes = 0;
	let interval = null;
	let tick = null;
	let cleared = false;
	const ctx = makeContext({
		sessions: { list: () => [] },
		persistence: { listSnapshots: async () => [], list: async () => [] }
	});
	const cleanup = plugin.startBackgroundRefresh(ctx, {
		refreshAll: async () => { refreshes += 1; }
	}, {
		setInterval: (callback, ms) => {
			tick = callback;
			interval = ms;
			return { unref: () => {} };
		},
		clearInterval: () => { cleared = true; }
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(interval, 300000);
	assert.equal(refreshes, 1, "background refresh must run immediately at startup");
	assert.equal(typeof tick, "function");
	await cleanup.refreshNow();
	assert.equal(refreshes, 2, "the five-minute timer must refresh accounts again");
	await cleanup();
	assert.equal(cleared, true);
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
	await testSessionContext(root);
	await testV3CacheUpgradeRefoldsCurrentRoute(root);
	await testConfigValidation(root);
	await testLegacyZaiSubscriptionId(root);
	await testBackgroundRefresh(root);
	await testPersistedToLive(root);
	await testRevisionRewrite(root);
	await testLiveLogShrink(root);
	await testZeroUsageRowsFiltered(root);
	console.log("SERVER REGRESSION TESTS PASSED");
} finally {
	delete process.env.DSH_HOME;
	await rm(root, { recursive: true, force: true });
}
