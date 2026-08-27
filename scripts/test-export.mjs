import assert from "node:assert/strict";
import { dailyCsv, EXPORT_SCHEMA_VERSION, jsonExport, sessionsCsv } from "../lib/export.js";

const secret = "sk-super-secret";
const usage = {
	updatedAt: Date.parse("2026-08-26T12:00:00Z"),
	total: {
		inputTokens: 100,
		cacheReadTokens: 20,
		cacheWriteTokens: 10,
		outputTokens: 5,
		tokens: 135,
		cacheHitRate: 15.4,
		estimatedCost: 0.25,
		currency: "USD",
		costComplete: true,
		pricing: { ruleIds: ["deepseek-c"], source: { kind: "official", provider: "deepseek", url: "https://api-docs.deepseek.com/quick_start/pricing/" }, updatedAt: "2026-08-26" }
	},
	days: [{
		date: "2026-08-26",
		inputTokens: 100,
		cacheReadTokens: 20,
		cacheWriteTokens: 10,
		outputTokens: 5,
		tokens: 135,
		costComplete: true,
		estimatedCost: 0.25,
		currency: "USD",
		models: [{
			model: "deepseek-official/=HYPERLINK(\"https://evil.invalid\")",
			inputTokens: 100,
			cacheReadTokens: 20,
			cacheWriteTokens: 10,
			outputTokens: 5,
			tokens: 135,
			costComplete: false,
			estimatedCost: 999,
			currency: "USD",
			credential: secret
		}]
	}],
	sessions: [{
		sessionId: "session,\"一\"",
		title: "=1+1 中文",
		providers: ["deepseek-official"],
		models: ["deepseek-official/deepseek-chat"],
		tokens: 135,
		costComplete: true,
		estimatedCost: 0.25,
		currency: "USD",
		firstAt: "2026-08-26T11:00:00.000Z",
		lastAt: "2026-08-26T12:00:00.000Z",
		authorization: secret
	}],
	budgets: {
		currency: "USD",
		daily: { limit: 1, currency: "USD", estimatedSpend: 0.25, percent: 25, costComplete: true, level: "normal" },
		monthly: { limit: null, currency: "USD", estimatedSpend: 0.25, percent: null, costComplete: true, level: "disabled" }
	},
	apiKey: secret
};

const daily = dailyCsv(usage);
assert.ok(daily.startsWith("\uFEFF\"date\",\"provider\",\"model\""));
assert.match(daily, /"deepseek-official"/);
assert.match(daily, /"'=HYPERLINK\(""https:\/\/evil\.invalid""\)"/);
assert.match(daily, /,"",""\r\n$/, "incomplete costs must export as blank amount/currency");
assert.doesNotMatch(daily, new RegExp(secret));

const sessions = sessionsCsv(usage);
assert.match(sessions, /"session,""一"""/);
assert.match(sessions, /"'=1\+1 中文"/);
assert.doesNotMatch(sessions, new RegExp(secret));
assert.match(sessionsCsv({ sessions: [{ sessionId: "line-break", title: "line 1\r\nline 2", tokens: 0 }] }), /"line 1\r\nline 2"/, "embedded CR/LF must remain inside a quoted CSV field");
assert.match(sessionsCsv({ sessions: [{ sessionId: "formula-after-newline", title: "\n=cmd", tokens: 0 }] }), /"'\n=cmd"/, "a leading newline must not bypass spreadsheet-formula protection");

const accounts = [{
	id: "relay-a",
	displayName: "Relay A",
	accountMode: "balance",
	adapter: "new-api",
	configured: true,
	status: "ok",
	provenance: "custom",
	reason: "healthy",
	alert: { level: "normal", metric: "balance", value: 12 },
	credential: secret,
	baseURL: `https://user:${secret}@relay.invalid/?token=${secret}`
}];
const full = jsonExport(usage, accounts, Date.parse("2026-08-26T12:30:00Z"));
assert.equal(full.schemaVersion, EXPORT_SCHEMA_VERSION);
assert.equal(full.exportedAt, "2026-08-26T12:30:00.000Z");
assert.equal(full.usage.days[0].models[0].estimatedCost, null);
assert.equal(full.usage.days[0].models[0].costComplete, false);
assert.deepEqual(full.usage.total.pricing.source, { kind: "official", provider: "deepseek", url: "https://api-docs.deepseek.com/quick_start/pricing/" });
assert.equal(full.accounts[0].id, "relay-a");
assert.equal(full.accounts[0].baseURL, void 0);
assert.equal(full.accounts[0].credential, void 0);
assert.doesNotMatch(JSON.stringify(full), new RegExp(secret));

assert.throws(() => jsonExport(usage, accounts, Infinity), /Invalid time value/);

console.log("secret-free CSV/JSON export tests passed");
