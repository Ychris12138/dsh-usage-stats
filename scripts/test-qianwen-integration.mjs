import assert from "node:assert/strict";
import { apply, QIANWEN_INTEGRATION_PATH } from "../lib/index.js";
import { QIANWEN_AUTH_REF, createQianwenIntegration } from "../lib/qianwen-integration.js";

const secrets = new Map();
const credentials = {
	set: async (ref, value) => { secrets.set(ref, value); },
	resolve: async (ref) => secrets.has(ref) ? { value: secrets.get(ref) } : null,
	unset: async (ref) => { secrets.delete(ref); }
};
let starts = 0;
let polls = 0;
const fakeAuth = {
	cancel() {},
	async start() { starts++; return { verificationUrl: "https://account.qianwenai.com/verify?code=example", expiresIn: 300 }; },
	async poll() { polls++; return { status: "complete", credential: { accessToken: "never-expose-this-secret", expiresAt: "2030-01-01T00:00:00Z" } }; }
};
const routes = new Map();
const ctx = {
	credentials,
	get: () => undefined,
	logger: { warn() {} },
	on() {},
	effect(register) { register(); },
	webServer: { register(entry) { routes.set(entry.path, entry.handler); return () => {}; } }
};
const invalidated = [];
await apply(ctx, {}, { qianwenAuth: fakeAuth, accounts: { validate: async () => {}, invalidateAdapter: (id) => invalidated.push(id) }, disableBackgroundRefresh: true });
const route = routes.get(QIANWEN_INTEGRATION_PATH);
async function send(action, overrides = {}) {
	const req = { method: "POST", url: `${QIANWEN_INTEGRATION_PATH}?action=${action}`, headers: { host: "localhost:3080", "content-type": "application/json", "x-dsh-usage-stats-action": `qianwen-${action}` }, socket: { remoteAddress: "127.0.0.1" }, ...overrides };
	const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
	await route(req, res);
	return { ...res, data: JSON.parse(res.body) };
}
assert.equal((await send("start", { method: "GET" })).status, 405);
assert.equal((await send("start", { socket: { remoteAddress: "192.0.2.10" } })).status, 403);
assert.equal((await send("start", { headers: { host: "evil.example", "content-type": "application/json", "x-dsh-usage-stats-action": "qianwen-start" } })).status, 403);
assert.equal((await send("start", { headers: { host: "localhost:3080", "content-type": "text/plain" } })).status, 403);
assert.equal(starts, 0);
const start = await send("start");
assert.equal(start.data.status, "pending");
assert.equal(start.headers["cache-control"], "no-store");
assert.equal(new URL(start.data.verificationUrl).hostname, "account.qianwenai.com");
const connected = await send("poll");
assert.equal(connected.data.status, "connected");
assert.equal(polls, 1);
assert.equal(connected.body.includes("never-expose-this-secret"), false);
assert.equal(JSON.parse(secrets.get(QIANWEN_AUTH_REF)).accessToken, "never-expose-this-secret");
assert.equal((await send("disconnect")).data.status, "disconnected");
assert.equal(secrets.has(QIANWEN_AUTH_REF), false);
assert.deepEqual(invalidated, ["qianwen-token-plan", "qianwen-token-plan"]);
const shadow = createQianwenIntegration({ credentials: { ...credentials, resolve: async () => ({ value: "overriding-environment" }) }, auth: fakeAuth });
assert.equal((await shadow.action("poll")).status, "storage-shadowed");
assert.equal((await shadow.action("disconnect")).status, "storage-shadowed");
console.log("Qianwen authorization route and credential tests passed");
