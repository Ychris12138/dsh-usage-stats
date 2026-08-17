/**
 * Subscription-quota module for providers that expose percentage windows.
 *
 * The external interface is deliberately small: callers provide the Harness
 * credentials seam and optional transport/time dependencies, and receive two
 * normalized provider records. Provider credentials, upstream response shapes,
 * parsing quirks, and error mapping remain inside this module.
 *
 * OpenCode Go's documented provider API does not include usage, but its
 * first-party client currently exposes an undocumented Bearer-key endpoint.
 * The adapter prefers that simpler path, can reuse OpenCode's local auth.json,
 * and keeps the authenticated workspace dashboard as a compatibility fallback.
 * Z.ai uses its Coding Plan quota endpoints with a normal API key.
 *
 * @module dsh-usage-stats/subscriptions
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const OPENCODE_GO_URL = "https://opencode.ai";
const OPENCODE_GO_USAGE_URL = `${OPENCODE_GO_URL}/zen/go/v1/usage`;
const COMMAND_CODE_URL = "https://api.commandcode.ai";
const ZAI_HOSTS = {
	global: "https://api.z.ai",
	"bigmodel-cn": "https://open.bigmodel.cn"
};
const ZAI_QUOTA_PATH = "/api/monitor/usage/quota/limit";
const ZAI_SUBSCRIPTION_PATH = "/api/biz/subscription/list";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const MINIMAX_TOKEN_PLAN_HOSTS = {
	global: "https://www.minimax.io",
	cn: "https://www.minimaxi.com"
};
const MINIMAX_LEGACY_HOSTS = {
	global: "https://api.minimax.io",
	cn: "https://api.minimaxi.com"
};
const MINIMAX_USAGE_PATH = "/v1/api/openplatform/coding_plan/remains";
const MINIMAX_TOKEN_PLAN_PATH = "/v1/token_plan/remains";
const DEFAULT_TIMEOUT_MS = 15000;

const REFS = {
	openCodeApiKey: "OPENCODE_GO_API_KEY",
	openCodeCookie: "OPENCODE_GO_AUTH_COOKIE",
	openCodeWorkspace: "OPENCODE_GO_WORKSPACE_ID",
	zaiApiKey: "ZAI_API_KEY",
	zaiRegion: "ZAI_API_REGION",
	kimiApiKey: "KIMI_API_KEY",
	minimaxApiKey: "MINIMAX_API_KEY",
	minimaxRegion: "MINIMAX_API_REGION",
	commandCodeApiKey: "COMMAND_CODE_API_KEY"
};

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

function clampPercent(value) {
	const parsed = numberOrNull(value);
	return parsed === null ? null : Math.max(0, Math.min(100, parsed));
}

function round1(value) {
	return Math.round(value * 10) / 10;
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

async function resolveCredential(credentials, ref) {
	if (credentials === void 0 || credentials === null || typeof credentials.resolve !== "function") return "";
	try {
		const hit = await credentials.resolve(ref);
		return typeof hit?.value === "string" ? hit.value.trim() : "";
	} catch {
		return "";
	}
}

function normalizedStatus(error) {
	if (error?.name === "TimeoutError" || error?.name === "AbortError") return "unavailable";
	if (error?.providerStatus) return error.providerStatus;
	return error instanceof SyntaxError ? "invalid-response" : "unavailable";
}

function invalidResponse(message) {
	const error = new Error(message);
	error.providerStatus = "invalid-response";
	return error;
}

async function request(url, init, deps, type) {
	const response = await (deps.fetch ?? fetch)(url, {
		...init,
		signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
	});
	if (!response.ok) {
		const error = new Error(`upstream returned HTTP ${response.status}`);
		error.httpStatus = response.status;
		error.providerStatus = response.status === 401 || response.status === 403
			? "unauthorized"
			: response.status === 429 ? "rate-limited" : "unavailable";
		throw error;
	}
	if (type === "text") return response.text();
	try {
		return await response.json();
	} catch {
		throw invalidResponse("upstream returned invalid JSON");
	}
}

function sanitizeCookie(raw) {
	let value = String(raw ?? "").trim().replace(/^cookie\s*:\s*/i, "");
	value = value.split(";").map((part) => part.trim()).filter(Boolean).join("; ");
	return value !== "" && !value.includes("=") ? `auth=${value}` : value;
}

function workspaceIdOf(raw) {
	return String(raw ?? "").match(/wrk_[A-Za-z0-9]+/)?.[0] ?? "";
}

function looksSignedOut(text) {
	const lower = String(text).toLowerCase();
	return lower.includes("sign in") || lower.includes("login") || lower.includes("auth/authorize") || lower.includes('actor of type "public"');
}

function goWindowFromObject(value, kind, now) {
	if (value === null || typeof value !== "object") return null;
	const percentSource = value.usagePercent ?? value.usedPercent ?? value.percentUsed ?? value.percentage ?? value.percent;
	let usedPercent = clampPercent(percentSource);
	if (usedPercent === null) {
		const used = numberOrNull(value.used ?? value.consumed);
		const limit = numberOrNull(value.limit ?? value.total ?? value.quota);
		if (used !== null && limit !== null && limit > 0) usedPercent = clampPercent((used / limit) * 100);
	}
	if (usedPercent === null) return null;
	// The dashboard embeds usagePercent as a 0..1 ratio. The Bearer endpoint's
	// `percent` is already 0..100, so only scale ratio-named dashboard fields.
	if (usedPercent <= 1 && usedPercent >= 0 && value.percent === void 0 && percentSource !== void 0) usedPercent *= 100;
	const resetSeconds = numberOrNull(value.resetInSec ?? value.resetInSeconds ?? value.resetSeconds);
	const resetsAt = resetSeconds === null ? toIso(value.resetAt ?? value.resetsAt ?? value.nextReset) : new Date(now + Math.max(0, resetSeconds) * 1000).toISOString();
	return {
		kind,
		usedPercent: round1(clampPercent(usedPercent)),
		remainingPercent: round1(100 - clampPercent(usedPercent)),
		...(resetsAt === null ? {} : { resetsAt })
	};
}

function parseOpenCodeGoApi(body, now) {
	const usage = body?.usage ?? body;
	if (usage === null || typeof usage !== "object") return [];
	return [
		goWindowFromObject(usage.rolling, "session", now),
		goWindowFromObject(usage.weekly, "weekly", now),
		goWindowFromObject(usage.monthly, "monthly", now)
	].filter(Boolean);
}

function findObject(root, keyword, depth = 0) {
	if (root === null || typeof root !== "object" || depth > 5) return null;
	for (const [key, value] of Object.entries(root)) {
		if (key.toLowerCase().includes(keyword) && value !== null && typeof value === "object") return value;
	}
	for (const value of Object.values(root)) {
		const found = findObject(value, keyword, depth + 1);
		if (found !== null) return found;
	}
	return null;
}

function goWindowFromText(text, key, kind, now) {
	const percent = new RegExp(`${key}[^}]*?usagePercent\\s*[:=]\\s*([0-9]+(?:\\.[0-9]+)?)`, "i").exec(text);
	if (percent === null) return null;
	const reset = new RegExp(`${key}[^}]*?resetInSec\\s*[:=]\\s*([0-9]+)`, "i").exec(text);
	const usedPercent = round1(clampPercent(Number(percent[1])));
	return {
		kind,
		usedPercent,
		remainingPercent: round1(100 - usedPercent),
		...(reset === null ? {} : { resetsAt: new Date(now + Number(reset[1]) * 1000).toISOString() })
	};
}

function parseOpenCodeGo(text, now) {
	let windows = [];
	try {
		const root = JSON.parse(text);
		windows = [
			goWindowFromObject(findObject(root, "rolling"), "session", now),
			goWindowFromObject(findObject(root, "weekly") ?? findObject(root, "week"), "weekly", now),
			goWindowFromObject(findObject(root, "monthly") ?? findObject(root, "month"), "monthly", now)
		].filter(Boolean);
	} catch {
		/* The dashboard may embed text/javascript rather than strict JSON. */
	}
	if (!windows.some((window) => window.kind === "session") || !windows.some((window) => window.kind === "weekly")) {
		windows = [
			goWindowFromText(text, "rollingUsage", "session", now),
			goWindowFromText(text, "weeklyUsage", "weekly", now),
			goWindowFromText(text, "monthlyUsage", "monthly", now)
		].filter(Boolean);
	}
	return windows.some((window) => window.kind === "session") && windows.some((window) => window.kind === "weekly") ? windows : [];
}

async function localOpenCodeApiKey(deps) {
	try {
		const home = typeof deps.homedir === "function" ? deps.homedir() : homedir();
		const load = deps.readFile ?? readFile;
		const raw = JSON.parse(await load(join(home, ".local", "share", "opencode", "auth.json"), "utf8"));
		const entry = raw?.["opencode-go"] ?? raw?.opencode;
		return entry?.type === "api" && typeof entry.key === "string" ? entry.key.trim() : "";
	} catch {
		return "";
	}
}

async function collectOpenCodeGoFromDashboard(cookie, workspaceId, deps) {
	try {
		const text = await request(`${OPENCODE_GO_URL}/workspace/${workspaceId}/go`, {
			headers: {
				cookie,
				accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
			}
		}, deps, "text");
		if (looksSignedOut(text)) return { status: "unauthorized", windows: [] };
		const windows = parseOpenCodeGo(text, deps.now());
		return { status: windows.length > 0 ? "ok" : "invalid-response", windows };
	} catch (error) {
		return { status: normalizedStatus(error), windows: [] };
	}
}

async function collectOpenCodeGo(credentials, deps) {
	const apiKeyRef = deps.apiKeyRef ?? REFS.openCodeApiKey;
	const [configuredApiKey, cookieRaw, workspaceRaw] = await Promise.all([
		resolveCredential(credentials, apiKeyRef),
		resolveCredential(credentials, REFS.openCodeCookie),
		resolveCredential(credentials, REFS.openCodeWorkspace)
	]);
	const apiKey = configuredApiKey || await localOpenCodeApiKey(deps);
	const cookie = sanitizeCookie(cookieRaw);
	const workspaceId = workspaceIdOf(workspaceRaw);
	if (apiKey === "" && (cookie === "" || workspaceId === "")) {
		return {
			id: "opencode-go",
			displayName: "OpenCode Go",
			mode: "subscription",
			status: "not-configured",
			plan: "Go",
			missingCredentials: [apiKeyRef],
			windows: []
		};
	}

	let apiStatus = "unavailable";
	if (apiKey !== "") {
		try {
			const body = await request(OPENCODE_GO_USAGE_URL, {
				headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" }
			}, deps, "json");
			const windows = parseOpenCodeGoApi(body, deps.now());
			if (windows.length > 0) {
				return { id: "opencode-go", displayName: "OpenCode Go", mode: "subscription", status: "ok", plan: "Go", windows };
			}
			apiStatus = "invalid-response";
		} catch (error) {
			apiStatus = normalizedStatus(error);
		}
	}
	if (cookie !== "" && workspaceId !== "") {
		const dashboard = await collectOpenCodeGoFromDashboard(cookie, workspaceId, deps);
		return { id: "opencode-go", displayName: "OpenCode Go", mode: "subscription", status: dashboard.status, plan: "Go", windows: dashboard.windows };
	}
	return { id: "opencode-go", displayName: "OpenCode Go", mode: "subscription", status: apiStatus, plan: "Go", windows: [] };
}

function zaiRegionOf(raw, fallback = "global") {
	const value = String(raw || fallback).trim().toLowerCase();
	return value === "bigmodel-cn" || value === "cn" || value.includes("bigmodel.cn") ? "bigmodel-cn" : "global";
}

function zaiWindowMinutes(limit) {
	const unit = numberOrNull(limit?.unit);
	const number = numberOrNull(limit?.number);
	if (unit === null || number === null || number <= 0) return null;
	if (unit === 5) return number;
	if (unit === 3) return number * 60;
	if (unit === 1) return number * 24 * 60;
	if (unit === 6) return number * 7 * 24 * 60;
	return null;
}

function zaiUsedPercent(limit) {
	const total = numberOrNull(limit?.usage);
	const remaining = numberOrNull(limit?.remaining);
	const current = numberOrNull(limit?.currentValue ?? limit?.current_value);
	if (total !== null && total > 0) {
		const used = remaining === null ? current : current === null ? total - remaining : Math.max(total - remaining, current);
		if (used !== null) return clampPercent((Math.max(0, Math.min(total, used)) / total) * 100);
	}
	return clampPercent(limit?.percentage ?? limit?.usedPercent ?? limit?.used_percent);
}

function displayPlan(value) {
	return String(value ?? "").trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ").replace(/\bglm\b/gi, "GLM").replace(/\b\w/g, (char) => char.toUpperCase());
}

function zaiPlan(quota, subscription) {
	const row = Array.isArray(subscription?.data) ? subscription.data.find((entry) => entry && typeof entry === "object") : null;
	for (const source of [row, quota?.data]) {
		for (const key of ["product_name", "productName", "plan_name", "planName", "package_name", "packageName", "plan_type", "planType", "level"]) {
			const value = displayPlan(source?.[key]);
			if (value !== "") return value;
		}
	}
	return "GLM Coding Plan";
}

function zaiWindow(limit, kind, fallbackReset = null) {
	const usedPercent = zaiUsedPercent(limit);
	if (usedPercent === null) return null;
	const resetsAt = toIso(limit.nextResetTime ?? limit.next_reset_time) ?? fallbackReset;
	return {
		kind,
		usedPercent: round1(usedPercent),
		remainingPercent: round1(100 - usedPercent),
		...(resetsAt === null ? {} : { resetsAt }),
		...(numberOrNull(limit.remaining) === null ? {} : { remaining: numberOrNull(limit.remaining) })
	};
}

function parseZai(quota, subscription) {
	const limits = Array.isArray(quota?.data?.limits) ? quota.data.limits : [];
	const tokenLimits = limits.filter((limit) => ["TOKENS_LIMIT", "CREDIT_LIMIT"].includes(String(limit?.type ?? limit?.limit_type ?? "").toUpperCase()) && zaiUsedPercent(limit) !== null)
		.sort((a, b) => (zaiWindowMinutes(a) ?? Number.MAX_SAFE_INTEGER) - (zaiWindowMinutes(b) ?? Number.MAX_SAFE_INTEGER));
	const timeLimit = limits.find((limit) => String(limit?.type ?? limit?.limit_type ?? "").toUpperCase() === "TIME_LIMIT" && zaiUsedPercent(limit) !== null) ?? null;
	const first = tokenLimits[0] ?? null;
	const session = tokenLimits.length >= 2 ? first : zaiWindowMinutes(first) !== null && zaiWindowMinutes(first) <= 360 ? first : null;
	const weekly = tokenLimits.length >= 2 ? tokenLimits[tokenLimits.length - 1] : session === null ? first : null;
	const subscriptionRow = Array.isArray(subscription?.data) ? subscription.data[0] : null;
	const renewAt = toIso(subscriptionRow?.next_renew_time ?? subscriptionRow?.nextRenewTime);
	return {
		plan: zaiPlan(quota, subscription),
		windows: [
			session === null ? null : zaiWindow(session, "session"),
			weekly === null ? null : zaiWindow(weekly, "weekly"),
			timeLimit === null ? null : zaiWindow(timeLimit, "billing", renewAt)
		].filter(Boolean)
	};
}

async function collectZai(credentials, deps) {
	const apiKeyRef = deps.zaiApiKeyRef ?? REFS.zaiApiKey;
	const [apiKey, configuredRegion] = await Promise.all([
		resolveCredential(credentials, apiKeyRef),
		resolveCredential(credentials, REFS.zaiRegion)
	]);
	const region = zaiRegionOf(configuredRegion, deps.zaiDefaultRegion);
	if (apiKey === "") {
		return { id: "zai", displayName: "Z.ai", mode: "subscription", status: "not-configured", plan: "GLM Coding Plan", region, missingCredentials: [apiKeyRef], windows: [] };
	}
	const host = ZAI_HOSTS[region];
	// The Coding Plan endpoint expects the raw API key, unlike the inference API.
	const init = { headers: { authorization: apiKey, accept: "application/json" } };
	try {
		const quota = await request(`${host}${ZAI_QUOTA_PATH}`, init, deps, "json");
		let subscription = null;
		try {
			subscription = await request(`${host}${ZAI_SUBSCRIPTION_PATH}`, init, deps, "json");
		} catch {
			/* Plan label/reset metadata is optional when quota succeeded. */
		}
		const parsed = parseZai(quota, subscription);
		return { id: "zai", displayName: "Z.ai", mode: "subscription", status: parsed.windows.length > 0 ? "ok" : "invalid-response", plan: parsed.plan, region, windows: parsed.windows };
	} catch (error) {
		return { id: "zai", displayName: "Z.ai", mode: "subscription", status: normalizedStatus(error), plan: "GLM Coding Plan", region, windows: [] };
	}
}

function limitWindow(value, kind) {
	if (value === null || typeof value !== "object") return null;
	const limit = numberOrNull(value.limit ?? value.total);
	const remaining = numberOrNull(value.remaining);
	if (limit === null || remaining === null || limit <= 0) return null;
	const usedPercent = round1(clampPercent((limit - remaining) / limit * 100));
	const resetsAt = toIso(value.resetTime ?? value.reset_time ?? value.resetsAt);
	return {
		kind,
		usedPercent,
		remainingPercent: round1(100 - usedPercent),
		...(resetsAt === null ? {} : { resetsAt })
	};
}

function parseKimi(body) {
	const data = body?.data ?? body;
	const limits = Array.isArray(data?.limits) ? data.limits : [];
	const session = limits.map((entry) => limitWindow(entry?.detail ?? entry, "session")).find(Boolean) ?? null;
	const weekly = limitWindow(data?.usage, "weekly");
	return {
		plan: String(data?.plan ?? data?.planName ?? "Kimi For Coding"),
		windows: [session, weekly].filter(Boolean)
	};
}

async function collectKimi(credentials, deps) {
	const apiKeyRef = deps.apiKeyRef ?? REFS.kimiApiKey;
	const apiKey = await resolveCredential(credentials, apiKeyRef);
	if (apiKey === "") return { id: "kimi", displayName: "Kimi For Coding", mode: "subscription", status: "not-configured", plan: "Kimi For Coding", missingCredentials: [apiKeyRef], windows: [] };
	try {
		const configured = nonEmptyUrl(deps.baseURL, "/coding/v1/usages") ?? KIMI_USAGE_URL;
		const body = await request(configured, {
			headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" }
		}, deps, "json");
		const parsed = parseKimi(body);
		return { id: "kimi", displayName: "Kimi For Coding", mode: "subscription", status: parsed.windows.length > 0 ? "ok" : "invalid-response", ...parsed };
	} catch (error) {
		return { id: "kimi", displayName: "Kimi For Coding", mode: "subscription", status: normalizedStatus(error), plan: "Kimi For Coding", windows: [] };
	}
}

function nonEmptyUrl(value, defaultPath) {
	if (typeof value !== "string" || value.trim() === "") return null;
	try {
		const url = new URL(value);
		return url.pathname === "/" || url.pathname === "" ? new URL(defaultPath, url).href : url.href;
	} catch {
		return null;
	}
}

function minimaxRegionOf(raw, baseURL) {
	const value = String(raw ?? "").trim().toLowerCase();
	if (value === "cn" || value.includes("minimaxi.com") || String(baseURL ?? "").includes("minimaxi.com")) return "cn";
	return "global";
}

function resetFromDuration(value, now) {
	const milliseconds = numberOrNull(value);
	if (milliseconds === null || milliseconds < 0) return null;
	const date = new Date(now + milliseconds);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const MINIMAX_CHAT_MODEL_PATTERN = /^(minimax-m|coding-plan)/i;

function minimaxChatEntry(remains) {
	const named = remains.find((entry) => String(entry?.model_name ?? entry?.modelName ?? "").toLowerCase() === "general");
	if (named !== void 0) return named;
	// Newer payload versions name the chat entry after the model itself
	// (e.g. "MiniMax-M3") instead of the "general" resource group.
	return remains.find((entry) => MINIMAX_CHAT_MODEL_PATTERN.test(String(entry?.model_name ?? entry?.modelName ?? "")));
}

function minimaxWindowRemaining(remainingPercent, totalCount, usageCount, status) {
	const remaining = clampPercent(remainingPercent);
	if (remaining !== null) return remaining;
	// Older payload versions carry real counters instead of percentages;
	// current ones zero the counters, so only trust totals above zero.
	const total = numberOrNull(totalCount);
	const usage = numberOrNull(usageCount);
	if (total !== null && total > 0 && usage !== null) return clampPercent((1 - usage / total) * 100);
	// MiniMax window status: 1 = normal limited, 2 = exhausted, 3 = unlimited.
	// A missing percentage must not hide the window entirely.
	if (status === 2) return 0;
	if (status === 3) return 100;
	return null;
}

function parseMiniMax(body, now) {
	const statusCode = numberOrNull(body?.base_resp?.status_code ?? body?.baseResp?.statusCode);
	if (statusCode !== null && statusCode !== 0) {
		const message = body?.base_resp?.status_msg ?? body?.baseResp?.statusMsg;
		const suffix = typeof message === "string" && message.trim() !== "" ? `: ${message.trim()}` : "";
		return { windows: [], reason: `base_resp status_code ${statusCode}${suffix}` };
	}
	const remains = Array.isArray(body?.model_remains) ? body.model_remains : Array.isArray(body?.data?.model_remains) ? body.data.model_remains : [];
	if (remains.length === 0) return { windows: [], reason: "response has no model_remains entries" };
	const general = minimaxChatEntry(remains);
	if (general === void 0) return { windows: [], reason: "model_remains has no general/chat-model entry" };
	const intervalRemaining = minimaxWindowRemaining(
		general.current_interval_remaining_percent ?? general.currentIntervalRemainingPercent,
		general.current_interval_total_count ?? general.currentIntervalTotalCount,
		general.current_interval_usage_count ?? general.currentIntervalUsageCount,
		numberOrNull(general.current_interval_status ?? general.currentIntervalStatus)
	);
	const weeklyRemaining = minimaxWindowRemaining(
		general.current_weekly_remaining_percent ?? general.currentWeeklyRemainingPercent,
		general.current_weekly_total_count ?? general.currentWeeklyTotalCount,
		general.current_weekly_usage_count ?? general.currentWeeklyUsageCount,
		numberOrNull(general.current_weekly_status ?? general.currentWeeklyStatus)
	);
	const sessionReset = toIso(general.current_interval_end_time ?? general.currentIntervalEndTime ?? general.current_interval_reset_time)
		?? resetFromDuration(general.remains_time ?? general.remainsTime, now);
	const weeklyReset = toIso(general.current_weekly_end_time ?? general.currentWeeklyEndTime ?? general.current_weekly_reset_time)
		?? resetFromDuration(general.weekly_remains_time ?? general.weeklyRemainsTime, now);
	const windows = [
		intervalRemaining === null ? null : {
			kind: "session",
			usedPercent: round1(100 - intervalRemaining),
			remainingPercent: round1(intervalRemaining),
			...(sessionReset === null ? {} : { resetsAt: sessionReset })
		},
		weeklyRemaining === null ? null : {
			kind: "weekly",
			usedPercent: round1(100 - weeklyRemaining),
			remainingPercent: round1(weeklyRemaining),
			...(weeklyReset === null ? {} : { resetsAt: weeklyReset })
		}
	].filter(Boolean);
	return { windows, reason: windows.length === 0 ? "chat-model entry has no usable quota fields" : null };
}

async function collectMiniMax(credentials, deps) {
	const apiKeyRef = deps.apiKeyRef ?? REFS.minimaxApiKey;
	const [apiKey, configuredRegion] = await Promise.all([
		resolveCredential(credentials, apiKeyRef),
		resolveCredential(credentials, REFS.minimaxRegion)
	]);
	const region = minimaxRegionOf(deps.region ?? configuredRegion, deps.baseURL);
	if (apiKey === "") return { id: "minimax", displayName: "MiniMax Coding Plan", mode: "subscription", status: "not-configured", plan: "MiniMax Coding Plan", region, missingCredentials: [apiKeyRef], windows: [] };
	const configuredUrl = nonEmptyUrl(deps.baseURL, MINIMAX_USAGE_PATH);
	// The token-plan endpoint is served on both the www and api hosts; try the
	// api host before falling back to the legacy coding-plan path.
	const urls = configuredUrl === null ? [
		`${MINIMAX_TOKEN_PLAN_HOSTS[region]}${MINIMAX_TOKEN_PLAN_PATH}`,
		`${MINIMAX_LEGACY_HOSTS[region]}${MINIMAX_TOKEN_PLAN_PATH}`,
		`${MINIMAX_LEGACY_HOSTS[region]}${MINIMAX_USAGE_PATH}`
	] : [configuredUrl];
	try {
		let body = null;
		for (const [index, url] of urls.entries()) {
			try {
				body = await request(url, {
					headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" }
				}, deps, "json");
				break;
			} catch (error) {
				// Route not found or a non-JSON (e.g. HTML) reply means this host
				// does not serve the endpoint; auth and rate-limit failures are
				// real answers and must not fall through to another host.
				const tryNext = error?.httpStatus === 404 || error?.httpStatus === 405 || error?.providerStatus === "invalid-response";
				if (index < urls.length - 1 && tryNext) continue;
				throw error;
			}
		}
		const { windows, reason } = parseMiniMax(body, deps.now());
		return {
			id: "minimax",
			displayName: "MiniMax Coding Plan",
			mode: "subscription",
			status: windows.length > 0 ? "ok" : "invalid-response",
			plan: "MiniMax Coding Plan",
			region,
			windows,
			// Non-sensitive diagnostic so reports can say WHY parsing failed.
			...(windows.length > 0 || reason === null ? {} : { reason })
		};
	} catch (error) {
		return { id: "minimax", displayName: "MiniMax Coding Plan", mode: "subscription", status: normalizedStatus(error), plan: "MiniMax Coding Plan", region, windows: [] };
	}
}

function commandCodeWindow(value, kind) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const cap = numberOrNull(value.cap ?? value.limit ?? value.total ?? value.quota);
	const used = numberOrNull(value.used ?? value.consumed ?? value.usage);
	if (cap === null || cap <= 0 || used === null) return null;
	const usedPercent = round1(Math.max(0, Math.min(100, used / cap * 100)));
	const resetsAt = toIso(value.resetAt ?? value.resetsAt ?? value.reset);
	return {
		kind,
		usedPercent,
		remainingPercent: round1(100 - usedPercent),
		...(resetsAt === null ? {} : { resetsAt })
	};
}

function commandCodePlanName(value) {
	if (typeof value !== "string" || value.trim() === "") return void 0;
	const key = value.trim().toLowerCase().replace(/[\\s_-]+/g, "-");
	const names = {
		"individual-go": "Go",
		"individual-goat": "GOAT",
		"individual-pro": "Pro",
		"individual-max": "Max",
		"individual-ultra": "Ultra",
		"individual-provider": "Provider",
		"teams-pro": "Team Pro"
	};
	return names[key] ?? value;
}

async function collectCommandCode(credentials, deps) {
	const apiKeyRef = deps.apiKeyRef ?? REFS.commandCodeApiKey;
	const apiKey = await resolveCredential(credentials, apiKeyRef);
	if (apiKey === "") return {
		id: "command-code",
		displayName: "Command Code",
		mode: "subscription",
		status: "not-configured",
		plan: void 0,
		missingCredentials: [apiKeyRef],
		windows: []
	};
	const base = (() => {
		try { return new URL(deps.baseURL ?? COMMAND_CODE_URL).origin; }
		catch { return COMMAND_CODE_URL; }
	})();
	const headers = {
		authorization: `Bearer ${apiKey}`,
		accept: "application/json",
		"x-command-code-version": "0.29.0",
		"x-cli-environment": "production"
	};
	try {
		const whoami = await request(`${base}/alpha/whoami`, { headers }, deps, "json");
		const orgId = nonEmptyString(whoami?.org?.id);
		const suffix = orgId === null ? "" : `?orgId=${encodeURIComponent(orgId)}`;
		const [credits, summary, subscription] = await Promise.all([
			request(`${base}/alpha/billing/credits${suffix}`, { headers }, deps, "json"),
			request(`${base}/alpha/usage/summary${suffix}`, { headers }, deps, "json"),
			request(`${base}/alpha/billing/subscriptions${suffix}`, { headers }, deps, "json").catch(() => null)
		]);
		const totalCredits = ["monthlyCredits", "purchasedCredits", "freeCredits"]
			.reduce((sum, key) => sum + Math.max(0, numberOrNull(credits?.credits?.[key]) ?? 0), 0);
		const spent = Math.max(0, numberOrNull(summary?.totalCost) ?? 0);
		const windows = [];
		if (totalCredits > 0) {
			const total = spent + totalCredits;
			const usedPercent = round1(Math.max(0, Math.min(100, spent / total * 100)));
			windows.push({ kind: "credits", usedPercent, remainingPercent: round1(100 - usedPercent) });
		}
		const limits = credits?.windowLimits;
		if (limits !== null && typeof limits === "object" && !Array.isArray(limits)) {
			for (const [key, kind] of [["fiveHour", "session"], ["weekly", "weekly"]]) {
				const window = commandCodeWindow(limits[key], kind);
				if (window !== null) windows.push(window);
			}
		}
		const planId = subscription?.planId ?? subscription?.data?.planId ?? whoami?.planId;
		const hasValidAccountPayload = credits?.credits !== null && typeof credits?.credits === "object"
			&& summary !== null && typeof summary === "object";
		return {
			id: "command-code",
			displayName: "Command Code",
			mode: "subscription",
			status: hasValidAccountPayload ? "ok" : "invalid-response",
			plan: commandCodePlanName(planId) ?? (hasValidAccountPayload ? "No active plan" : void 0),
			windows,
			...(windows.length > 0 || hasValidAccountPayload ? {} : { reason: "no-usage-windows" })
		};
	} catch (error) {
		return { id: "command-code", displayName: "Command Code", mode: "subscription", status: normalizedStatus(error), plan: void 0, windows: [] };
	}
}

/** Query one subscription/token-plan adapter. */
export async function collectSubscription(providerId, credentials, options = {}, deps = {}) {
	const shared = {
		fetch: deps.fetch,
		readFile: deps.readFile,
		homedir: deps.homedir,
		timeoutMs: deps.timeoutMs,
		now: deps.now ?? Date.now,
		apiKeyRef: options.apiKeyRef,
		baseURL: options.baseURL,
		region: options.region
	};
	if (providerId === "opencode-go") return collectOpenCodeGo(credentials, shared);
	if (providerId === "command-code" || providerId === "commandcode") return collectCommandCode(credentials, shared);
	if (providerId === "zai") return collectZai(credentials, {
		...shared,
		zaiApiKeyRef: options.apiKeyRef,
		zaiDefaultRegion: options.region ?? "global"
	});
	if (providerId === "kimi") return collectKimi(credentials, shared);
	if (providerId === "minimax") return collectMiniMax(credentials, shared);
	return { id: providerId, displayName: providerId, mode: "subscription", status: "unavailable", windows: [] };
}

/** Collect every supported subscription provider concurrently. */
export async function collectSubscriptions(credentials, options = {}, deps = {}) {
	return Promise.all([
		collectSubscription("opencode-go", credentials, { apiKeyRef: options.openCodeApiKeyRef }, deps),
		collectSubscription("zai", credentials, { apiKeyRef: options.zaiApiKeyRef, region: options.zaiDefaultRegion ?? "global" }, deps)
	]);
}

export const subscriptionCredentialRefs = { ...REFS };
