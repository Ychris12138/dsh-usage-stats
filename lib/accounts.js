/**
 * Unified provider-account monitoring.
 *
 * Adapters normalize monetary balances and subscription/token-plan windows to
 * one discriminated account snapshot. Configuration is declarative: secrets
 * are credential references, request paths are relative, and response fields
 * are extracted with JSON Pointer rather than executable JavaScript.
 *
 * @module dsh-usage-stats/accounts
 */

import { queryBalance } from "./balance.js";
import { isPrivateAddress, isPrivateHostname } from "./network.js";
import { resolveProviderIdentity } from "./provider-identity.js";
import { collectSubscription } from "./subscriptions.js";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export { isPrivateAddress } from "./network.js";

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_REFRESH_MS = 300000;
const DEFAULT_REFRESH_POLICY = Object.freeze({
	activeMs: 60000,
	detailMs: 120000,
	backgroundMs: 900000,
	rateLimitBaseMs: 300000,
	rateLimitMaxMs: 3600000
});
const PROVENANCE_KINDS = new Set(["official", "provider", "configured", "experimental", "unknown"]);
const OFFICIAL_ADAPTERS = new Set([
	"deepseek-balance",
	"openrouter-balance",
	"moonshot-balance",
	"zai-balance",
	"opencode-go",
	"zai-token-plan",
	"kimi-token-plan",
	"minimax-token-plan",
	"ollama"
]);
const PROVIDER_ADAPTERS = new Set(["new-api", "sub2api", "sub2api-auth"]);
const MAX_RESPONSE_BYTES = 1024 * 1024;
const OPENROUTER_MANAGEMENT_REF = "OPENROUTER_MANAGEMENT_KEY";
/**
 * Real Sub2API panels expose a read-only public settings route used to detect
 * the panel (auto-selecting the `sub2api-auth` adapter) and a balance route the
 * provider's own inference API key can query — the same pattern as CC Switch's
 * General usage template (GET {baseUrl}/user/balance with a Bearer api key).
 */
const SUB2API_BALANCE_PATH = "/user/balance";
const SUB2API_USAGE_STATS_PATH = "/api/v1/usage/stats?period=today";
const SUB2API_PUBLIC_SETTINGS_PATH = "/api/v1/settings/public";
const ACCOUNT_STATUSES = new Set([
	"ok",
	"not-configured",
	"unauthorized",
	"rate-limited",
	"unavailable",
	"invalid-response",
	"blocked",
	"unsupported"
]);
const SAFE_REASON_CODES = new Set([
	"dns-resolution-failed",
	"timeout",
	"rate-limited",
	"unauthorized",
	"upstream-invalid-json",
	"upstream-not-json",
	"upstream-too-large",
	"upstream-invalid-response",
	"blocked-network",
	"all-addresses-unreachable",
	"no-validated-address",
	"sub2api-balance-shape-unrecognized",
	"unknown"
]);
const HEALTH_ATTEMPTED = Symbol("account-health-attempted");
const HEALTH_SUCCEEDED = Symbol("account-health-succeeded");
const ADAPTERS = new Set([
	"deepseek-balance",
	"openrouter-balance",
	"moonshot-balance",
	"zai-balance",
	"general",
	"new-api",
	"sub2api",
	"sub2api-auth",
	"opencode-go",
	"zai-token-plan",
	"kimi-token-plan",
	"minimax-token-plan",
	"ollama",
	"declarative"
]);
const SENSITIVE_HEADERS = new Set([
	"authorization",
	"api-key",
	"cookie",
	"host",
	"proxy-authorization",
	"proxy-authenticate",
	"set-cookie",
	"transfer-encoding",
	"connection",
	"upgrade",
	"x-api-key"
]);

function nonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function numberOrNull(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function booleanOrNull(value) {
	if (typeof value === "boolean") return value;
	if (value === 1 || value === "1" || value === "true") return true;
	if (value === 0 || value === "0" || value === "false") return false;
	return null;
}

function round1(value) {
	return Math.round(value * 10) / 10;
}

/** Normalize how trustworthy an account endpoint binding is. */
export function accountProvenance(spec) {
	if (PROVENANCE_KINDS.has(spec?.provenanceHint)) return spec.provenanceHint;
	const adapter = nonEmptyString(spec?.adapter);
	if (adapter === null) return "unknown";
	if (adapter === "declarative" || adapter === "general") return "configured";
	if (OFFICIAL_ADAPTERS.has(adapter)) return "official";
	if (PROVIDER_ADAPTERS.has(adapter)) return "provider";
	return "unknown";
}

/** Derive health age from the last successful sample without mutating cache state. */
export function withHealthAge(snapshot, now = Date.now()) {
	if (snapshot === null || snapshot === void 0 || typeof snapshot !== "object") return snapshot;
	const lastSuccessAt = typeof snapshot.lastSuccessAt === "number" && Number.isFinite(snapshot.lastSuccessAt)
		? snapshot.lastSuccessAt
		: null;
	return {
		...snapshot,
		ageMs: lastSuccessAt === null ? null : Math.max(0, now - lastSuccessAt)
	};
}

/** Pure central refresh policy; scheduling and I/O stay outside this function. */
export function refreshPolicy(state, now = Date.now(), overrides = {}) {
	const intervals = { ...DEFAULT_REFRESH_POLICY, ...overrides };
	const activity = state?.activity === "active" || state?.activity === "detail" ? state.activity : "background";
	const lastAttemptAt = typeof state?.lastAttemptAt === "number" && Number.isFinite(state.lastAttemptAt)
		? state.lastAttemptAt
		: null;
	const priority = activity === "active" ? 3 : activity === "detail" ? 2 : 1;
	if (lastAttemptAt === null) return { activity, priority, delayMs: 0, nextRefreshAt: now };
	let delayMs = activity === "active" ? intervals.activeMs : activity === "detail" ? intervals.detailMs : intervals.backgroundMs;
	if ((Number(state?.rateLimitFailures) || 0) > 0) {
		const failures = Math.max(1, Math.floor(Number(state.rateLimitFailures) || 1));
		delayMs = Math.min(intervals.rateLimitMaxMs, intervals.rateLimitBaseMs * 2 ** Math.min(20, failures - 1));
	}
	return { activity, priority, delayMs, nextRefreshAt: lastAttemptAt + delayMs };
}

function toIso(value) {
	if (value === null || value === void 0 || value === "") return null;
	if (typeof value === "number" && Number.isFinite(value)) {
		const date = new Date(value < 20000000000 ? value * 1000 : value);
		return Number.isNaN(date.getTime()) ? null : date.toISOString();
	}
	const date = new Date(String(value));
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function statusError(status, message, httpStatus, safeReason) {
	const error = new Error(message);
	error.providerStatus = status;
	if (httpStatus !== void 0) error.httpStatus = httpStatus;
	if (safeReason !== void 0) error.safeReason = safeReason;
	return error;
}

function statusOf(error) {
	if (ACCOUNT_STATUSES.has(error?.providerStatus)) return error.providerStatus;
	if (error?.name === "TimeoutError" || error?.name === "AbortError") return "unavailable";
	return "unavailable";
}

function safeReasonOf(error) {
	const reason = nonEmptyString(error?.safeReason);
	if (reason !== null && SAFE_REASON_CODES.has(reason)) return reason;
	const status = statusOf(error);
	if (error?.name === "TimeoutError" || error?.name === "AbortError") return "timeout";
	if (status === "rate-limited") return "rate-limited";
	if (status === "unauthorized") return "unauthorized";
	if (status === "blocked") return "blocked-network";
	if (status === "invalid-response") return "upstream-invalid-response";
	return status === "unavailable" ? "unknown" : null;
}

function providerReasonOf(reason, status) {
	const value = nonEmptyString(reason);
	if (value !== null && SAFE_REASON_CODES.has(value)) return value;
	if (status === "rate-limited") return "rate-limited";
	if (status === "unauthorized") return "unauthorized";
	if (status === "blocked") return "blocked-network";
	if (status === "invalid-response") return "upstream-invalid-response";
	if (status === "unavailable") return "unknown";
	return null;
}

/** Attach service-internal query facts without expanding the wire protocol. */
function annotateQuerySnapshot(snapshot, { attempted, succeeded }) {
	Object.defineProperties(snapshot, {
		[HEALTH_ATTEMPTED]: { value: attempted === true },
		[HEALTH_SUCCEEDED]: { value: succeeded === true }
	});
	return snapshot;
}

async function resolveCredential(credentials, ref) {
	if (nonEmptyString(ref) === null || credentials === null || credentials === void 0 || typeof credentials.resolve !== "function") return "";
	try {
		const hit = await credentials.resolve(ref);
		return nonEmptyString(hit?.value) ?? "";
	} catch {
		return "";
	}
}

function responseStatus(status) {
	if (status === 401 || status === 403) return "unauthorized";
	if (status === 429) return "rate-limited";
	if (status === 404 || status === 405) return "unsupported";
	return status >= 500 ? "unavailable" : "invalid-response";
}

async function parseJsonResponse(response, maxBytes = MAX_RESPONSE_BYTES) {
	const declared = numberOrNull(response.headers?.get?.("content-length"));
	if (declared !== null && declared > maxBytes) throw statusError("invalid-response", "upstream response exceeds the size limit", void 0, "upstream-too-large");
	const contentType = response.headers?.get?.("content-type");
	if (typeof contentType === "string" && contentType !== "" && !/\bjson\b/i.test(contentType)) {
		throw statusError("invalid-response", "upstream did not return JSON", void 0, "upstream-not-json");
	}
	if (typeof response.arrayBuffer === "function") {
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > maxBytes) throw statusError("invalid-response", "upstream response exceeds the size limit", void 0, "upstream-too-large");
		try {
			return JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			throw statusError("invalid-response", "upstream returned invalid JSON", void 0, "upstream-invalid-json");
		}
	}
	try {
		return await response.json();
	} catch {
		throw statusError("invalid-response", "upstream returned invalid JSON", void 0, "upstream-invalid-json");
	}
}

async function requestJson(url, init, deps = {}) {
	const response = await (deps.fetch ?? fetch)(url, {
		...init,
		redirect: "manual",
		signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
	});
	if (!response.ok) throw statusError(responseStatus(response.status), `upstream returned HTTP ${response.status}`, response.status);
	return parseJsonResponse(response, deps.maxResponseBytes ?? MAX_RESPONSE_BYTES);
}

function schemeOfAdapter(adapter) {
	return adapter.endsWith("-balance") ? adapter.slice(0, -8) : null;
}

function adapterMode(adapter, monitor) {
	if (adapter === "declarative") return monitor.mode;
	if (["opencode-go", "zai-token-plan", "kimi-token-plan", "minimax-token-plan", "ollama"].includes(adapter)) return "subscription";
	return "balance";
}

function assertRelativePath(path, label) {
	if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
		throw new Error(`${label} must be an absolute-path relative path beginning with /`);
	}
	try {
		const parsed = new URL(path, "https://usage.invalid");
		if (parsed.origin !== "https://usage.invalid") throw new Error("origin changed");
	} catch {
		throw new Error(`${label} must be a relative path, not a URL`);
	}
}

function validatePointer(pointer, label) {
	if (pointer === void 0 || pointer === null) return;
	const value = typeof pointer === "object" && pointer !== null ? pointer.pointer : pointer;
	if (typeof value !== "string" || value !== "" && !value.startsWith("/")) throw new Error(`${label} must be a JSON Pointer`);
}

function validateWarning(value, label) {
	if (value === void 0) return;
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	for (const field of ["warnBelow", "criticalBelow"]) {
		if (value[field] !== void 0 && numberOrNull(value[field]) === null) throw new Error(`${label}.${field} must be numeric`);
	}
	const warn = numberOrNull(value.warnBelow);
	const critical = numberOrNull(value.criticalBelow);
	if (warn !== null && critical !== null && critical > warn) throw new Error(`${label}.criticalBelow must not exceed warnBelow`);
}

function validateDeclarative(monitor, label) {
	if (monitor.mode !== "balance" && monitor.mode !== "subscription") throw new Error(`${label}.mode must be balance or subscription`);
	if (monitor.request === null || typeof monitor.request !== "object" || Array.isArray(monitor.request)) throw new Error(`${label}.request must be an object`);
	assertRelativePath(monitor.request.path, `${label}.request.path`);
	if (monitor.request.method !== void 0 && monitor.request.method !== "GET") throw new Error(`${label}.request.method must be GET`);
	const authType = monitor.request.auth?.type;
	if (authType !== void 0 && !["bearer", "raw", "x-api-key"].includes(authType)) throw new Error(`${label}.request.auth.type is unsupported`);
	for (const name of Object.keys(monitor.request.headers ?? {})) {
		if (SENSITIVE_HEADERS.has(name.toLowerCase())) throw new Error(`${label}.request.headers cannot override ${name}`);
	}
	if (monitor.extract === null || typeof monitor.extract !== "object" || Array.isArray(monitor.extract)) throw new Error(`${label}.extract must be an object`);
	for (const field of ["root", "valid", "invalidMessage", "plan", "remaining", "used", "total", "currency", "unlimited", "expiresAt", "items", "kind", "usedPercent", "remainingPercent", "resetsAt"]) {
		validatePointer(monitor.extract[field], `${label}.extract.${field}`);
	}
	if (monitor.mode === "balance" && monitor.extract.remaining === void 0 && monitor.extract.total === void 0) throw new Error(`${label}.extract requires remaining or total`);
	if (monitor.mode === "subscription" && monitor.extract.items === void 0) throw new Error(`${label}.extract.items is required`);
	if (monitor.extract.divisor !== void 0 && (numberOrNull(monitor.extract.divisor) === null || Number(monitor.extract.divisor) === 0)) throw new Error(`${label}.extract.divisor must be a non-zero number`);
}

/** Validate and freeze the non-secret account-monitor configuration shape. */
export function validateAccountConfig(raw = {}) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("account config must be an object");
	const monitors = raw.monitors ?? {};
	if (monitors === null || typeof monitors !== "object" || Array.isArray(monitors)) throw new Error("monitors must be an object keyed by provider id");
	const normalized = {};
	for (const [key, value] of Object.entries(monitors)) {
		const label = `monitors.${key}`;
		if (nonEmptyString(key) === null || value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
		const providerId = nonEmptyString(value.providerId) ?? key;
		const adapter = nonEmptyString(value.adapter);
		if (adapter === null || !ADAPTERS.has(adapter)) throw new Error(`${label}.adapter is unsupported`);
		if (value.usageBaseURL !== void 0) {
			let url;
			try { url = new URL(value.usageBaseURL); } catch { throw new Error(`${label}.usageBaseURL must be a valid URL`); }
			if (url.username !== "" || url.password !== "") throw new Error(`${label}.usageBaseURL must not contain credentials`);
			if (url.protocol !== "https:" && value.allowInsecure !== true) throw new Error(`${label}.usageBaseURL must use HTTPS unless allowInsecure is true`);
		}
		validateWarning(value.warning, `${label}.warning`);
		if (adapter === "declarative") validateDeclarative(value, label);
		normalized[providerId] = { ...value, providerId, adapter };
	}
	return { monitors: normalized };
}

/** Bind one configured Harness provider to its explicit or built-in adapter. */
export function resolveAccountSpec(provider, config = { monitors: {} }) {
	const monitor = config.monitors?.[provider.id] ?? {};
	const adapter = resolveProviderIdentity(provider, config).accountAdapter;
	const mode = adapter === null ? null : adapterMode(adapter, monitor);
	const apiKeyRef = monitor.credentialRef
		?? (adapter === "openrouter-balance" ? OPENROUTER_MANAGEMENT_REF : provider.apiKeyEnv);
	return {
		id: provider.id,
		displayName: provider.displayName ?? provider.id,
		adapter,
		mode,
		// The apiKeyRef doubles as the "configured" indicator in provider views.
		// sub2api-auth reuses the provider's own inference apiKeyEnv (CC Switch
		// style), so the default apiKeyRef already points at it.
		apiKeyRef,
		baseURL: monitor.usageBaseURL ?? provider.baseURL,
		providerBaseURL: provider.baseURL,
		monitor,
		configKey: JSON.stringify({ adapter, mode, provider, monitor })
	};
}

function decodePointerToken(token) {
	return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** RFC 6901 JSON Pointer lookup; missing paths return undefined. */
export function jsonPointer(value, pointer) {
	if (pointer === "" || pointer === void 0 || pointer === null) return value;
	if (typeof pointer !== "string" || !pointer.startsWith("/")) return void 0;
	let current = value;
	for (const raw of pointer.slice(1).split("/")) {
		const key = decodePointerToken(raw);
		if (current === null || current === void 0 || typeof current !== "object" || !Object.hasOwn(current, key)) return void 0;
		current = current[key];
	}
	return current;
}

function mapped(root, mapping) {
	if (mapping === void 0 || mapping === null) return void 0;
	if (typeof mapping === "string") return jsonPointer(root, mapping);
	if (typeof mapping === "object" && typeof mapping.pointer === "string") {
		const value = jsonPointer(root, mapping.pointer);
		const divisor = numberOrNull(mapping.divisor);
		return divisor === null ? value : numberOrNull(value) === null ? void 0 : Number(value) / divisor;
	}
	return void 0;
}

/**
 * RFC 2544 benchmarking range commonly used by proxy fake-IP DNS.
 *
 * This range remains non-public for normal policy decisions. It is only
 * accepted later as a proxy-synthetic DNS answer for HTTPS hostnames.
 */
function isBenchmarkFakeIpAddress(address) {
	const value = String(address ?? "").trim().replace(/^\[|\]$/g, "");
	if (isIP(value) !== 4) return false;
	const [a, b] = value.split(".").map(Number);
	return a === 198 && (b === 18 || b === 19);
}

/**
 * A benchmarking-range address may represent a proxy/TUN synthetic mapping
 * only when it came from resolving an HTTPS hostname.
 *
 * Literal https://198.18.x.x targets never enter this exception because the
 * original URL hostname is itself an IP literal.
 */
function isHttpsProxySyntheticAddress(url, address) {
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	return url.protocol === "https:"
		&& isIP(hostname) === 0
		&& isBenchmarkFakeIpAddress(address);
}

/**
 * Pick the connection address from validated DNS answers.
 *
 * Order of preference when private-network access is not explicitly enabled:
 *   1. a genuinely public answer;
 *   2. an IPv4 benchmarking-range (198.18.0.0/15) answer, only for an HTTPS
 *      hostname resolved through DNS (a Clash/Mihomo-style fake-IP mapping);
 *   3. otherwise no usable address (reject).
 *
 * With allowPrivateNetwork the first answer is returned unchanged. This is a
 * pure helper exported for offline policy tests; it performs no I/O.
 */
export function selectResolvedAddresses(url, rawAddresses, allowPrivateNetwork = false) {
	const addresses = (
		Array.isArray(rawAddresses)
			? rawAddresses
			: [rawAddresses]
	).filter(
		(entry) =>
			typeof entry?.address === "string"
			&& isIP(entry.address) !== 0
	).map((entry) => ({
		address: entry.address,
		family: entry.family ?? isIP(entry.address)
	}));

	if (addresses.length === 0) return [];
	if (allowPrivateNetwork) return addresses;

	const publicAddresses = addresses.filter(
		(entry) => !isPrivateAddress(entry.address)
	);
	if (publicAddresses.length > 0) return publicAddresses;

	return addresses.filter(
		(entry) => isHttpsProxySyntheticAddress(url, entry.address)
	);
}

/** Backward-compatible single-address policy helper used by existing tests/callers. */
export function selectResolvedAddress(url, rawAddresses, allowPrivateNetwork = false) {
	return selectResolvedAddresses(url, rawAddresses, allowPrivateNetwork)[0] ?? null;
}

async function resolvePublicAddresses(url, spec, deps) {
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	if (isPrivateHostname(hostname) && spec.monitor.allowPrivateNetwork !== true) throw statusError("blocked", "account monitor private-network access requires allowPrivateNetwork");
	if (isIP(hostname) !== 0) return [{ address: hostname, family: isIP(hostname) }];
	let addresses;
	try {
		addresses = await (deps.lookup ?? dnsLookup)(hostname, { all: true, verbatim: true });
	} catch {
		throw statusError("unavailable", "account monitor hostname could not be resolved", void 0, "dns-resolution-failed");
	}
	if (!Array.isArray(addresses)) addresses = [addresses];
	if (addresses.length === 0) throw statusError("unavailable", "account monitor hostname resolved to no addresses", void 0, "dns-resolution-failed");
	const selected = selectResolvedAddresses(
		url,
		addresses,
		spec.monitor.allowPrivateNetwork === true
	);
	if (selected.length === 0) {
		throw statusError("blocked", "account monitor hostname resolves only to blocked network addresses");
	}
	return selected;
}

function crossOriginSensitive(spec) {
	return spec.monitor.usageBaseURL !== void 0
		|| spec.adapter === "general"
		|| spec.adapter === "new-api"
		|| spec.adapter === "sub2api-auth"
		|| spec.adapter === "declarative"
		|| schemeOfAdapter(spec.adapter ?? "") !== null;
}

async function assertTargetPolicy(rawUrl, spec, deps) {
	const url = new URL(rawUrl);
	if (url.username !== "" || url.password !== "") throw statusError("unsupported", "account monitor URL must not contain credentials");
	if (url.protocol !== "https:" && spec.monitor.allowInsecure !== true) throw statusError("blocked", "account monitor requires HTTPS");
	if (url.protocol !== "https:" && url.protocol !== "http:") throw statusError("unsupported", "account monitor protocol is unsupported");
	if (crossOriginSensitive(spec) && nonEmptyString(spec.providerBaseURL) !== null) {
		const providerOrigin = new URL(spec.providerBaseURL).origin;
		if (url.origin !== providerOrigin && spec.monitor.allowCrossOrigin !== true) throw statusError("blocked", "account monitor cross-origin access requires allowCrossOrigin");
	}
	const addresses = await resolvePublicAddresses(url, spec, deps);
	return { url, addresses };
}

function responseHeaders(headers) {
	return { get: (name) => {
		const value = headers[String(name).toLowerCase()];
		return Array.isArray(value) ? value.join(", ") : value === void 0 ? null : String(value);
	} };
}

const RETRYABLE_CONNECTION_CODES = new Set([
	"ENETUNREACH",
	"EHOSTUNREACH",
	"EADDRNOTAVAIL",
	"ETIMEDOUT",
	"ECONNREFUSED",
	"ECONNRESET"
]);

function retryableConnectionError(error) {
	return RETRYABLE_CONNECTION_CODES.has(error?.code);
}

function pinnedRequest(url, address, init, deps, signal) {
	return new Promise((resolve, reject) => {
		const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
		const request = transport(url, {
			method: init?.method ?? "GET",
			headers: init?.headers,
			signal,
			// Node 20+ enables network-family autoselection by default. Each outer
			// attempt is already pinned to one policy-approved address, so disable
			// the inner lookupAndConnectMultiple path and fix the intended family.
			family: address.family,
			autoSelectFamily: false,
			servername: isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0 ? url.hostname : void 0,
			lookup: (_hostname, options, callback) => {
				if (options?.all) callback(null, [address]);
				else callback(null, address.address, address.family);
			}
		}, (response) => {
			const chunks = [];
			let size = 0;
			response.on("data", (chunk) => {
				size += chunk.length;
				if (size > (deps.maxResponseBytes ?? MAX_RESPONSE_BYTES)) request.destroy(statusError("invalid-response", "upstream response exceeds the size limit", void 0, "upstream-too-large"));
				else chunks.push(chunk);
			});
			response.on("end", () => {
				const body = Buffer.concat(chunks);
				resolve({
					ok: response.statusCode >= 200 && response.statusCode < 300,
					status: response.statusCode,
					headers: responseHeaders(response.headers),
					arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
					json: async () => JSON.parse(body.toString("utf8")),
					text: async () => body.toString("utf8")
				});
			});
		});
		request.on("error", reject);
		// Backstop: in the pinned-lookup path a connect-phase failure can surface
		// directly on the socket before the request's own error forwarding has
		// attached (#42 — an unhandled TLSSocket 'error' killed the whole dsh web
		// process). Forward any socket-level error to the request so a transient
		// network failure rejects this attempt instead of crashing the host.
		request.on("socket", (socket) => {
			socket.on("error", (error) => request.emit("error", error));
		});
		request.end();
	});
}

/** HTTPS/HTTP transport that pins every attempted connection to an address already approved by the policy layer. */
async function pinnedFetch(rawUrl, init, spec, deps) {
	const target = await assertTargetPolicy(rawUrl, spec, deps);
	const signal = init?.signal ?? AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const requestOne = deps.requestPinned ?? ((url, address, requestInit) => pinnedRequest(url, address, requestInit, deps, signal));
	let lastRetryable = null;
	for (const address of target.addresses) {
		try {
			return await requestOne(target.url, address, init, signal);
		} catch (error) {
			if (!retryableConnectionError(error)) throw error;
			lastRetryable = error;
		}
	}
	if (lastRetryable !== null) {
		throw statusError("unavailable", "account monitor could not connect to any validated address", void 0, "all-addresses-unreachable");
	}
	throw statusError("unavailable", "account monitor has no validated connection address", void 0, "no-validated-address");
}

function customURL(spec) {
	const base = new URL(spec.baseURL);
	const providerBase = nonEmptyString(spec.providerBaseURL) === null ? null : new URL(spec.providerBaseURL);
	if (base.protocol !== "https:" && spec.monitor.allowInsecure !== true) throw statusError("blocked", "custom monitor requires HTTPS");
	if (isPrivateHostname(base.hostname) && spec.monitor.allowPrivateNetwork !== true) throw statusError("blocked", "custom monitor private-network access requires allowPrivateNetwork");
	if (providerBase !== null && base.origin !== providerBase.origin && spec.monitor.allowCrossOrigin !== true) throw statusError("blocked", "custom monitor cross-origin access requires allowCrossOrigin");
	const url = new URL(spec.monitor.request.path, base);
	if (url.origin !== base.origin) throw statusError("unsupported", "custom monitor request must stay on its configured origin");
	return url.href;
}

function customHeaders(spec, credential) {
	const headers = { accept: "application/json" };
	for (const [name, value] of Object.entries(spec.monitor.request.headers ?? {})) {
		if (!SENSITIVE_HEADERS.has(name.toLowerCase()) && typeof value === "string") headers[name] = value;
	}
	const type = spec.monitor.request.auth?.type;
	if (credential !== "") {
		if (type === "bearer") headers.authorization = `Bearer ${credential}`;
		if (type === "raw") headers.authorization = credential;
		if (type === "x-api-key") headers["x-api-key"] = credential;
	}
	return headers;
}

function balanceAlert(balance, warning) {
	const remaining = numberOrNull(balance?.remaining);
	const warnBelow = numberOrNull(warning?.warnBelow);
	const criticalBelow = numberOrNull(warning?.criticalBelow);
	if (remaining !== null && (warnBelow !== null || criticalBelow !== null)) {
		if (criticalBelow !== null && remaining <= criticalBelow) return { level: "critical", metric: "balance", value: remaining, threshold: criticalBelow };
		if (warnBelow !== null && remaining <= warnBelow) return { level: "warning", metric: "balance", value: remaining, threshold: warnBelow };
		return { level: "normal", metric: "balance", value: remaining };
	}
	const total = numberOrNull(balance?.total);
	if (remaining !== null && total !== null && total > 0) {
		const value = round1(Math.max(0, Math.min(100, remaining / total * 100)));
		return { level: value <= 10 ? "critical" : value <= 30 ? "warning" : "normal", metric: "remaining-percent", value };
	}
	return { level: "unknown", metric: "balance", value: remaining };
}

function subscriptionAlert(windows) {
	const remaining = windows.map((entry) => numberOrNull(entry.remainingPercent)).filter((value) => value !== null);
	if (remaining.length === 0) return { level: "unknown", metric: "remaining-percent", value: null };
	const value = round1(Math.min(...remaining));
	return { level: value <= 10 ? "critical" : value <= 30 ? "warning" : "normal", metric: "remaining-percent", value };
}

function baseSnapshot(spec, status, now) {
	return {
		id: spec.id,
		displayName: spec.displayName,
		mode: spec.mode ?? "balance",
		adapter: spec.adapter,
		provenance: accountProvenance(spec),
		status,
		fetchedAt: now
	};
}

function unavailableSnapshot(spec, status, now, extra = {}) {
	const base = baseSnapshot(spec, status, now);
	if (base.mode === "subscription") return { ...base, windows: [], alert: subscriptionAlert([]), ...extra };
	return { ...base, balance: null, alert: { level: "unknown", metric: "balance", value: null }, ...extra };
}

async function queryBuiltInBalance(spec, credential, deps, now) {
	const scheme = schemeOfAdapter(spec.adapter);
	const raw = await queryBalance(scheme, spec.baseURL, credential, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, deps.fetch ?? fetch);
	const remaining = numberOrNull(raw.total);
	if (remaining === null) throw statusError("invalid-response", "balance response is missing a numeric amount");
	const used = numberOrNull(raw.used);
	const total = numberOrNull(raw.limit);
	const balance = {
		remaining,
		...(used === null ? {} : { used }),
		...(total === null ? {} : { total }),
		currency: nonEmptyString(raw.currency) ?? "USD",
		unlimited: false,
		expiresAt: null,
		available: raw.isAvailable !== false,
		breakdown: {
			granted: numberOrNull(raw.granted),
			toppedUp: numberOrNull(raw.toppedUp)
		}
	};
	// DeepSeek's explicit `is_available` flag is an upstream account state.
	// Other schemes infer this field from a numeric zero balance, which remains a
	// valid successful response and should still render the critical balance.
	const status = scheme === "deepseek" && raw.isAvailable === false ? "unavailable" : "ok";
	return { ...baseSnapshot(spec, status, now), balance, alert: balanceAlert(balance, spec.monitor.warning) };
}

async function queryGeneral(spec, credential, deps, now) {
	const body = await requestJson(new URL("/user/balance", spec.baseURL).href, {
		headers: { authorization: `Bearer ${credential}`, accept: "application/json" }
	}, deps);
	const remaining = numberOrNull(body?.balance);
	if (remaining === null) throw statusError("invalid-response", "general balance response is missing balance");
	const balance = { remaining, currency: nonEmptyString(body?.currency) ?? "USD", unlimited: false, expiresAt: null };
	return { ...baseSnapshot(spec, "ok", now), balance, alert: balanceAlert(balance, spec.monitor.warning) };
}

async function quotaPerUnit(spec, deps) {
	try {
		const body = await requestJson(new URL("/api/status", spec.baseURL).href, { headers: { accept: "application/json" } }, deps);
		const value = numberOrNull(body?.data?.quota_per_unit);
		if (value !== null && value > 0) return { value, fallback: false };
		// Old status schemas did not expose quota_per_unit.
		return { value: 500000, fallback: true };
	} catch (error) {
		if (error?.httpStatus === 404 || error?.httpStatus === 405) return { value: 500000, fallback: true };
		throw error;
	}
}

async function queryNewApiFallback(spec, credentials, deps, now) {
	const ref = spec.monitor.fallbackCredentialRef;
	const token = await resolveCredential(credentials, ref);
	if (token === "") return unavailableSnapshot(spec, "unsupported", now, { missingCredentials: ref === void 0 ? [] : [ref] });
	const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
	const userId = await resolveCredential(credentials, spec.monitor.fallbackUserIdRef);
	if (userId !== "") headers["new-api-user"] = userId;
	const [body, quotaUnit] = await Promise.all([
		requestJson(new URL("/api/user/self", spec.baseURL).href, { headers }, deps),
		quotaPerUnit(spec, deps)
	]);
	const unit = quotaUnit.value;
	if (body?.success === false || body?.data === null || typeof body?.data !== "object") throw statusError("invalid-response", "New API user response is invalid");
	const remainingQuota = numberOrNull(body.data.quota);
	const usedQuota = numberOrNull(body.data.used_quota);
	if (remainingQuota === null) throw statusError("invalid-response", "New API user response is missing quota");
	const balance = {
		remaining: remainingQuota / unit,
		...(usedQuota === null ? {} : { used: usedQuota / unit, total: (remainingQuota + usedQuota) / unit }),
		currency: "USD",
		unlimited: false,
		expiresAt: null
	};
	return {
		...baseSnapshot(spec, "ok", now),
		plan: nonEmptyString(body.data.group) ?? void 0,
		balance,
		alert: balanceAlert(balance, spec.monitor.warning),
		source: "management-fallback",
		quotaUnit: unit,
		quotaUnitFallback: quotaUnit.fallback
	};
}

async function queryNewApi(spec, credentials, credential, deps, now) {
	let body;
	try {
		body = await requestJson(new URL("/api/usage/token/", spec.baseURL).href, {
			headers: { authorization: `Bearer ${credential}`, accept: "application/json" }
		}, deps);
	} catch (error) {
		if (error?.httpStatus === 404 || error?.httpStatus === 405) return queryNewApiFallback(spec, credentials, deps, now);
		throw error;
	}
	if (body?.code !== true || body?.data === null || typeof body?.data !== "object") throw statusError("invalid-response", "New API token response is invalid");
	const granted = numberOrNull(body.data.total_granted);
	const used = numberOrNull(body.data.total_used);
	const available = numberOrNull(body.data.total_available);
	const quotaUnit = await quotaPerUnit(spec, deps);
	const unit = quotaUnit.value;
	const unlimited = booleanOrNull(body.data.unlimited_quota) === true;
	if (!unlimited && available === null) throw statusError("invalid-response", "New API token response is missing total_available");
	const balance = {
		remaining: available === null ? null : available / unit,
		...(used === null ? {} : { used: used / unit }),
		...(granted === null ? {} : { total: granted / unit }),
		currency: "USD",
		unlimited,
		expiresAt: numberOrNull(body.data.expires_at) > 0 ? toIso(body.data.expires_at) : null
	};
	return {
		...baseSnapshot(spec, "ok", now),
		plan: nonEmptyString(body.data.name) ?? void 0,
		balance,
		alert: unlimited ? { level: "normal", metric: "remaining-percent", value: 100 } : balanceAlert(balance, spec.monitor.warning),
		source: "token",
		quotaUnit: unit,
		quotaUnitFallback: quotaUnit.fallback
	};
}

function amountWindow(kind, usedValue, limitValue, remainingValue, resetsAt) {
	const limit = numberOrNull(limitValue);
	if (limit === null || limit <= 0) return null;
	const remaining = numberOrNull(remainingValue);
	const used = numberOrNull(usedValue) ?? (remaining === null ? null : limit - remaining);
	if (used === null) return null;
	const usedPercent = round1(Math.max(0, Math.min(100, used / limit * 100)));
	const reset = toIso(resetsAt);
	return {
		kind,
		usedPercent,
		remainingPercent: round1(100 - usedPercent),
		...(reset === null ? {} : { resetsAt: reset })
	};
}

function sub2ApiWindowKind(value) {
	const kind = nonEmptyString(value) ?? "quota";
	if (kind === "5h") return "session";
	if (kind === "1d") return "daily";
	if (kind === "7d") return "weekly";
	return kind;
}

function sub2ApiSubscription(spec, body, now) {
	const windows = [];
	if (body.mode === "quota_limited") {
		const quota = body.quota;
		if (quota === null || typeof quota !== "object" || Array.isArray(quota)) {
			throw statusError("invalid-response", "Sub2API quota response is missing quota");
		}
		const total = amountWindow("quota", quota.used, quota.limit, quota.remaining, body.expires_at);
		if (total !== null) windows.push(total);
		for (const entry of Array.isArray(body.rate_limits) ? body.rate_limits : []) {
			if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
			const window = amountWindow(sub2ApiWindowKind(entry.window), entry.used, entry.limit, entry.remaining, entry.reset_at);
			if (window !== null) windows.push(window);
		}
	} else {
		const subscription = body.subscription;
		if (subscription === null || typeof subscription !== "object" || Array.isArray(subscription)) {
			throw statusError("invalid-response", "Sub2API subscription response is missing subscription limits");
		}
		for (const period of ["daily", "weekly", "monthly"]) {
			const window = amountWindow(
				period,
				subscription[`${period}_usage_usd`],
				subscription[`${period}_limit_usd`],
				null,
				null
			);
			if (window !== null) windows.push(window);
		}
	}
	if (windows.length === 0) throw statusError("invalid-response", "Sub2API response has no usable quota windows");
	return {
		...baseSnapshot(spec, "ok", now),
		mode: "subscription",
		plan: nonEmptyString(body.planName) ?? nonEmptyString(body.plan_name) ?? "Sub2API",
		windows,
		alert: subscriptionAlert(windows)
	};
}

/** Parse a Sub2API /v1/usage body into a normalized account snapshot (balance or subscription windows). */
function parseSub2ApiUsage(spec, body, now) {
	if (body === null || typeof body !== "object" || Array.isArray(body)) throw statusError("invalid-response", "Sub2API response must be an object");
	if (body.isValid === false || body.is_active === false) throw statusError("unauthorized", "Sub2API key is invalid");
	const hasSubscription = body.subscription !== null && typeof body.subscription === "object" && !Array.isArray(body.subscription);
	if (body.mode === "quota_limited" || hasSubscription) return sub2ApiSubscription(spec, body, now);
	const remaining = numberOrNull(body.balance ?? body.remaining);
	if (remaining === null) throw statusError("invalid-response", "Sub2API response is missing a numeric balance");
	const balance = {
		remaining,
		currency: nonEmptyString(body.unit) ?? "USD",
		unlimited: false,
		expiresAt: toIso(body.expires_at)
	};
	return {
		...baseSnapshot(spec, "ok", now),
		mode: "balance",
		plan: nonEmptyString(body.planName) ?? nonEmptyString(body.plan_name) ?? void 0,
		balance,
		alert: balanceAlert(balance, spec.monitor.warning)
	};
}

async function querySub2Api(spec, credential, deps, now) {
	const body = await requestJson(new URL("/v1/usage", spec.baseURL).href, {
		headers: { authorization: `Bearer ${credential}`, accept: "application/json" }
	}, deps);
	return parseSub2ApiUsage(spec, body, now);
}

/**
 * Parse the Sub2API dashboard `{ code, message, data }` envelope.
 *
 * Sub2API reports business failures with HTTP 200 and a non-zero `code`, and
 * envelopes can be missing entirely on some endpoints, so callers decide how
 * strictly to validate the `data` payload. `code === 0` means success.
 */
function sub2apiEnvelope(body) {
	if (body === null || typeof body !== "object" || Array.isArray(body)) throw statusError("invalid-response", "Sub2API response must be an object");
	const code = body.code;
	const message = typeof body.message === "string" ? body.message : "";
	if (code !== 0) {
		const err = statusError("invalid-response", message !== "" ? `Sub2API: ${message}` : "Sub2API returned a business error");
		if (/invalid|unauthor|password|credential|login|expired|refresh/i.test(message)) err.providerStatus = "unauthorized";
		throw err;
	}
	return body;
}

/**
 * Detection cache for auto-detected Sub2API panels, keyed by the provider's
 * config key so we only probe once per (provider × config) even across the
 * five-minute background refreshes.
 */
function sub2apiDetection(deps) {
	if (deps.sub2apiDetection === void 0 || deps.sub2apiDetection === null) deps.sub2apiDetection = new Map();
	return deps.sub2apiDetection;
}

/**
 * Probe whether a relay endpoint is a real Sub2API panel.
 *
 * Real Sub2API panels expose the public `GET /api/v1/settings/public` route
 * (envelope `{ code: 0, data: { affiliate_enabled: boolean } }`) which neither
 * One/New-API nor passion-style gateways provide, so this is a cheap, read-only,
 * capability fingerprint for auto-detection. Results are cached per config key.
 */
async function probeSub2ApiPanel(spec, deps) {
	const cache = sub2apiDetection(deps);
	const key = spec.configKey;
	if (cache.has(key)) return cache.get(key);
	let detected = false;
	try {
		const body = await requestJson(new URL(SUB2API_PUBLIC_SETTINGS_PATH, spec.baseURL).href, {
			headers: { accept: "application/json" }
		}, deps);
		const envelope = sub2apiEnvelope(body);
		const settings = envelope?.data;
		detected = settings !== null && typeof settings === "object" && !Array.isArray(settings)
			&& typeof settings.affiliate_enabled === "boolean";
	} catch {
		detected = false;
	}
	cache.set(key, detected);
	return detected;
}

/**
 * Build a sub2api-auth spec from an auto-detected panel's provider. It reuses
 * the provider's own inference apiKeyEnv (already configured in the model) —
 * the same credential model as CC Switch's General usage template — so no
 * separate panel credential is needed. The apiKeyRef stays the provider's.
 */
function sub2apiAuthSpec(spec) {
	return {
		...spec,
		adapter: "sub2api-auth",
		mode: "balance",
		provenanceHint: "experimental"
	};
}

/**
 * Query a Sub2API panel's balance with the provider's own inference API key.
 *
 * No separate dashboard credential is required — the model-configured apiKeyEnv
 * is reused. Two key-accessible endpoints are tried in order:
 *   1. `GET {baseUrl}/user/balance` (CC Switch General shape, reads
 *      `response.balance`); some panels expose this and some do not.
 *   2. `GET {baseUrl}/v1/usage` (the legacy Sub2API/passion shape parsed by
 *      `parseSub2ApiUsage`), which real panels commonly expose.
 * Panels whose SPA serves HTML for unknown routes (returning non-JSON for
 * `/user/balance`) fall through to `/v1/usage` instead of failing.
 */
async function querySub2ApiAuth(spec, credentials, deps, now) {
	const credential = await resolveCredential(credentials, spec.apiKeyRef);
	if (credential === "") return unavailableSnapshot(spec, "not-configured", now, { missingCredentials: [spec.apiKeyRef === void 0 ? "<apiKey>" : spec.apiKeyRef] });

	// Try the CC Switch General /user/balance first; only "the route does not
	// exist or is not JSON here" failures fall through to /v1/usage. Security
	// policy, TLS, connection, rate-limit and auth failures are real errors and
	// must not be silently swallowed — a masked security failure would make the
	// panel look fine while the fallback endpoint hides the problem.
	let balanceBody = null;
	try {
		balanceBody = await requestJson(new URL(SUB2API_BALANCE_PATH, spec.baseURL).href, {
			headers: { authorization: `Bearer ${credential}`, accept: "application/json" }
		}, deps);
	} catch (error) {
		const fallbackable = error?.providerStatus === "unsupported"
			|| error?.providerStatus === "invalid-response";
		if (!fallbackable) throw error;
		balanceBody = null;
	}
	const remaining = balanceBody === null ? null : (numberOrNull(balanceBody?.balance)
		?? numberOrNull(balanceBody?.data?.balance)
		?? numberOrNull(balanceBody?.remaining)
		?? numberOrNull(balanceBody?.data?.remaining));
	if (remaining !== null) {
		// Today's actual cost is optional; when unavailable the account still shows balance.
		let used = null;
		try {
			const usage = await requestJson(new URL(SUB2API_USAGE_STATS_PATH, spec.baseURL).href, {
				headers: { authorization: `Bearer ${credential}`, accept: "application/json" }
			}, deps);
			const cost = numberOrNull(usage?.data?.total_actual_cost);
			if (cost !== null) used = cost;
		} catch {
			// Usage is supplementary; a failure here must not hide the balance.
		}
		const balance = {
			remaining,
			...(used === null ? {} : { used }),
			currency: nonEmptyString(balanceBody?.unit) ?? "USD",
			unlimited: false,
			expiresAt: null
		};
		return {
			...baseSnapshot(spec, "ok", now),
			...(nonEmptyString(balanceBody?.planName) === null ? {} : { plan: balanceBody.planName }),
			balance,
			alert: balanceAlert(balance, spec.monitor.warning)
		};
	}

	// Fall back to the panel's own /v1/usage (same model API key).
	try {
		const usageBody = await requestJson(new URL("/v1/usage", spec.baseURL).href, {
			headers: { authorization: `Bearer ${credential}`, accept: "application/json" }
		}, deps);
		return parseSub2ApiUsage(spec, usageBody, now);
	} catch (error) {
		// Fixed, bounded diagnostic: /user/balance was reachable but returned an
		// unrecognized shape. Never include upstream-controlled content (JSON
		// property names, values, messages) in safeReason — a hostile upstream
		// could otherwise echo sensitive material across the server→browser
		// boundary. safeReasonOf() accepts only the fixed vocabulary above.
		if (balanceBody !== null && typeof balanceBody === "object") {
			error.safeReason = "sub2api-balance-shape-unrecognized";
		}
		throw error;
	}
}

function customBalance(spec, body, now) {
	const extract = spec.monitor.extract;
	const root = jsonPointer(body, extract.root ?? "");
	if (root === void 0) throw statusError("invalid-response", "custom response root is missing");
	const valid = mapped(root, extract.valid);
	if (valid === false) throw statusError("invalid-response", String(mapped(root, extract.invalidMessage) ?? "custom response is marked invalid"));
	const divisor = numberOrNull(extract.divisor) ?? 1;
	const remainingRaw = numberOrNull(mapped(root, extract.remaining) ?? mapped(root, extract.total));
	if (remainingRaw === null) throw statusError("invalid-response", "custom response is missing a numeric balance");
	const usedRaw = numberOrNull(mapped(root, extract.used));
	const totalRaw = numberOrNull(mapped(root, extract.total));
	const balance = {
		remaining: remainingRaw / divisor,
		...(usedRaw === null ? {} : { used: usedRaw / divisor }),
		...(totalRaw === null ? {} : { total: totalRaw / divisor }),
		currency: nonEmptyString(mapped(root, extract.currency)) ?? nonEmptyString(extract.currencyValue) ?? "USD",
		unlimited: booleanOrNull(mapped(root, extract.unlimited)) === true,
		expiresAt: toIso(mapped(root, extract.expiresAt))
	};
	return { ...baseSnapshot(spec, "ok", now), plan: nonEmptyString(mapped(root, extract.plan)) ?? void 0, balance, alert: balanceAlert(balance, spec.monitor.warning) };
}

function customSubscription(spec, body, now) {
	const extract = spec.monitor.extract;
	const root = jsonPointer(body, extract.root ?? "");
	const items = mapped(root, extract.items);
	if (!Array.isArray(items)) throw statusError("invalid-response", "custom response items must be an array");
	const windows = [];
	for (const item of items) {
		const used = numberOrNull(mapped(item, extract.usedPercent));
		const remaining = numberOrNull(mapped(item, extract.remainingPercent));
		if (used === null && remaining === null) continue;
		const usedPercent = round1(Math.max(0, Math.min(100, used ?? 100 - remaining)));
		const remainingPercent = round1(Math.max(0, Math.min(100, remaining ?? 100 - used)));
		windows.push({
			kind: nonEmptyString(mapped(item, extract.kind)) ?? "quota",
			usedPercent,
			remainingPercent,
			...(toIso(mapped(item, extract.resetsAt)) === null ? {} : { resetsAt: toIso(mapped(item, extract.resetsAt)) })
		});
	}
	if (windows.length === 0) throw statusError("invalid-response", "custom response has no usable quota windows");
	return { ...baseSnapshot(spec, "ok", now), plan: nonEmptyString(mapped(root, extract.plan)) ?? void 0, windows, alert: subscriptionAlert(windows) };
}

async function queryDeclarative(spec, credentials, deps, now) {
	const ref = spec.monitor.request.auth?.credentialRef ?? spec.apiKeyRef;
	const credential = await resolveCredential(credentials, ref);
	if (spec.monitor.request.auth !== void 0 && credential === "") return unavailableSnapshot(spec, "not-configured", now, { missingCredentials: ref === void 0 ? [] : [ref] });
	const body = await requestJson(customURL(spec), { method: "GET", headers: customHeaders(spec, credential) }, deps);
	return spec.mode === "subscription" ? customSubscription(spec, body, now) : customBalance(spec, body, now);
}

/** Query one adapter and return a secret-free normalized account snapshot. */
export async function queryAccount(spec, credentials, deps = {}) {
	const now = (deps.now ?? Date.now)();
	if (spec === null || spec === void 0) {
		return annotateQuerySnapshot(
			unavailableSnapshot({ id: "unknown", displayName: "Unknown", adapter: null, mode: "balance" }, "unsupported", now),
			{ attempted: false, succeeded: false }
		);
	}
	let attempted = false;
	const upstreamFetch = deps.fetch === void 0
		? (url, init) => pinnedFetch(url, init, spec, deps)
		: deps.fetch;
	const safeDeps = {
		...deps,
		fetch: (url, init) => {
			attempted = true;
			return upstreamFetch(url, init);
		}
	};
	const finish = (snapshot, succeeded = snapshot.status === "ok") => annotateQuerySnapshot(snapshot, {
		attempted: attempted || succeeded,
		succeeded
	});
	try {
		// A relay provider with no built-in/explicit adapter may be a real
		// Sub2API panel. Only when it also has a model-configured API key do we
		// probe its public settings endpoint; a matching fingerprint selects the
		// sub2api-auth adapter, which reuses that same provider API key. Explicit
		// adapters always win, and unkeyed relays are never probed.
		if (spec.adapter === null || spec.mode === null) {
			const providerKey = await resolveCredential(credentials, spec.apiKeyRef);
			if (providerKey === "") return finish(unavailableSnapshot(spec, "unsupported", now), false);
			const probeable = { ...spec, adapter: null, mode: "balance" };
			if (await probeSub2ApiPanel(probeable, safeDeps)) {
				return finish(await querySub2ApiAuth(sub2apiAuthSpec(probeable), credentials, safeDeps, now));
			}
			return finish(unavailableSnapshot(spec, "unsupported", now), false);
		}
		if (spec.adapter === "declarative") return finish(await queryDeclarative(spec, credentials, safeDeps, now));
		if (spec.adapter === "sub2api-auth") return finish(await querySub2ApiAuth(spec, credentials, safeDeps, now));
		const credential = await resolveCredential(credentials, spec.apiKeyRef);
		if (spec.adapter !== "opencode-go" && credential === "") return finish(unavailableSnapshot(spec, "not-configured", now, { missingCredentials: spec.apiKeyRef === void 0 ? [] : [spec.apiKeyRef] }), false);
		if (schemeOfAdapter(spec.adapter) !== null) return finish(await queryBuiltInBalance(spec, credential, safeDeps, now), true);
		if (spec.adapter === "general") return finish(await queryGeneral(spec, credential, safeDeps, now));
		if (spec.adapter === "new-api") return finish(await queryNewApi(spec, credentials, credential, safeDeps, now));
		if (spec.adapter === "sub2api") return finish(await querySub2Api(spec, credential, safeDeps, now));
		const subscriptionId = spec.adapter === "zai-token-plan" ? "zai"
			: spec.adapter === "kimi-token-plan" ? "kimi"
				: spec.adapter === "minimax-token-plan" ? "minimax"
					: spec.adapter === "ollama" ? "ollama"
						: "opencode-go";
		const provider = await collectSubscription(subscriptionId, credentials, {
			apiKeyRef: spec.apiKeyRef,
			region: spec.monitor.region
				?? (spec.adapter === "zai-token-plan" && String(spec.baseURL ?? "").includes("bigmodel.cn") ? "bigmodel-cn" : void 0)
				?? (spec.adapter === "minimax-token-plan" && String(spec.baseURL ?? "").includes("minimaxi.com") ? "cn" : void 0),
			baseURL: spec.monitor.usageBaseURL
		}, safeDeps);
		const windows = Array.isArray(provider.windows) ? provider.windows : [];
		const reason = providerReasonOf(provider.reason, provider.status);
		return finish({ ...baseSnapshot(spec, provider.status, now), plan: provider.plan, windows, alert: subscriptionAlert(windows), ...(provider.missingCredentials === void 0 ? {} : { missingCredentials: provider.missingCredentials }), ...(reason === null ? {} : { reason }) });
	} catch (error) {
		const reason = safeReasonOf(error);
		return finish(unavailableSnapshot(spec, statusOf(error), now, reason === null ? {} : { reason }), false);
	}
}

function isTransient(status) {
	return status === "unavailable" || status === "rate-limited" || status === "invalid-response";
}

function mergeRefreshHealth(previous, current) {
	const lastSuccessAt = previous?.lastSuccessAt
		?? (previous?.status === "ok" ? previous.fetchedAt : null);
	const attempted = current[HEALTH_ATTEMPTED] === true;
	const successful = current[HEALTH_SUCCEEDED] === true || current.status === "ok";
	const attemptAt = attempted ? current.fetchedAt : previous?.lastAttemptAt ?? null;
	const currentWithHealth = {
		...current,
		lastAttemptAt: attemptAt,
		lastSuccessAt: successful ? attemptAt : lastSuccessAt,
		stale: false
	};
	delete currentWithHealth.ageMs;
	const canRetain = !successful
		&& lastSuccessAt !== null
		&& (previous?.status === "ok" || previous?.stale === true)
		&& isTransient(current.status);
	if (!canRetain) return currentWithHealth;
	const stale = {
		...previous,
		status: current.status,
		fetchedAt: attemptAt,
		lastAttemptAt: attemptAt,
		lastSuccessAt,
		provenance: current.provenance ?? previous.provenance ?? "unknown",
		stale: true
	};
	delete stale.ageMs;
	if (current.reason === void 0) delete stale.reason;
	else stale.reason = current.reason;
	return stale;
}

/**
 * In-memory account cache with per-provider single-flight, health history, and
 * adaptive due-time calculation. One server-owned scheduler coordinates it
 * with the existing local token-usage aggregation lifecycle.
 */
export function createAccountService({ credentials, getProviders, config = { monitors: {} }, deps = {} }) {
	const cache = new Map();
	const inflight = new Map();
	const refreshGenerations = new Map();
	const now = deps.now ?? Date.now;
	const policyOverrides = {
		...(deps.refreshMs === void 0 ? {} : { backgroundMs: deps.refreshMs }),
		...(deps.refreshPolicy ?? {})
	};
	const activeProviders = new Set();
	const activityTouches = new Map();
	const policyListeners = new Set();
	const activityTtlMs = deps.activityTtlMs ?? 600000;
	// Long-lived Sub2API panel-detection cache, keyed by the provider's config
	// key. It lives on the service so auto-detection probes once per
	// (provider × config) even across background refreshes; a caller
	// may still inject its own Map (e.g. tests) by passing deps.sub2apiDetection.
	const sub2apiDetection = deps.sub2apiDetection ?? new Map();
	const serviceDeps = { ...deps, sub2apiDetection };

	async function specs() {
		const providers = [...await getProviders()];
		if (deps.includeLegacyProviders !== false) {
			if (!providers.some((provider) => provider.id === "opencode-go")) providers.push({ id: "opencode-go", displayName: "OpenCode Go", apiKeyEnv: "OPENCODE_GO_API_KEY" });
			if (!providers.some((provider) => provider.id === "zai" || provider.id === "zai-coding-cn")) providers.push({ id: "zai", displayName: "Z.ai", apiKeyEnv: "ZAI_API_KEY", baseURL: "https://api.z.ai" });
		}
		const known = new Set(providers.map((provider) => provider.id));
		// Settings-backed providers can become visible after this plugin's
		// initial validation. A monitor with an explicit endpoint and credential
		// reference is self-contained, so materialize it as a provider instead of
		// failing startup on a transient provider-registry race.
		for (const [providerId, monitor] of Object.entries(config.monitors ?? {})) {
			if (known.has(providerId)) continue;
			const baseURL = nonEmptyString(monitor.usageBaseURL);
			const apiKeyEnv = nonEmptyString(monitor.credentialRef);
			if (baseURL !== null && apiKeyEnv !== null) {
				providers.push({
					id: providerId,
					displayName: nonEmptyString(monitor.displayName) ?? providerId,
					apiKeyEnv,
					baseURL
				});
				known.add(providerId);
			}
		}
		const unknown = Object.keys(config.monitors ?? {}).filter((providerId) => !known.has(providerId));
		if (unknown.length > 0) throw new Error(`account monitor references unknown provider: ${unknown.join(", ")}`);
		return providers.map((provider) => resolveAccountSpec(provider, config));
	}

	async function specById(providerId) {
		return (await specs()).find((spec) => spec.id === providerId) ?? null;
	}

	function notifyPolicyChange() {
		for (const listener of policyListeners) listener();
	}

	function subscribePolicyChanges(listener) {
		if (typeof listener !== "function") return () => {};
		policyListeners.add(listener);
		return () => policyListeners.delete(listener);
	}

	function touch(providerId, activity) {
		if (typeof providerId !== "string" || providerId === "") return;
		if (activity !== "active" && activity !== "detail") return;
		const at = now();
		const before = activityOf(providerId, at);
		const previous = activityTouches.get(providerId) ?? {};
		activityTouches.set(providerId, { ...previous, [`${activity}At`]: at });
		if (activityOf(providerId, at) !== before) notifyPolicyChange();
	}

	function setActiveProviders(providerIds) {
		const next = new Set([...(providerIds ?? [])].filter((providerId) => typeof providerId === "string" && providerId !== ""));
		const changed = next.size !== activeProviders.size || [...next].some((providerId) => !activeProviders.has(providerId));
		activeProviders.clear();
		for (const providerId of next) activeProviders.add(providerId);
		if (changed) notifyPolicyChange();
	}

	function activityOf(providerId, at) {
		const touched = activityTouches.get(providerId);
		if (activeProviders.has(providerId) || at - (touched?.activeAt ?? -Infinity) < activityTtlMs) return "active";
		if (at - (touched?.detailAt ?? -Infinity) < activityTtlMs) return "detail";
		return "background";
	}

	function policyOf(spec, at) {
		const hit = cache.get(spec.id);
		if (hit?.configKey !== spec.configKey) return refreshPolicy({ activity: activityOf(spec.id, at), status: "pending", lastAttemptAt: null }, at, policyOverrides);
		return refreshPolicy({
			activity: activityOf(spec.id, at),
			status: hit.account.status,
			rateLimitFailures: hit.rateLimitFailures ?? 0,
			// Scheduling must advance even when a local credential/config check
			// correctly produces no provider attempt (and lastAttemptAt stays null).
			lastAttemptAt: hit.lastEvaluatedAt ?? hit.account.lastAttemptAt ?? hit.account.fetchedAt ?? null
		}, at, policyOverrides);
	}

	async function refresh(spec) {
		const existing = inflight.get(spec.id);
		if (existing?.configKey === spec.configKey) return existing.promise;
		const generation = (refreshGenerations.get(spec.id) ?? 0) + 1;
		refreshGenerations.set(spec.id, generation);
		const promise = queryAccount(spec, credentials, serviceDeps).then((current) => {
			const previous = cache.get(spec.id);
			const sameConfig = previous?.configKey === spec.configKey;
			const previousAccount = sameConfig ? previous.account : null;
			const previousRateLimitFailures = sameConfig ? previous.rateLimitFailures ?? 0 : 0;
			const next = mergeRefreshHealth(previousAccount, current);
			const successful = current[HEALTH_SUCCEEDED] === true || current.status === "ok";
			const rateLimitFailures = current.status === "rate-limited"
				? previousRateLimitFailures + 1
				: successful ? 0 : previousRateLimitFailures;
			// A late completion from a replaced binding may resolve its own caller,
			// but must never overwrite the newer binding's cache state.
			if (refreshGenerations.get(spec.id) === generation) {
				cache.set(spec.id, {
					configKey: spec.configKey,
					account: next,
					rateLimitFailures,
					lastEvaluatedAt: current.fetchedAt
				});
			}
			return withHealthAge(next, now());
		});
		let entry;
		const tracked = promise.finally(() => {
			if (inflight.get(spec.id) === entry) inflight.delete(spec.id);
		});
		entry = { configKey: spec.configKey, promise: tracked };
		inflight.set(spec.id, entry);
		return tracked;
	}

	async function get(providerId, { force = false, activity = null } = {}) {
		const spec = await specById(providerId);
		if (spec === null) return null;
		if (activity !== null) touch(providerId, activity);
		const hit = cache.get(providerId);
		const at = now();
		if (!force && hit?.configKey === spec.configKey && policyOf(spec, at).nextRefreshAt > at) return withHealthAge(hit.account, at);
		return refresh(spec);
	}

	async function refreshableSpecs() {
		const all = await specs();
		const keyed = await Promise.all(all.map(async (spec) => ({
			spec,
			probe: spec.adapter === null
				? (await resolveCredential(credentials, spec.apiKeyRef)) !== ""
				: true
		})));
		return keyed.filter((entry) => entry.probe).map((entry) => entry.spec);
	}

	async function refreshAll() {
		// Auto-detection only probes null-adapter relays that have a configured
		// API key, so the background refresh stays bounded and never touches
		// unrelated, unkeyed providers.
		return Promise.all((await refreshableSpecs()).map((spec) => refresh(spec)));
	}

	async function refreshDue({ force = false } = {}) {
		const at = now();
		const all = await refreshableSpecs();
		const due = force ? all : all.filter((spec) => policyOf(spec, at).nextRefreshAt <= at);
		return Promise.all(due.map((spec) => refresh(spec)));
	}

	async function nextRefreshAt() {
		const at = now();
		const all = await refreshableSpecs();
		if (all.length === 0) return null;
		return Math.min(...all.map((spec) => policyOf(spec, at).nextRefreshAt));
	}

	async function providerViews() {
		return Promise.all((await specs()).map(async (spec) => {
			const hit = cache.get(spec.id);
			const account = withHealthAge(hit?.configKey === spec.configKey ? hit.account : void 0, now());
			const credentialConfigured = account === void 0 && spec.apiKeyRef !== void 0
				? await resolveCredential(credentials, spec.apiKeyRef) !== ""
				: false;
			return {
				id: spec.id,
				displayName: spec.displayName,
				accountMode: account?.mode ?? spec.mode,
				adapter: spec.adapter ?? account?.adapter ?? null,
				configured: account === void 0 ? credentialConfigured : account.status !== "not-configured",
				status: account?.status ?? "pending",
				fetchedAt: account?.fetchedAt ?? null,
				stale: account?.stale ?? false,
				lastAttemptAt: account?.lastAttemptAt ?? null,
				lastSuccessAt: account?.lastSuccessAt ?? null,
				ageMs: account?.ageMs ?? null,
				provenance: account?.provenance ?? accountProvenance(spec),
				reason: account?.reason ?? null,
				alert: account?.alert ?? null
			};
		}));
	}

	async function subscriptionAccounts() {
		const all = await specs();
		const accounts = await Promise.all(all.filter((spec) => spec.mode === "subscription" || spec.adapter === "sub2api").map((spec) => get(spec.id)));
		return accounts.filter((account) => account?.mode === "subscription");
	}

	return {
		get,
		refreshAll,
		refreshDue,
		nextRefreshAt,
		touch,
		setActiveProviders,
		subscribePolicyChanges,
		providerViews,
		subscriptionAccounts,
		validate: async () => { await specs(); },
		cached: (providerId) => withHealthAge(cache.get(providerId)?.account ?? null, now())
	};
}

export const ACCOUNT_REFRESH_MS = DEFAULT_REFRESH_MS;
