// Smoke-test the hand-written client bundle outside the browser:
// 1. feed it to a fake __ModuleLoader__ (captures the factory)
// 2. run the factory with a fake require (real react, stubbed primitives)
// 3. render <UsageStatsPanel wide t> with react-dom/server
// 4. run apply(ctx) against a stub client context
import { createRequire } from "node:module";
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
new Function(source)(); // executes the window.__ModuleLoader__.load call

if (captured === null) throw new Error("loader did not capture the bundle");
if (captured.id !== "dsh-usage-stats") throw new Error(`unexpected id ${captured.id}`);

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

// Render the panel (closed state) to static markup.
const { UsageStatsPanel } = exports_;
const markup = renderToStaticMarkup(react.createElement(UsageStatsPanel, { wide: true, t: (key) => key }));
if (!markup.includes("用量/余额") && !markup.includes("panel.badge")) throw new Error("badge label missing from markup");
console.log("render ok, markup length:", markup.length);

// Apply against a stub client context.
const registrations = [];
const ctx = {
	effect: () => {},
	locale: { register: (ns, dict) => { if (ns !== "usageStats") throw new Error(`unexpected ns ${ns}`); if (!dict.zh || !dict.en) throw new Error("missing dictionaries"); } },
	slots: { inject: (slot, fn) => { registrations.push([slot, fn]); return () => {}; }, register: () => () => {} }
};
exports_.apply(ctx);
if (registrations.length !== 1) throw new Error("expected one slot injection");
const [slot, registerFn] = registrations[0];
if (slot !== "sidebar.footer.action") throw new Error(`unexpected slot ${slot}`);
const disposer = registerFn();
if (typeof disposer !== "function") throw new Error("slot registration must return a disposer");
console.log("apply ok, slot:", slot);

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
const deepseekMarkup = renderToStaticMarkup(react.createElement(ProviderAccountCard, {
	provider: { id: "deepseek-official", displayName: "DeepSeek", accountMode: "balance" },
	account: {
		id: "deepseek-official",
		displayName: "DeepSeek",
		mode: "balance",
		status: "ok",
		balance: { remaining: 36.44, currency: "CNY", unlimited: false, breakdown: { toppedUp: 20, granted: 16.44 } }
	},
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
	account: { id: "minimax", displayName: "MiniMax", mode: "subscription", status: "invalid-response", windows: [] },
	accountLoading: false,
	accountError: null,
	translate: translateAccount,
	onRetry: () => {}
}));
if (!invalidMarkup.includes("account.status.invalidResponse") || !invalidMarkup.includes("account.invalidResponse")) throw new Error("invalid account responses need a distinct status and explanation");

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
console.log("SMOKE TEST PASSED");
