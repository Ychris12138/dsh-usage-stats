/** Qianwen personal Token Plan protocol. All credentials stay in the caller's process. */
import { createHash, randomBytes, randomUUID } from "node:crypto";

const API_PREFIX = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/";
const TIERS = new Set(["lite", "essential", "standard", "pro"]);
const MAX_BYTES = 1024 * 1024;

function failure(code) {
	const error = new Error(code);
	error.code = code;
	return error;
}

/** No upstream response body or request URL is ever included in an error. */
async function requestJSON(fetcher, url, init, timeoutMs) {
	let response;
	try {
		response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
	} catch { throw failure("qianwen-network-error"); }
	if (!response.ok) throw failure(response.status === 401 || response.status === 403 ? "qianwen-unauthorized" : response.status === 429 ? "qianwen-rate-limited" : "qianwen-unavailable");
	const length = Number(response.headers?.get?.("content-length"));
	if (Number.isFinite(length) && length > MAX_BYTES) throw failure("qianwen-invalid-response");
	let text;
	try {
		if (response.body?.getReader) {
			const reader = response.body.getReader();
			const chunks = [];
			let length = 0;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				length += value.byteLength;
				if (length > MAX_BYTES) { await reader.cancel(); throw failure("qianwen-invalid-response"); }
				chunks.push(value);
			}
			text = Buffer.concat(chunks).toString("utf8");
		} else text = await response.text();
	} catch { throw failure("qianwen-invalid-response"); }
	if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BYTES) throw failure("qianwen-invalid-response");
	try { return JSON.parse(text); } catch { throw failure("qianwen-invalid-response"); }
}

function authURL(path, fields) {
	const url = new URL(path, "https://t.qianwenai.com");
	for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
	return url.href;
}

/** The device secret and PKCE verifier are deliberately kept inside this closure. */
export function createQianwenAuth({ fetch: fetcher = fetch, timeoutMs = 15000, now = Date.now } = {}) {
	let pending = null;
	return {
		async start() {
			const clientId = randomUUID();
			const verifier = randomBytes(32).toString("base64url");
			const challenge = createHash("sha256").update(verifier).digest("base64url");
			const body = await requestJSON(fetcher, authURL("/cli/device/code", { client_id: clientId, code_challenge: challenge, code_challenge_method: "S256" }), { method: "POST" }, timeoutMs);
			const data = body?.Data;
			let verification;
			try { verification = new URL(data?.VerificationUrl); } catch { throw failure("qianwen-invalid-response"); }
			if (body?.Success !== true || typeof data?.Token !== "string" || data.Token === "" || verification.origin !== "https://account.qianwenai.com" || verification.username || verification.password || !Number.isFinite(data.ExpiresIn) || data.ExpiresIn <= 0 || data.ExpiresIn > 600 || !Number.isFinite(data.Interval) || data.Interval <= 0 || data.Interval > 60) throw failure("qianwen-invalid-response");
			pending = { clientId, verifier, token: data.Token, deadline: now() + data.ExpiresIn * 1000, interval: data.Interval, nextPoll: now() + data.Interval * 1000 };
			return { verificationUrl: verification.href, expiresIn: data.ExpiresIn, interval: data.Interval };
		},
		async poll() {
			if (!pending) throw failure("qianwen-no-pending-login");
			if (now() >= pending.deadline) { pending = null; return { status: "expired" }; }
			if (now() < pending.nextPoll) return { status: "pending" };
			const flow = pending;
			flow.nextPoll = now() + flow.interval * 1000;
			const body = await requestJSON(fetcher, authURL("/cli/device/token", { client_id: flow.clientId, token: flow.token, code_verifier: flow.verifier }), { method: "POST" }, timeoutMs);
			if (pending !== flow) throw failure("qianwen-login-replaced");
			const status = String(body?.Data?.Status ?? body?.status ?? "").toLowerCase();
			if (status === "authorization_pending") return { status: "pending" };
			if (status === "slow_down") { flow.interval += 5; flow.nextPoll = now() + flow.interval * 1000; return { status: "pending" }; }
			if (status === "access_denied" || status === "expired_token") { pending = null; return { status: status === "access_denied" ? "denied" : "expired" }; }
			const accessToken = body?.Data?.Credentials?.AccessToken ?? body?.credentials?.access_token;
			const expiresAt = body?.Data?.Credentials?.ExpireTime ?? body?.credentials?.expire_time;
			if (status !== "complete" || typeof accessToken !== "string" || accessToken.trim() === "" || typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now()) { pending = null; throw failure("qianwen-invalid-response"); }
			pending = null;
			return { status: "complete", credential: { accessToken, expiresAt } };
		},
		cancel() { pending = null; }
	};
}

function unwrap(body) {
	const result = body?.data?.DataV2;
	if (body?.code !== "200" || body?.successResponse !== true || body?.data?.success !== true || !Array.isArray(result?.ret) || typeof result.ret[0] !== "string" || !result.ret[0].startsWith("SUCCESS::") || result?.data?.success !== true || result?.data?.code !== "SUCCESS") throw failure("qianwen-invalid-response");
	return result.data.data;
}

/** Query only fixed, read-only official actions; never fall back to the model API key. */
export async function queryQianwenPersonalPlan(credential, { fetch: fetcher = fetch, timeoutMs = 15000, now = Date.now } = {}) {
	if (typeof credential?.accessToken !== "string" || credential.accessToken.trim() === "" || typeof credential.expiresAt !== "string" || !Number.isFinite(Date.parse(credential.expiresAt)) || Date.parse(credential.expiresAt) <= now()) throw failure("qianwen-unauthorized");
	const issued = await requestJSON(fetcher, "https://cli.qianwenai.com/data/v2/api.json", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential.accessToken}` }, body: JSON.stringify({ product: "ModelStudioRegional", action: "GenerateCLIAccessToken", region: "cn-beijing", params: {}, version: "2026-02-10" }) }, timeoutMs);
	const token = issued?.data?.cliAccessToken;
	if (issued?.code !== "200" || issued?.successResponse !== true || typeof token !== "string" || token === "" || token === credential.accessToken) throw failure("qianwen-invalid-response");
	async function query(action, data = {}) {
		const api = API_PREFIX + action;
		const url = new URL("https://cs-data.qianwenai.com/cli/api.json");
		url.search = new URLSearchParams({ action: "BroadScopeAspnGateway", product: "sfm_bailian", api });
		const params = { Api: api, V: "1.0", Data: { ...data, cornerstoneParam: { protocol: "V2", console: "ONE_CONSOLE", productCode: "p_efm", switchUserType: 3, consoleSite: "QIANWENAI" } } };
		const body = await requestJSON(fetcher, url.href, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${token}` }, body: new URLSearchParams({ params: JSON.stringify(params), region: "cn-beijing" }).toString() }, timeoutMs);
		return unwrap(body);
	}
	const [subscription, usage, quota] = await Promise.all([query("subscription", { commodityCode: "sfm_tokenplansolo_public_cn" }), query("usage"), query("quota-config")]);
	if (!subscription || subscription.status !== "VALID" || !TIERS.has(subscription.specCode) || !Number.isSafeInteger(subscription.startTime) || !Number.isSafeInteger(subscription.endTime) || subscription.startTime > now() || subscription.endTime <= now()) throw failure("qianwen-invalid-response");
	const cycle = typeof usage?.per1MonthPercentage === "number" ? "monthly" : typeof usage?.per1WeekPercentage === "number" ? "weekly" : null;
	const ratio = cycle === "monthly" ? usage.per1MonthPercentage : usage?.per1WeekPercentage;
	if (!cycle || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw failure("qianwen-invalid-response");
	const reset = cycle === "monthly" ? usage.per1MonthResetTime : usage.per1WeekResetTime;
	if (reset !== undefined && reset !== null && (!Number.isSafeInteger(reset) || reset < 0 || reset > 8640000000000000)) throw failure("qianwen-invalid-response");
	const limit = quota?.[subscription.specCode]?.[cycle];
	const total = typeof limit === "number" && Number.isFinite(limit) && limit >= 0 ? limit : null;
	const usedPercent = Math.round(ratio * 1000) / 10;
	const window = { kind: cycle, usedPercent, remainingPercent: Math.round((100 - ratio * 100) * 10) / 10, ...(reset == null ? {} : { resetsAt: new Date(reset).toISOString() }) };
	return { status: "ok", plan: `Qianwen Token Plan ${subscription.specCode}`, windows: [window], ...(total === null ? {} : { quota: { total, unit: "credits" } }) };
}
