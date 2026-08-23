// Smoke-test the hand-written client bundle outside the browser:
// 1. feed it to a fake __ModuleLoader__ (captures the factory)
// 2. run the factory with a fake require (real react, stubbed primitives)
// 3. render <UsageStatsPanel wide t> with react-dom/server
// 4. run apply(ctx) against a stub client context
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Clean clones resolve declared devDependencies locally. An explicit override
// remains useful for checking against the exact modules bundled with dsh.
const require = process.env.SMOKE_NODE_MODULES === void 0
	? createRequire(import.meta.url)
	: createRequire(join(process.env.SMOKE_NODE_MODULES, "_anchor.js"));
const react = require("react");
const jsxRuntime = require("react/jsx-runtime");
const { renderToStaticMarkup } = require("react-dom/server");
const TestRenderer = require("react-test-renderer");
const { act } = TestRenderer;

// Fake primitives: every named export is a no-op component (returns its props as children is not needed).
const Stub = () => null;
const primitives = new Proxy({}, { get: () => Stub });

let captured = null;
globalThis.window = { __ModuleLoader__: { load: (entry) => { captured = entry; } } };
globalThis.document = { querySelector: () => null, createElement: () => ({ dataset: {}, appendChild: () => {} }), head: { appendChild: () => {} } };

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js"), "utf8");
if (!source.includes("/api/usage-stats/account")) throw new Error("client must use the unified account endpoint");
if (source.includes('fetchJson("/api/usage-stats/subscriptions")')) throw new Error("client must not bulk-fetch every subscription provider");
if (!source.includes('host.style.flexDirection = "column"')) throw new Error("client must stack the host footer-actions container vertically (#21)");
if (!source.includes('document.addEventListener("pointerdown"')) throw new Error("open panel must listen for outside pointerdown");
if (!source.includes('event.key === "Escape"')) throw new Error("open panel must dismiss on Escape");
if (!source.includes("ref: panelRef")) throw new Error("portaled panel must expose a ref for outside-click detection");
// Badge layout regression: the collapsed badge must keep the 「用量/余额」label,
// render the account value as a separate middle element, and keep today's token
// count on the right — the label must never be replaced by the amount.
if (!source.includes('translate("panel.badge")')) throw new Error("badge must keep the label text");
if (!source.includes("badgeAmountText !== null &&")) throw new Error("badge amount must be a separate middle element");
if (!source.includes("S.badgeAmount")) throw new Error("badge amount element is missing its class");
if (!source.includes("badgeCount !== null && react_jsx_runtime.jsx(\"span\", { className: S.badgeCount")) throw new Error("badge must keep the today token count on the right");
if (!source.includes('.slots.inject("conversation.input.right"')) throw new Error("current-session pill must use the formal composer control slot");
const pillSource = source.slice(source.indexOf("//#region CurrentSessionPill"), source.indexOf("//#endregion", source.indexOf("//#region CurrentSessionPill")));
if (pillSource.includes("setInterval") || pillSource.includes("setTimeout")) throw new Error("current-session pill must not add an independent polling loop");
if (pillSource.includes("MutationObserver") || pillSource.includes("addEventListener")) throw new Error("current-session pill must use slot session snapshots instead of DOM observers/listeners");
new Function(source)(); // executes the window.__ModuleLoader__.load call

if (captured === null) throw new Error("loader did not capture the bundle");
const packageName = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).name;
if (captured.id !== packageName) throw new Error(`unexpected id ${captured.id}; expected package name ${packageName}`);
if (!source.includes(`tag.dataset.plugin = "${packageName}"`)) throw new Error(`style ownership id must match package name ${packageName}`);

const exports_ = captured.factory((spec) => {
	if (spec === "react") return react;
	if (spec === "react/jsx-runtime") return jsxRuntime;
	// react-dom/server cannot render portals; the panel portals to document.body
	// only for theme-token scoping, so the smoke harness inlines it instead.
	if (spec === "react-dom") return { createPortal: (node) => node };
	if (spec === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
	throw new Error(`unexpected require: ${spec}`);
});

if (typeof exports_.apply !== "function") throw new Error("missing apply export");

const { shouldDismissPanel, safeDiagnosticReason } = exports_;
const panelNode = { contains: (target) => target === "panel-child" };
const layerNode = { contains: (target) => target === "badge-child" };
if (shouldDismissPanel([panelNode], "panel-child", layerNode, panelNode)) throw new Error("panel click must stay open");
if (shouldDismissPanel([layerNode], "badge-child", layerNode, panelNode)) throw new Error("badge click must stay inside");
if (!shouldDismissPanel([], "page-content", layerNode, panelNode)) throw new Error("outside click must dismiss");
if (!shouldDismissPanel([], "page-content", null, null)) throw new Error("missing refs must fail safe as outside");
if (safeDiagnosticReason("all-addresses-unreachable") !== "all-addresses-unreachable") throw new Error("safe reason should pass");
if (safeDiagnosticReason("Authorization: Bearer secret") !== null) throw new Error("secret-like reason must be rejected");
if (safeDiagnosticReason("x".repeat(161)) !== null) throw new Error("oversized reason must be rejected");
console.log("panel dismissal and diagnostic guards ok");

// Render the panel (closed state) to static markup.
const { UsageStatsPanel } = exports_;
const markup = renderToStaticMarkup(react.createElement(UsageStatsPanel, { wide: true, t: (key) => key }));
if (!markup.includes("用量/余额") && !markup.includes("panel.badge")) throw new Error("badge label missing from markup");
console.log("render ok, markup length:", markup.length);

// Apply against a stub client context.
const registrations = [];
const registeredEntries = [];
const modelSubscribers = new Set();
let modelSnapshot = { current: { provider: "deepseek-official", model: "deepseek-chat" } };
const modelDirectory = {
	subscribe: (fn) => { modelSubscribers.add(fn); return () => modelSubscribers.delete(fn); },
	getSnapshot: () => modelSnapshot
};
const ctx = {
	effect: () => {},
	locale: { register: (ns, dict) => { if (ns !== "usageStats") throw new Error(`unexpected ns ${ns}`); if (!dict.zh || !dict.en) throw new Error("missing dictionaries"); } },
	inject: (_services, fn) => fn({
		slots: ctx.slots,
		modelDirectories: { directoryFor: () => ({ store: modelDirectory }) }
	}),
	slots: {
		inject: (slot, fn) => { registrations.push([slot, fn]); return () => {}; },
		register: (options, component) => { registeredEntries.push({ options, component }); return () => {}; }
	}
};
exports_.apply(ctx);
if (registrations.length !== 2) throw new Error(`expected sidebar + composer slot injections, got ${registrations.length}`);
const registrationBySlot = new Map(registrations);
if (!registrationBySlot.has("sidebar.footer.action")) throw new Error("sidebar footer slot registration missing");
if (!registrationBySlot.has("conversation.input.right")) throw new Error("current-session pill slot registration missing");
for (const registerFn of registrationBySlot.values()) {
	const disposer = registerFn();
	if (typeof disposer !== "function") throw new Error("slot registration must return a disposer");
}
const pillEntry = registeredEntries.find((entry) => entry.options.name === "conversation.input.right");
if (pillEntry?.options.id !== "usage-stats-current-session-pill") throw new Error("pill list entry needs a stable unique id");
if (typeof pillEntry.component !== "function") throw new Error("pill slot must register a component");
if (pillEntry.options.inject("session-a").modelDirectory !== modelDirectory) throw new Error("pill must subscribe to the host model-selection store");
// Missing mount point: the host may never invoke a slot injection callback.
// apply() must still complete without attempting any DOM fallback or throwing.
exports_.apply({
	effect: () => {},
	locale: ctx.locale,
	inject: () => () => {},
	slots: { inject: () => () => {}, register: () => { throw new Error("missing host slot must not register"); } }
});
console.log("apply ok, formal slots:", [...registrationBySlot.keys()].join(", "));

// Render the month heatmap with synthetic per-day data (calendar grid + colors).
const { MonthHeatmap, DayDetail, buildMonthHeatmap } = exports_;
const dayMap = new Map();
const now = new Date();
for (let i = 0; i < 40; i += 1) {
	const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
	const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	dayMap.set(key, { tokens: 1000 + i * 137, cacheHitRate: i % 3 === 0 ? null : 90.5 });
}
const heat = buildMonthHeatmap(dayMap, now.getFullYear(), now.getMonth());
if (heat.weeks.length < 4 || heat.weeks.length > 6) throw new Error(`unexpected week count ${heat.weeks.length}`);
for (const week of heat.weeks) if (week.length !== 7) throw new Error("week must have 7 slots");
const heatMarkup = renderToStaticMarkup(react.createElement(MonthHeatmap, {
	heat,
	translate: (key) => key,
	selectedKey: null,
	onSelect: () => {}
}));
if (heatMarkup.length < 500) throw new Error("heatmap markup too small");
if (!heatMarkup.includes("tokens")) throw new Error("heatmap cells missing tooltips");
console.log("month heatmap render ok, markup length:", heatMarkup.length, "| weeks:", heat.weeks.length);

// Sqrt rgba scale: monotonic in tokens — more usage → deeper blue (higher alpha).
const { cellColor } = exports_;
const levelOf = (tokens, max) => {
	const style = cellColor(tokens, max);
	if (style.background === "var(--usg-cellEmpty)") return 0;
	return Number(style.background.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/)[4]);
};
const levelMap = new Map();
const lkeys = [];
for (let i = 1; i <= 4; i += 1) {
	const d = new Date(now.getFullYear(), now.getMonth(), i);
	const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	levelMap.set(key, { tokens: [1000, 100000, 10000000, 40000000][i - 1], cacheHitRate: 90 });
	lkeys.push(key);
}
const levelHeat = buildMonthHeatmap(levelMap, now.getFullYear(), now.getMonth());
const levels = lkeys.map((key) => levelOf(levelHeat.weeks.flat().find((c) => c !== null && c.key === key).tokens, levelHeat.max));
if (levels[3] !== 1) throw new Error(`max day must be alpha 1 (deep blue), got ${levels[3]}`);
for (let i = 1; i < 4; i += 1) if (levels[i] < levels[i - 1]) throw new Error(`levels not monotonic: ${JSON.stringify(levels)}`);
if (levelOf(0, levelHeat.max) !== 0) throw new Error("zero tokens must be level 0");
if (!cellColor(1000, levelHeat.max).background.startsWith("rgba(")) throw new Error("background must be plain rgba (no color-mix)");
console.log("rgba sqrt scale monotonic ok:", JSON.stringify(levels.map((a) => a.toFixed(3))));

// Regression: the panel parses `YYYY-MM` (1-based) from viewMonth; emulate it
// and check the grid lands on the right month (August 2026 starts on Saturday).
const [panelYear, panelMonth] = "2026-08".split("-").map(Number);
const panelHeat = buildMonthHeatmap(levelMap, panelYear, panelMonth - 1);
const firstWeek = panelHeat.weeks[0];
if (firstWeek[5] === null || firstWeek[5].day !== 1) throw new Error(`August 2026 should start with day 1 at weekday index 5, got ${JSON.stringify(firstWeek)}`);
if (firstWeek[0] !== null || firstWeek[4] !== null) throw new Error("August 2026 must lead with 5 empty slots");
console.log("month off-by-one regression ok (Aug 2026 grid correct)");

// Render the day-detail view with per-model breakdown.
const dayDetail = renderToStaticMarkup(react.createElement(DayDetail, {
	day: {
		date: "2026-08-13",
		tokens: 34333358,
		inputTokens: 199382,
		outputTokens: 116824,
		cacheReadTokens: 34017152,
		cacheWriteTokens: 0,
		cacheHitRate: 99.4,
		models: [
			{ model: "deepseek-official/deepseek-v4-flash", tokens: 30000000, inputTokens: 100000, outputTokens: 50000, cacheReadTokens: 29000000, cacheWriteTokens: 0, cacheHitRate: 99.6 },
			{ model: "ark/deepseek-v4-flash", tokens: 4333358, inputTokens: 99382, outputTokens: 66824, cacheReadTokens: 5017152, cacheWriteTokens: 0, cacheHitRate: 98.1 }
		]
	},
	translate: (key) => key,
	onBack: () => {}
}));
if (!dayDetail.includes("deepseek-v4-flash")) throw new Error("day detail missing model rows");
if (!dayDetail.includes("deepseek-official · deepseek-v4-flash")) throw new Error("day detail must prefix the provider");
if (!dayDetail.includes("ark · deepseek-v4-flash")) throw new Error("same model from another provider must stay distinct");
if (dayDetail.length < 500) throw new Error("day detail markup too small");
console.log("day detail render ok (provider-prefixed models), markup length:", dayDetail.length);

// Balance and subscription providers share one account-card frame. Only the
// selected provider is rendered; the inner payload varies by account mode.
const { ProviderAccountCard, buildProviderChoices } = exports_;
const translateAccount = (key, params) => {
	if (params?.value !== void 0) return `${key}:${params.value}`;
	if (params?.refs !== void 0) return `${key}:${params.refs}`;
	if (params?.ref !== void 0) return `${key}:${params.ref}`;
	return key;
};
const deepseekAccount = {
	id: "deepseek-official",
	displayName: "DeepSeek",
	mode: "balance",
	status: "ok",
	balance: { remaining: 36.44, currency: "CNY", unlimited: false, breakdown: { toppedUp: 20, granted: 16.44 } }
};
const deepseekMarkup = renderToStaticMarkup(react.createElement(ProviderAccountCard, {
	provider: { id: "deepseek-official", displayName: "DeepSeek", accountMode: "balance" },
	account: deepseekAccount,
	accountLoading: false,
	accountError: null,
	translate: translateAccount,
	onRetry: () => {}
}));
const goSubscription = {
	id: "opencode-go",
	displayName: "OpenCode Go",
	status: "ok",
	plan: "Go",
	windows: [
		{ kind: "session", usedPercent: 12, remainingPercent: 88, resetsAt: "2026-08-14T01:00:00Z" },
		{ kind: "weekly", usedPercent: 34, remainingPercent: 66 },
		{ kind: "monthly", usedPercent: 56, remainingPercent: 44 }
	]
};
const goMarkup = renderToStaticMarkup(react.createElement(ProviderAccountCard, {
	provider: { id: "opencode-go", displayName: "OpenCode Go", accountMode: "subscription", subscriptionId: "opencode-go" },
	account: { ...goSubscription, mode: "subscription" },
	accountLoading: false,
	accountError: null,
	translate: translateAccount,
	onRetry: () => {}
}));
if (!deepseekMarkup.includes("usg_accountCard") || !goMarkup.includes("usg_accountCard")) throw new Error("both account modes must use the shared card frame");
if (!deepseekMarkup.includes("data-account-mode=\"balance\"") || !deepseekMarkup.includes("DeepSeek") || deepseekMarkup.includes("progressbar")) throw new Error("DeepSeek must render only monetary balance data");
if (!goMarkup.includes("data-account-mode=\"subscription\"") || !goMarkup.includes("OpenCode Go")) throw new Error("OpenCode Go must render the subscription account mode");
if ((goMarkup.match(/role="progressbar"/g) ?? []).length !== 3 || !goMarkup.includes("width:12%")) throw new Error("OpenCode Go must render three quota meters");
const invalidMarkup = renderToStaticMarkup(react.createElement(ProviderAccountCard, {
	provider: { id: "minimax", displayName: "MiniMax", accountMode: "subscription" },
	account: { id: "minimax", displayName: "MiniMax", mode: "subscription", status: "invalid-response", windows: [], reason: "all-addresses-unreachable" },
	accountLoading: false,
	accountError: null,
	translate: translateAccount,
	onRetry: () => {}
}));
if (!invalidMarkup.includes("account.status.invalidResponse") || !invalidMarkup.includes("account.invalidResponse")) throw new Error("invalid account responses need a distinct status and explanation");
if (!invalidMarkup.includes("account.reason.allAddressesUnreachable")) throw new Error("safe diagnostic reason must render in account card");

// Local security-policy rejections must render a distinct blocked state, not
// the "provider has no balance interface" unsupported message.
const blockedMarkup = renderToStaticMarkup(react.createElement(ProviderAccountCard, {
	provider: { id: "relay-a", displayName: "Relay A", accountMode: "balance" },
	account: { id: "relay-a", displayName: "Relay A", mode: "balance", status: "blocked", balance: null },
	accountLoading: false,
	accountError: null,
	translate: translateAccount,
	onRetry: () => {}
}));
const blockedSubMarkup = renderToStaticMarkup(react.createElement(ProviderAccountCard, {
	provider: { id: "opencode-go", displayName: "OpenCode Go", accountMode: "subscription" },
	account: { id: "opencode-go", displayName: "OpenCode Go", mode: "subscription", status: "blocked", windows: [] },
	accountLoading: false,
	accountError: null,
	translate: translateAccount,
	onRetry: () => {}
}));
if (!blockedMarkup.includes("account.status.blocked") || !blockedMarkup.includes("account.blocked")) throw new Error("blocked balance queries need a distinct status and neutral explanation");
if (!blockedSubMarkup.includes("account.status.blocked") || !blockedSubMarkup.includes("account.blocked")) throw new Error("blocked subscription queries need a distinct status and neutral explanation");
if (blockedMarkup.includes("balance.unsupported")) throw new Error("blocked must not reuse the unsupported explanation");
if (blockedMarkup.includes("balance.blocked") || blockedSubMarkup.includes("balance.blocked")) throw new Error("blocked must not reuse the balance-specific explanation");
if (!source.includes('"account.status.blocked"') || !source.includes('"account.blocked"')) throw new Error("blocked status keys missing from client locales");
if (source.includes('"balance.blocked"')) throw new Error("balance-specific blocked copy must not be reintroduced");

const healthMarkup = renderToStaticMarkup(react.createElement(ProviderAccountCard, {
	provider: { id: "deepseek-official", displayName: "DeepSeek", accountMode: "balance", adapter: "deepseek-balance" },
	account: {
		...deepseekAccount,
		status: "rate-limited",
		stale: true,
		lastAttemptAt: Date.parse("2026-08-24T01:00:00Z"),
		lastSuccessAt: Date.parse("2026-08-24T00:00:00Z"),
		ageMs: 3600000,
		provenance: "official",
		reason: "rate-limited",
		secret: "SECRET_API_KEY"
	},
	accountLoading: false,
	accountError: null,
	translate: translateAccount,
	onRetry: () => {}
}));
for (const expected of ["account.status.stale", "account.health.lastAttempt", "account.health.lastSuccess", "account.health.age", "account.health.provenance", "account.provenance.official", "account.reason.rateLimited"]) {
	if (!healthMarkup.includes(expected)) throw new Error(`account health detail is missing ${expected}`);
}
if (!healthMarkup.includes('data-account-stale="true"') || healthMarkup.includes("SECRET_API_KEY")) throw new Error("stale health metadata must be explicit and secret-free");

const choices = buildProviderChoices([
	{ id: "deepseek-official", displayName: "DeepSeek", adapter: "deepseek-balance", accountMode: "balance", configured: true },
	{ id: "zai-coding-cn", displayName: "Z.ai CN", adapter: "zai-token-plan", accountMode: "subscription", configured: true },
	{ id: "opencode-go", displayName: "OpenCode Go", adapter: "opencode-go", accountMode: "subscription", configured: true }
]);
if (choices.length !== 3) throw new Error(`provider metadata must remain one row per provider, got ${choices.length}`);
if (choices.find((provider) => provider.id === "zai-coding-cn")?.accountMode !== "subscription") throw new Error("Z.ai must prefer its subscription presentation");
const selectedMarkup = goMarkup;
if (selectedMarkup.includes("DeepSeek") || selectedMarkup.includes("Z.ai")) throw new Error("the account area must render only the selected provider");
console.log("unified single-provider account card ok, balance:", deepseekMarkup.length, "subscription:", goMarkup.length);

// Race regression (P1): usage and account must each keep their OWN staleness
// counter, so an account request issued right after a usage request must NOT
// invalidate the in-flight usage response.
const { createLoader, fmtCurrency } = exports_;
const usageLoader = createLoader();
const accountLoader = createLoader();
const usageId = usageLoader.start();
const accountId = accountLoader.start();
if (!usageLoader.isCurrent(usageId)) throw new Error("race: account start invalidated the usage request");
if (!accountLoader.isCurrent(accountId)) throw new Error("account request must stay current");
usageLoader.start(); // a newer usage refresh supersedes the old one
if (usageLoader.isCurrent(usageId)) throw new Error("a newer usage start must supersede the previous usage request");
if (!accountLoader.isCurrent(accountId)) throw new Error("account must not be affected by usage refreshes");
console.log("loader race regression ok (independent usage/account counters)");

// Currency formatting must respect the reported currency, not hardcode ¥.
const cny = fmtCurrency("36.44", "CNY");
if (!cny.includes("36.44")) throw new Error(`unexpected CNY format: ${cny}`);
if (fmtCurrency(void 0, "CNY") !== "—") throw new Error("missing amount must render em dash");
if (fmtCurrency("9.9", "USD").includes("¥")) throw new Error("USD must not render as ¥");
console.log("currency formatting ok:", cny);

// Collapsed-badge account value + warning policy (v0.2.0 unified account model).
const { badgeAccountValue, badgeWarnOf } = exports_;
// balance just above the threshold => normal, no warning
const balanceOk = badgeAccountValue({ mode: "balance", status: "ok", balance: { remaining: 6, currency: "USD" } });
if (balanceOk === null || balanceOk.kind !== "balance" || balanceOk.value !== 6) throw new Error(`balance 6 must render amount, got ${JSON.stringify(balanceOk)}`);
if (!balanceOk.display.includes("6")) throw new Error("balance display must include the amount");
if (badgeWarnOf({ mode: "balance", status: "ok", balance: { remaining: 6, currency: "USD" } }) !== false) throw new Error("balance 6 must NOT warn");
// balance at/below threshold => warning (red)
if (badgeWarnOf({ mode: "balance", status: "ok", balance: { remaining: 5, currency: "USD" } }) !== true) throw new Error("balance 5 must warn");
if (badgeWarnOf({ mode: "balance", status: "ok", balance: { remaining: 0, currency: "USD" } }) !== true) throw new Error("balance 0 must warn");
// subscription: lowest remaining percent wins
const subLow = badgeAccountValue({ mode: "subscription", status: "ok", windows: [{ remainingPercent: 40 }, { remainingPercent: 4 }] });
if (subLow === null || subLow.kind !== "percent" || subLow.value !== 4 || subLow.display !== "4%") throw new Error(`subscription must warn on the lowest window, got ${JSON.stringify(subLow)}`);
if (badgeWarnOf({ mode: "subscription", status: "ok", windows: [{ remainingPercent: 40 }, { remainingPercent: 4 }] }) !== true) throw new Error("subscription with a 4% window must warn");
if (badgeWarnOf({ mode: "subscription", status: "ok", windows: [{ remainingPercent: 40 }, { remainingPercent: 55 }] }) !== false) throw new Error("subscription all above 5% must NOT warn");
// not-configured / unavailable / empty => no misleading numeric value, no warning
if (badgeAccountValue({ mode: "balance", status: "not-configured" }) !== null) throw new Error("not-configured balance must not show a numeric badge");
if (badgeAccountValue({ mode: "subscription", status: "unavailable", windows: [] }) !== null) throw new Error("unavailable subscription must not show a numeric badge");
if (badgeWarnOf({ mode: "balance", status: "not-configured" }) !== false) throw new Error("not-configured must never warn");
if (badgeWarnOf(null) !== false) throw new Error("null account must never warn");
// stale/unavailable snapshots that still carry PREVIOUS data must NOT render a
// colored value (the badge must not show an outdated balance/quota as current)
const staleBalance = { mode: "balance", status: "unavailable", stale: true, balance: { remaining: 2, currency: "CNY" } };
if (badgeAccountValue(staleBalance) !== null) throw new Error("stale balance snapshot must not render a numeric badge");
if (badgeWarnOf(staleBalance) !== false) throw new Error("stale balance snapshot must never warn");
const staleSubscription = { mode: "subscription", status: "unavailable", stale: true, windows: [{ remainingPercent: 3 }] };
if (badgeAccountValue(staleSubscription) !== null) throw new Error("stale subscription snapshot must not render a numeric badge");
if (badgeWarnOf(staleSubscription) !== false) throw new Error("stale subscription snapshot must never warn");
// a stale flag on an otherwise ok snapshot is also a no-render condition
const okButStale = { mode: "balance", status: "ok", stale: true, balance: { remaining: 100, currency: "USD" } };
if (badgeAccountValue(okButStale) !== null) throw new Error("ok-but-stale snapshot must not render a numeric badge");
console.log("collapsed-badge account value + warning policy ok");

// Current Session Pill: one server-resolved provider/account snapshot is
// reduced to a compact, neutral-by-default view model. No provider inference
// or client-owned warning thresholds are allowed here.
const {
	CurrentSessionPill,
	CurrentSessionPillView,
	formatResetCountdown,
	loadSessionPillSnapshot,
	requestUsageStatsPanel,
	sessionContextSignalOf,
	sessionPillViewOf,
	modelSelectionSignalOf,
	subscribeUsageStatsPanel
} = exports_;
if ([CurrentSessionPill, CurrentSessionPillView, formatResetCountdown, loadSessionPillSnapshot, requestUsageStatsPanel, sessionContextSignalOf, sessionPillViewOf, modelSelectionSignalOf, subscribeUsageStatsPanel].some((entry) => typeof entry !== "function")) {
	throw new Error("current-session pill exports are incomplete");
}
const resetTranslate = (key, params) => {
	if (key === "duration.minutes") return `${params.minutes}m`;
	if (key === "duration.hoursMinutes") return `${params.hours}h ${params.minutes}m`;
	if (key === "duration.daysHours") return `${params.days}d ${params.hours}h`;
	if (key === "subscription.resets") return `Resets in ${params.time}`;
	if (key === "subscription.resetDue") return "Reset due";
	return key;
};
const resetNow = Date.parse("2026-08-24T00:00:00Z");
assert.equal(formatResetCountdown(null, resetNow, resetTranslate), "");
assert.equal(formatResetCountdown("invalid", resetNow, resetTranslate), "");
assert.equal(formatResetCountdown("2026-08-23T23:59:00Z", resetNow, resetTranslate), "Reset due");
assert.equal(formatResetCountdown("2026-08-24T00:05:00Z", resetNow, resetTranslate), "Resets in 5m");
assert.equal(formatResetCountdown("2026-08-24T02:37:00Z", resetNow, resetTranslate), "Resets in 2h 37m");
assert.equal(formatResetCountdown("2026-08-27T14:00:00Z", resetNow, resetTranslate), "Resets in 3d 14h");
const pillTranslate = (key, params) => {
	if (params?.provider !== void 0 && params?.value !== void 0) return `${params.provider}: ${params.value}`;
	if (key === "duration.minutes") return `${params.minutes}m`;
	if (key === "duration.hoursMinutes") return `${params.hours}h ${params.minutes}m`;
	if (key === "duration.daysHours") return `${params.days}d ${params.hours}h`;
	if (key === "subscription.resets" && params?.time !== void 0) return `reset:${params.time}`;
	if (key === "subscription.resetDue") return "reset:due";
	return key;
};
const pillContext = {
	sessionId: "session/one",
	providerId: "deepseek-official",
	providerFamily: "deepseek",
	model: "deepseek-chat",
	accountId: "deepseek-official"
};
const balancePillSnapshot = {
	context: pillContext,
	account: {
		id: "deepseek-official",
		displayName: "DeepSeek",
		mode: "balance",
		status: "ok",
		balance: { remaining: 36.44, currency: "CNY", unlimited: false },
		alert: { level: "normal", metric: "balance", value: 36.44 },
		credentialRef: "MUST_NOT_RENDER",
		baseURL: "https://secret.invalid"
	}
};
const balancePill = sessionPillViewOf(balancePillSnapshot, pillTranslate);
if (balancePill.providerId !== "deepseek-official" || balancePill.providerLabel !== "DeepSeek") throw new Error("balance pill lost server-resolved provider identity");
if (!balancePill.value.includes("36.44") || balancePill.tone !== "normal") throw new Error(`balance pill value/tone incorrect: ${JSON.stringify(balancePill)}`);
const unlimitedPill = sessionPillViewOf({
	context: pillContext,
	account: { ...balancePillSnapshot.account, balance: { remaining: null, currency: "USD", unlimited: true } }
}, pillTranslate);
if (unlimitedPill.value !== "∞") throw new Error("unlimited balance pill must render infinity");

const subscriptionPill = sessionPillViewOf({
	context: { ...pillContext, providerId: "opencode-go", accountId: "opencode-go" },
	account: {
		id: "opencode-go",
		displayName: "OpenCode Go",
		mode: "subscription",
		status: "ok",
		windows: [
			{ kind: "session", remainingPercent: 42 },
			{ kind: "weekly", remainingPercent: 8 },
			{ kind: "monthly", remainingPercent: null }
		],
		alert: { level: "critical", metric: "remaining-percent", value: 8 }
	}
}, pillTranslate);
if (subscriptionPill.providerLabel !== "OpenCode Go" || !subscriptionPill.value.includes("subscription.window.weekly") || !subscriptionPill.value.includes("8%")) {
	throw new Error(`subscription pill must show the tightest valid window: ${JSON.stringify(subscriptionPill)}`);
}
if (subscriptionPill.tone !== "critical") throw new Error("subscription pill tone must come from account.alert.level");
if (subscriptionPill.ariaLabel.includes("reset:")) throw new Error("subscription pill without resetsAt must not invent reset information");
const subscriptionPillWithResetSnapshot = {
	context: { ...pillContext, providerId: "opencode-go", accountId: "opencode-go" },
	account: {
		id: "opencode-go",
		displayName: "OpenCode Go",
		mode: "subscription",
		status: "ok",
		windows: [
			{ kind: "session", remainingPercent: 42, resetsAt: "2026-08-24T01:00:00Z" },
			{ kind: "weekly", remainingPercent: 8, resetsAt: "2026-08-30T01:00:00Z" }
		],
		alert: { level: "critical", metric: "remaining-percent", value: 8 }
	}
};
const subscriptionPillWithReset = sessionPillViewOf(subscriptionPillWithResetSnapshot, pillTranslate, resetNow);
if (!subscriptionPillWithReset.ariaLabel.includes("reset:")) throw new Error("subscription pill must expose the tightest window reset through accessible text");
if (subscriptionPillWithReset.value !== subscriptionPill.value) throw new Error("reset information must not expand the compact visible pill value");
const warningPill = sessionPillViewOf({ ...balancePillSnapshot, account: { ...balancePillSnapshot.account, alert: { level: "warning" } } }, pillTranslate);
if (warningPill.tone !== "warning") throw new Error("warning alert tone must be preserved");

const statusKeys = new Map([
	["not-configured", "subscription.status.notConfigured"],
	["unauthorized", "subscription.status.unauthorized"],
	["rate-limited", "subscription.status.rateLimited"],
	["unavailable", "subscription.status.unavailable"],
	["invalid-response", "account.status.invalidResponse"],
	["blocked", "account.status.blocked"],
	["unsupported", "sessionPill.status.unsupported"],
	["unknown", "account.status.unknown"]
]);
for (const [status, expected] of statusKeys) {
	const view = sessionPillViewOf({
		context: pillContext,
		account: { ...balancePillSnapshot.account, status, alert: { level: "critical" } }
	}, pillTranslate);
	if (view.value !== expected || view.tone !== "neutral") throw new Error(`${status} pill must be a neutral status, got ${JSON.stringify(view)}`);
}
const unknownProviderPill = sessionPillViewOf({ context: { ...pillContext, providerId: "relay-a", accountId: "relay-a" }, account: null, status: "unsupported" }, pillTranslate);
if (unknownProviderPill.providerLabel !== "relay-a" || unknownProviderPill.value !== "sessionPill.status.unsupported" || unknownProviderPill.tone !== "neutral") {
	throw new Error("unknown/no-adapter provider must remain a neutral server identity");
}

let openedProvider = null;
const pillElement = CurrentSessionPillView({ snapshot: balancePillSnapshot, translate: pillTranslate, onOpen: (id) => { openedProvider = id; } });
if (pillElement.type !== "button" || pillElement.props["data-current-session-pill"] !== true) throw new Error("pill view needs one stable button root");
pillElement.props.onClick();
if (openedProvider !== "deepseek-official") throw new Error(`pill click must open the account panel at its provider, got ${openedProvider}`);
const balancePillMarkup = renderToStaticMarkup(pillElement);
const subscriptionPillElement = CurrentSessionPillView({
	snapshot: {
		context: { ...pillContext, providerId: "opencode-go", accountId: "opencode-go" },
		account: { id: "opencode-go", displayName: "OpenCode Go", mode: "subscription", status: "ok", windows: [{ kind: "weekly", remainingPercent: 8 }], alert: { level: "critical" } }
	},
	translate: pillTranslate,
	onOpen: () => {}
});
const subscriptionPillMarkup = renderToStaticMarkup(subscriptionPillElement);
const subscriptionPillWithResetElement = CurrentSessionPillView({
	snapshot: subscriptionPillWithResetSnapshot,
	translate: pillTranslate,
	now: resetNow,
	onOpen: () => {}
});
if (!subscriptionPillWithResetElement.props.title.includes("reset:") || subscriptionPillWithResetElement.props["aria-label"] !== subscriptionPillWithResetElement.props.title) {
	throw new Error("known resetsAt must be exposed consistently through the pill title and aria-label");
}
if (subscriptionPillElement.props.title.includes("reset:") || subscriptionPillElement.props["aria-label"].includes("reset:")) {
	throw new Error("missing resetsAt must leave the pill title and aria-label free of invented reset information");
}
if (!balancePillMarkup.includes('data-tone="normal"') || !subscriptionPillMarkup.includes('data-tone="critical"')) throw new Error("pill alert tones missing from markup");
if (balancePillMarkup.includes("MUST_NOT_RENDER") || balancePillMarkup.includes("secret.invalid")) throw new Error("pill must not render credential or connection fields");
if (pillElement.type !== subscriptionPillElement.type || balancePillMarkup === subscriptionPillMarkup) throw new Error("provider switch must update the existing pill root");

const requests = [];
let currentProvider = "deepseek-official";
const fetchPill = async (path) => {
	requests.push(path);
	if (path.startsWith("/api/usage-stats/session-context")) return {
		ok: true,
		context: { ...pillContext, providerId: currentProvider, accountId: currentProvider }
	};
	return {
		ok: true,
		account: currentProvider === "deepseek-official"
			? balancePillSnapshot.account
			: { id: "opencode-go", displayName: "OpenCode Go", mode: "subscription", status: "ok", windows: [{ kind: "weekly", remainingPercent: 18 }], alert: { level: "warning" } }
	};
};
const firstPillLoad = await loadSessionPillSnapshot("session/one", fetchPill);
currentProvider = "opencode-go";
const switchedPillLoad = await loadSessionPillSnapshot("session/one", fetchPill);
if (firstPillLoad.account.id !== "deepseek-official" || switchedPillLoad.account.id !== "opencode-go") throw new Error("session provider switch must resolve a fresh account snapshot");
if (requests[0] !== "/api/usage-stats/session-context?session=session%2Fone") throw new Error(`session context request must carry the explicit encoded session id: ${requests[0]}`);
if (!requests.includes("/api/usage-stats/account?provider=opencode-go&activity=active")) throw new Error("pill must reuse the unified account endpoint and mark the server-owned active provider");
await loadSessionPillSnapshot("session/one", fetchPill, { provider: "route:two", model: "same/model" });
if (!requests.includes("/api/usage-stats/session-context?session=session%2Fone&provider=route%3Atwo&model=same%2Fmodel")) {
	throw new Error("the formal model-selector route must be encoded as a session-context hint");
}
let noContextRequests = 0;
const noContext = await loadSessionPillSnapshot("blank", async () => {
	noContextRequests += 1;
	return { ok: true, context: null };
});
if (noContext !== null || noContextRequests !== 1) throw new Error("a session without route context must silently omit the pill and skip account lookup");
const unsupportedLoad = await loadSessionPillSnapshot("unknown", async (path) => path.includes("session-context")
	? { ok: true, context: { ...pillContext, providerId: "relay-a", accountId: "relay-a" } }
	: { ok: false, error: "unknown-provider" });
if (unsupportedLoad.status !== "unsupported" || unsupportedLoad.account !== null) throw new Error("unknown account adapters must degrade to a neutral unsupported snapshot");

const baseSession = { running: false, removed: false, nodes: [], chat: { order: [] }, partial: null };
const baseSignal = sessionContextSignalOf(baseSession);
if (sessionContextSignalOf({ ...baseSession }) !== baseSignal) throw new Error("unrelated session object replacement must not trigger a pill request");
if (sessionContextSignalOf({ ...baseSession, running: true }) === baseSignal) throw new Error("turn start must trigger an event-driven pill refresh");
if (sessionContextSignalOf({ ...baseSession, nodes: [{}] }) === baseSignal) throw new Error("new message must trigger an event-driven pill refresh");
if (sessionContextSignalOf({ ...baseSession, partial: {} }) === baseSignal) throw new Error("assistant activity must trigger an event-driven pill refresh");
if (modelSelectionSignalOf({ current: { provider: "a:b", model: "c" } }) === modelSelectionSignalOf({ current: { provider: "a", model: "b:c" } })) {
	throw new Error("model selection refresh keys must not collide when route ids contain colons");
}

// Exercise the actual hook lifecycle. A host model-directory notification must
// clear the old provider immediately, then replace the same button root after
// the server-owned session-context/account chain settles.
let lifecycleProvider = "deepseek-official";
let resolveSwitchedContext;
let holdSwitchedContext = false;
const lifecycleRequests = [];
const lifecycleRequest = async (path) => {
	lifecycleRequests.push(path);
	if (path.startsWith("/api/usage-stats/session-context")) {
		if (holdSwitchedContext) return new Promise((resolve) => { resolveSwitchedContext = resolve; });
		return { ok: true, context: { ...pillContext, providerId: lifecycleProvider, accountId: lifecycleProvider } };
	}
	return {
		ok: true,
		account: lifecycleProvider === "deepseek-official"
			? balancePillSnapshot.account
			: { id: "opencode-go", displayName: "OpenCode Go", mode: "subscription", status: "ok", windows: [{ kind: "weekly", remainingPercent: 18 }], alert: { level: "warning" } }
	};
};
let pillRenderer;
await act(async () => {
	pillRenderer = TestRenderer.create(react.createElement(CurrentSessionPill, {
		sessionId: "session-one",
		session: baseSession,
		modelDirectory,
		request: lifecycleRequest,
		t: (key) => key
	}));
	await Promise.resolve();
	await Promise.resolve();
});
if (pillRenderer.root.findAllByProps({ "data-current-session-pill": true }).length !== 1) throw new Error("successful mount must create exactly one pill");
if (pillRenderer.root.findByType("button").props["data-provider"] !== "deepseek-official") throw new Error("initial lifecycle provider missing");

lifecycleProvider = "opencode-go";
holdSwitchedContext = true;
await act(async () => {
	modelSnapshot = { current: { provider: "opencode-go", model: "same-model" } };
	for (const subscriber of modelSubscribers) subscriber();
	await Promise.resolve();
});
if (pillRenderer.toJSON() !== null) throw new Error("provider switch must not leave the previous session/account pill clickable while loading");
holdSwitchedContext = false;
await act(async () => {
	resolveSwitchedContext({ ok: true, context: { ...pillContext, providerId: "opencode-go", accountId: "opencode-go" } });
	await Promise.resolve();
	await Promise.resolve();
});
const switchedButtons = pillRenderer.root.findAllByProps({ "data-current-session-pill": true });
if (switchedButtons.length !== 1 || switchedButtons[0].props["data-provider"] !== "opencode-go") throw new Error("provider switch must update the existing single pill root");
if (!lifecycleRequests.includes("/api/usage-stats/session-context?session=session-one&provider=opencode-go&model=same-model")) {
	throw new Error("model-directory notifications must refresh session-context with the current route hint");
}
await act(async () => { pillRenderer.unmount(); });

// Multiple panel roots are not expected, but one unmount must never erase a
// still-mounted opener. This bus is the cross-slot bridge, not another cache.
const openedBy = [];
const stopFirstOpener = subscribeUsageStatsPanel((providerId) => openedBy.push(`first:${providerId}`));
const stopSecondOpener = subscribeUsageStatsPanel((providerId) => openedBy.push(`second:${providerId}`));
requestUsageStatsPanel("opencode-go");
stopSecondOpener();
requestUsageStatsPanel("deepseek-official");
stopFirstOpener();
if (openedBy.join(",") !== "second:opencode-go,first:deepseek-official") throw new Error(`panel opener lifecycle must target one newest mounted subscriber and then fall back: ${openedBy.join(",")}`);

// Mount the real existing panel plus the pill and verify a click opens that
// panel with the current provider selected. Network and timers are inert test
// doubles; production still uses the panel's existing refresh/cache path.
const originalFetch = globalThis.fetch;
const integrationRequests = [];
document.addEventListener = () => {};
document.removeEventListener = () => {};
window.setInterval = () => 1;
window.clearInterval = () => {};
globalThis.fetch = async (path) => {
	integrationRequests.push(String(path));
	return {
		ok: true,
		json: async () => {
			if (String(path).includes("/providers")) return {
				ok: true,
				providers: [
					{ id: "deepseek-official", displayName: "DeepSeek", configured: true, accountMode: "balance" },
					{ id: "opencode-go", displayName: "OpenCode Go", configured: true, accountMode: "subscription" }
				]
			};
			if (String(path).includes("/account")) return { ok: true, account: { id: "opencode-go", displayName: "OpenCode Go", mode: "subscription", status: "ok", windows: [{ kind: "weekly", remainingPercent: 18 }], alert: { level: "warning" } } };
			return { ok: true, days: [], total: { tokens: 0 } };
		}
	};
};
let integrationRenderer;
await act(async () => {
	integrationRenderer = TestRenderer.create(react.createElement(react.Fragment, {},
		react.createElement(UsageStatsPanel, { wide: true, t: (key) => key }),
		react.createElement(CurrentSessionPillView, {
			snapshot: { ...balancePillSnapshot, context: { ...pillContext, providerId: "opencode-go", accountId: "opencode-go" } },
			translate: pillTranslate
		})
	));
	await Promise.resolve();
});
await act(async () => {
	integrationRenderer.root.findByProps({ "data-current-session-pill": true }).props.onClick();
	await Promise.resolve();
	await Promise.resolve();
});
if (integrationRenderer.root.findAllByProps({ "data-usage-stats-panel": true }).length !== 1) throw new Error("pill click must open the existing account panel");
const selectedPicker = integrationRenderer.root.findByType("select");
if (selectedPicker.props.value !== "opencode-go") throw new Error(`pill click must select its provider in the existing panel, got ${selectedPicker.props.value}`);
if (!integrationRequests.some((path) => path.includes("/account?provider=opencode-go&activity=detail"))) throw new Error("the open detail panel must signal its provider to the central scheduler");
await act(async () => { integrationRenderer.unmount(); });
globalThis.fetch = originalFetch;

console.log("current-session pill rendering, switching, hook lifecycle, and request policy ok");
console.log("SMOKE TEST PASSED");
