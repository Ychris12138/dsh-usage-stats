/**
 * codearts-credits 适配器回归测试。
 *
 * 覆盖的是「宿主插件（dsh-codearts-auth）提供 creditBalance 服务」这一整条
 * 接缝：注册 → 分派 → 快照映射 → 降级路径。
 *
 * ⚠️ 这些用例**不**测 codearts 插件自己的签名协议（那是它那边的测试）；这里
 * 锁的是本插件的契约：拿到什么形状的 CreditBalance，就该给出什么形状的
 * account 快照，以及哪些情况**绝不能**显示成余额 0。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	accountProvenance,
	createAccountService,
	queryAccount,
	resolveAccountSpec
} from "../lib/accounts.js";
import { resolveProviderIdentity } from "../lib/provider-identity.js";

const tests = [];
function test(name, fn) {
	tests.push([name, fn]);
}

/** 一个只有只读方法的假宿主服务——真实服务就是无状态查询器。 */
function fakeCreditBalance(overrides = {}) {
	return {
		supportedProviders: () => [
			{ id: "codearts", displayName: "CodeArts Agent" },
			{ id: "buddy", displayName: "CodeBuddy (腾讯)" }
		],
		creditsBalances: async () => ({ accounts: [] }),
		...overrides
	};
}

function specFor(providerId, monitor = {}) {
	const spec = resolveAccountSpec({ id: providerId, displayName: providerId }, { monitors: { [providerId]: monitor } });
	assert.equal(spec.adapter, "codearts-credits", `${providerId} 应解析到 codearts-credits 适配器`);
	return spec;
}

const NOW = 1_800_000_000_000;

// ── 分类：12 条 route 都要落到 codearts-credits，且出处是 official ──

test("codearts 系 12 条 route 全部解析到 codearts-credits 适配器", () => {
	for (const id of ["codearts", "buddy", "workbuddy", "lobsterai", "qoder", "qodercn", "trae", "cline", "loomy", "raccoon", "zcode"]) {
		const identity = resolveProviderIdentity({ id, displayName: id }, { monitors: {} });
		assert.equal(identity.accountAdapter, "codearts-credits", `${id} 分类错误`);
	}
});

test("minimax 归 codearts-credits（MiniMax Code 账号在 codearts 池里）", () => {
	// 两个插件都注册了 minimax 这条 route id。内置的 minimax-token-plan 适配器
	// 要 MINIMAX_API_KEY，而 MiniMax Code 的账号凭据在 dsh-codearts-auth 的账号池
	// 里、没有这个 Key —— 判给 token-plan 会让卡片永远停在 not-configured，
	// 而 codearts 侧其实能读到 `credit/details`（实测踩过）。
	const identity = resolveProviderIdentity({ id: "minimax", displayName: "minimax" }, { monitors: {} });
	assert.equal(identity.accountAdapter, "codearts-credits");
});

test("API Key 版 minimax 路由仍走 token-plan（不误伤）", () => {
	// minimax-cn 在 llm-pi-ai 里配了 MINIMAX_CN_API_KEY，实测 status=ok。
	for (const id of ["minimaxi", "minimax-cn", "minimax-coding"]) {
		const identity = resolveProviderIdentity({ id, displayName: id }, { monitors: {} });
		assert.equal(identity.accountAdapter, "minimax-token-plan", `${id} 应保持 token-plan`);
	}
});

test("CANONICAL_ROUTES 无重复键（后写的会静默覆盖先写的）", async () => {
	// 踩过两次的坑：minimax 同时出现在两条映射里，JS 对象字面量让后者静默胜出。
	const source = readFileSync(new URL("../lib/provider-identity.js", import.meta.url), "utf8");
	const start = source.indexOf("const CANONICAL_ROUTES");
	const end = source.indexOf("});", start);
	const keys = [...source.slice(start, end).matchAll(/^\t"?([a-z0-9-]+)"?:/gm)].map((m) => m[1]);
	assert.equal(new Set(keys).size, keys.length, `重复键: ${keys.join(", ")}`);
});

test("适配器出处为 official（宿主插件持有凭据）", () => {
	assert.equal(accountProvenance({ adapter: "codearts-credits" }), "official");
});

test("模式是 subscription 而非 balance（积分是多个包）", () => {
	assert.equal(specFor("codearts").mode, "subscription");
});

test("显式 monitor 适配器仍可覆盖 route 分类", () => {
	const identity = resolveProviderIdentity(
		{ id: "codearts", displayName: "CodeArts" },
		{ monitors: { codearts: { adapter: "declarative" } } }
	);
	assert.equal(identity.accountAdapter, "declarative");
});

// ── 快照映射 ──

test("积分包折算成 quota window：已用比例来自 used/total", async () => {
	const service = fakeCreditBalance({
		creditsBalances: async () => ({
			accounts: [{
				accountId: "codearts-1",
				nickname: "主号",
				balance: {
					total: 100,
					expiredTotal: 0,
					packages: [{ name: "总积分包", unit: "credit", remaining: 40, total: 100, used: 60, active: true }]
				}
			}]
		})
	});
	const snapshot = await queryAccount(specFor("codearts"), { resolve: async () => void 0 }, { creditBalance: service, now: () => NOW });
	assert.equal(snapshot.status, "ok");
	assert.equal(snapshot.source, "codearts-plugin");
	assert.equal(snapshot.windows.length, 1);
	assert.equal(snapshot.windows[0].usedPercent, 60);
	assert.equal(snapshot.windows[0].remainingPercent, 40);
	assert.equal(snapshot.windows[0].label, "总积分包");
	assert.equal(snapshot.plan, "总积分包");
	assert.equal(snapshot.alert.level, "normal");
});

test("缺 used 时由 (total-remaining)/total 反推已用比例", async () => {
	const service = fakeCreditBalance({
		creditsBalances: async () => ({
			accounts: [{
				accountId: "a",
				nickname: "n",
				balance: { total: 80, expiredTotal: 0, packages: [{ name: "包", remaining: 20, total: 80, active: true }] }
			}]
		})
	});
	const snapshot = await queryAccount(specFor("codearts"), { resolve: async () => void 0 }, { creditBalance: service, now: () => NOW });
	assert.equal(snapshot.windows[0].usedPercent, 75);
	assert.equal(snapshot.windows[0].remainingPercent, 25);
});

test("过期包不谎报「用光 100%」（用 used/total 而非 1-remaining）", async () => {
	// 包过期后 remaining 归零而 used 停在真实消耗值。若用 1-remaining 算，
	// 一个只用了 25% 的包会显示成用光 100%。
	const service = fakeCreditBalance({
		creditsBalances: async () => ({
			accounts: [{
				accountId: "a",
				nickname: "n",
				balance: { total: 0, expiredTotal: 100, packages: [{ name: "过期包", remaining: 0, total: 100, used: 25, active: false }] }
			}]
		})
	});
	const snapshot = await queryAccount(specFor("codearts"), { resolve: async () => void 0 }, { creditBalance: service, now: () => NOW });
	assert.equal(snapshot.windows[0].usedPercent, 25);
	assert.equal(snapshot.windows[0].kind, "expired");
});

test("到期日取 deductionEndTime（expiredTime 为空串时的真实到期字段）", async () => {
	const service = fakeCreditBalance({
		creditsBalances: async () => ({
			accounts: [{
				accountId: "a",
				nickname: "n",
				balance: {
					total: 50,
					expiredTotal: 0,
					packages: [{ name: "包", remaining: 50, total: 50, used: 0, active: true, expiredTime: "", deductionEndTime: "2026-12-31T00:00:00.000Z" }]
				}
			}]
		})
	});
	const snapshot = await queryAccount(specFor("codearts"), { resolve: async () => void 0 }, { creditBalance: service, now: () => NOW });
	assert.equal(snapshot.windows[0].resetsAt, "2026-12-31T00:00:00.000Z");
});

test("空 packages 但有汇总额：合成一个绝对额度窗口（MiniMax 形状）", async () => {
	// MiniMax 的 credit/details 只返回各包 remaining_amount 之和，
	// packages 恒为 []（见 codearts 侧 fetchMinimaxCreditBalance）。
	// 早先实现把「零个窗口」一律判 unavailable，于是这类 provider
	// **有余额却显示不出来** —— 比显示 0 更糟。
	const service = fakeCreditBalance({
		creditsBalances: async () => ({
			accounts: [{ accountId: "minimax-1", nickname: "我的账号", balance: { total: 1234, packages: [], expiredTotal: 0 } }]
		})
	});
	const snapshot = await queryAccount(specFor("minimax"), { resolve: async () => void 0 }, { creditBalance: service, now: () => NOW });
	assert.equal(snapshot.status, "ok");
	assert.equal(snapshot.windows.length, 1);
	assert.equal(snapshot.windows[0].amount, 1234);
	assert.equal(snapshot.windows[0].label, "我的账号");
	// 没有分母就不编造百分比：渲染层据此决定不画进度条。
	assert.equal(snapshot.windows[0].usedPercent, void 0);
	// 没有百分比可判时告警必须是 unknown，而不是假装 0%（=critical）。
	assert.equal(snapshot.alert.level, "unknown");
	assert.equal(snapshot.alert.value, null);
});

test("空 packages 且 total 也缺失 → 仍然 unavailable（不编造 0）", async () => {
	const service = fakeCreditBalance({
		creditsBalances: async () => ({
			accounts: [{ accountId: "a", nickname: "n", balance: { total: null, packages: [], expiredTotal: 0 } }]
		})
	});
	const snapshot = await queryAccount(specFor("minimax"), { resolve: async () => void 0 }, { creditBalance: service, now: () => NOW });
	assert.equal(snapshot.status, "unavailable");
	assert.deepEqual(snapshot.windows, []);
});

test("多个账号的包合并进 windows，plan 记为账号数", async () => {
	const service = fakeCreditBalance({
		creditsBalances: async () => ({
			accounts: [
				{ accountId: "a1", nickname: "主号", balance: { total: 10, expiredTotal: 0, packages: [{ name: "总积分包", remaining: 10, total: 10, used: 0, active: true }] } },
				{ accountId: "a2", nickname: "小号", balance: { total: 5, expiredTotal: 0, packages: [{ name: "按需积分包", remaining: 1, total: 5, used: 4, active: true }] } }
			]
		})
	});
	const snapshot = await queryAccount(specFor("codearts"), { resolve: async () => void 0 }, { creditBalance: service, now: () => NOW });
	assert.equal(snapshot.windows.length, 2);
	assert.equal(snapshot.plan, "2 个账号");
	// 告警取所有窗口里最紧的那个
	assert.equal(snapshot.alert.value, 20);
	assert.deepEqual(new Set(snapshot.windows.map((w) => w.account)), new Set(["a1", "a2"]));
});

test("部分账号失败：成功的照常展示，失败原因单列（不吞掉）", async () => {
	const service = fakeCreditBalance({
		creditsBalances: async () => ({
			accounts: [
				{ accountId: "a1", nickname: "主号", balance: { total: 10, expiredTotal: 0, packages: [{ name: "包", remaining: 10, total: 10, used: 0, active: true }] } },
				{ accountId: "a2", nickname: "小号", balance: null, error: "Token 计费账户，无积分余额" }
			]
		})
	});
	const snapshot = await queryAccount(specFor("codearts"), { resolve: async () => void 0 }, { creditBalance: service, now: () => NOW });
	assert.equal(snapshot.status, "ok");
	assert.equal(snapshot.windows.length, 1);
	assert.deepEqual(snapshot.partial, ["小号: Token 计费账户，无积分余额"]);
});

test("alert 取最紧窗口：只剩 5% 时为 critical", async () => {
	const service = fakeCreditBalance({
		creditsBalances: async () => ({
			accounts: [{
				accountId: "a",
				nickname: "n",
				balance: {
					total: 5,
					expiredTotal: 0,
					packages: [
						{ name: "充足", remaining: 500, total: 500, used: 0, active: true },
						{ name: "告急", remaining: 5, total: 100, used: 95, active: true }
					]
				}
			}]
		})
	});
	const snapshot = await queryAccount(specFor("codearts"), { resolve: async () => void 0 }, { creditBalance: service, now: () => NOW });
	assert.equal(snapshot.alert.level, "critical");
	assert.equal(snapshot.alert.value, 5);
});

// ── 降级路径：每一条都不能显示成 0 ──

test("宿主服务缺席 → unsupported（不是 0，也不是启动失败）", async () => {
	const snapshot = await queryAccount(specFor("codearts"), { resolve: async () => void 0 }, { now: () => NOW });
	assert.equal(snapshot.status, "unsupported");
	assert.deepEqual(snapshot.windows, []);
});

test("服务形状不对（缺 creditsBalances）→ unsupported", async () => {
	const snapshot = await queryAccount(specFor("codearts"), { resolve: async () => void 0 }, { creditBalance: { supportedProviders: () => [] }, now: () => NOW });
	assert.equal(snapshot.status, "unsupported");
});

test("provider 不受支持（UnsupportedProviderError）→ unsupported", async () => {
	const error = new Error("unsupported provider: zcode");
	error.name = "UnsupportedProviderError";
	const service = fakeCreditBalance({ creditsBalances: async () => { throw error; } });
	const snapshot = await queryAccount(specFor("zcode"), { resolve: async () => void 0 }, { creditBalance: service, now: () => NOW });
	assert.equal(snapshot.status, "unsupported");
});

test("服务抛普通异常 → unavailable 并保留原因", async () => {
	const service = fakeCreditBalance({ creditsBalances: async () => { throw new Error("AK 限流"); } });
	const snapshot = await queryAccount(specFor("codearts"), { resolve: async () => void 0 }, { creditBalance: service, now: () => NOW });
	assert.equal(snapshot.status, "unavailable");
	assert.equal(snapshot.reason, "AK 限流");
});

test("账号池为空 → not-configured（而不是余额 0）", async () => {
	const service = fakeCreditBalance({ creditsBalances: async () => ({ accounts: [] }) });
	const snapshot = await queryAccount(specFor("codearts"), { resolve: async () => void 0 }, { creditBalance: service, now: () => NOW });
	assert.equal(snapshot.status, "not-configured");
});

test("全部账号查询失败 → unavailable 且带原因，绝不退化成 0", async () => {
	const service = fakeCreditBalance({
		creditsBalances: async () => ({
			accounts: [{ accountId: "a1", nickname: "主号", balance: null, error: "凭据已失效" }]
		})
	});
	const snapshot = await queryAccount(specFor("codearts"), { resolve: async () => void 0 }, { creditBalance: service, now: () => NOW });
	assert.equal(snapshot.status, "unavailable");
	assert.equal(snapshot.reason, "主号: 凭据已失效");
	assert.deepEqual(snapshot.windows, []);
});

test("空 packages 且 total 为 0 → 显示「剩余 0」（非 null 的 0 是真的 0）", async () => {
	// ⚠️ 与「查不到」严格区分：balance 为 null 才是读失败；balance 在但
	// total 是 0，按 codearts 侧约定（fetchMinimaxCreditBalance 注释：
	// 「本机实测 total_count: 0 且 details 缺失正是『真的为 0』」）
	// 就是确实没有额度，如实显示 0 才是对的。
	const service = fakeCreditBalance({
		creditsBalances: async () => ({
			accounts: [{ accountId: "a1", nickname: "主号", balance: { total: 0, expiredTotal: 0, packages: [] } }]
		})
	});
	const snapshot = await queryAccount(specFor("codearts"), { resolve: async () => void 0 }, { creditBalance: service, now: () => NOW });
	assert.equal(snapshot.status, "ok");
	assert.equal(snapshot.windows.length, 1);
	assert.equal(snapshot.windows[0].amount, 0);
});

test("包缺 remaining → 跳过该包（不把缺字段当 0）", async () => {
	const service = fakeCreditBalance({
		creditsBalances: async () => ({
			accounts: [{
				accountId: "a1",
				nickname: "主号",
				balance: { total: 10, expiredTotal: 0, packages: [{ name: "残缺包", total: 10, used: 1 }] }
			}]
		})
	});
	const snapshot = await queryAccount(specFor("codearts"), { resolve: async () => void 0 }, { creditBalance: service, now: () => NOW });
	assert.equal(snapshot.status, "unavailable");
});

// ── 服务级：provider 清单由服务给出，且不覆盖已注册 provider ──

test("服务在场时按服务清单补齐 provider（无需用户配置）", async () => {
	const service = fakeCreditBalance();
	const accountService = createAccountService({
		credentials: { resolve: async () => void 0 },
		getProviders: async () => [{ id: "deepseek-official", displayName: "DeepSeek" }],
		config: { monitors: {}, refresh: { enabled: false } },
		deps: { creditBalance: service }
	});
	const views = await accountService.providerViews();
	const ids = views.map((view) => view.id);
	assert.ok(ids.includes("codearts"), "codearts 未出现在 provider 列表");
	assert.ok(ids.includes("buddy"), "buddy 未出现在 provider 列表");
	const codearts = views.find((view) => view.id === "codearts");
	assert.equal(codearts.adapter, "codearts-credits");
	assert.equal(codearts.provenance, "official");
});

test("已注册的同名 provider 不被服务清单覆盖（用户改过的展示名要保留）", async () => {
	const service = fakeCreditBalance();
	const accountService = createAccountService({
		credentials: { resolve: async () => void 0 },
		getProviders: async () => [{ id: "codearts", displayName: "我改过的名字" }],
		config: { monitors: {}, refresh: { enabled: false } },
		deps: { creditBalance: service }
	});
	const view = (await accountService.providerViews()).find((item) => item.id === "codearts");
	assert.equal(view.displayName, "我改过的名字");
});

test("服务缺席时不补 provider（卡片不出现，其余 provider 不受影响）", async () => {
	const accountService = createAccountService({
		credentials: { resolve: async () => void 0 },
		getProviders: async () => [{ id: "deepseek-official", displayName: "DeepSeek" }],
		config: { monitors: {}, refresh: { enabled: false } },
		deps: {}
	});
	assert.equal((await accountService.providerViews()).some((view) => view.id === "codearts"), false);
});

// ── 集成层：index.js 真的把 ctx.get('creditBalance') 接上了 ──

test("index.js 以惰性取值器注入 creditBalance", () => {
	// ⚠️ 必须是 `() => ctx.get(...)` 而不是 `ctx.get(...)`：
	// cordis 的插件 apply 顺序不由本插件决定，而 ctx.get 不会回头补注入。
	// 一次性快照会让先于宿主启动的 usage-stats 永远拿不到服务，
	// 表现为所有 codearts provider 恒为 unsupported（实测踩过）。
	const source = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
	assert.match(source, /creditBalance:\s*\(\)\s*=>\s*ctx\.get\("creditBalance"\)/);
	// 快照写法是回归：一旦退回 `ctx.get(...)` 而非惰性，这条会失败。
	assert.doesNotMatch(source, /creditBalance:\s*ctx\.get\("creditBalance"\)/);
	assert.doesNotMatch(source, /creditBalance:\s*ctx\.creditBalance/);
});

test("hostService 既接受服务实例，也接受惰性取值器", async () => {
	// 直接放实例（测试与旧调用方）与放取值器（生产路径）都必须能用。
	const direct = fakeCreditBalance({ creditsBalances: async () => ({ accounts: [{ accountId: "a", nickname: "直传", balance: { total: 1, expiredTotal: 0, packages: [{ name: "包", remaining: 1, total: 1, used: 0, active: true }] } }] }) });
	const directSnapshot = await queryAccount(specFor("codearts"), { resolve: async () => void 0 }, { creditBalance: direct, now: () => NOW });
	assert.equal(directSnapshot.status, "ok");

	const lazy = fakeCreditBalance({ creditsBalances: async () => ({ accounts: [{ accountId: "a", nickname: "惰性", balance: { total: 1, expiredTotal: 0, packages: [{ name: "包", remaining: 1, total: 1, used: 0, active: true }] } }] }) });
	let calls = 0;
	const lazySnapshot = await queryAccount(specFor("codearts"), { resolve: async () => void 0 }, { creditBalance: () => { calls += 1; return lazy; }, now: () => NOW });
	assert.equal(lazySnapshot.status, "ok");
	assert.ok(calls > 0, "惰性取值器未被调用");
});

test("取值器返回 null（宿主未加载）时降级为 unsupported", async () => {
	const snapshot = await queryAccount(specFor("codearts"), { resolve: async () => void 0 }, { creditBalance: () => null, now: () => NOW });
	assert.equal(snapshot.status, "unsupported");
});

test("client.js 给 12 条 route 各自的两字母标识", () => {
	// 默认回退取展示名前两字母，会让 CodeArts / CodeBuddy / Cline 全落成 "CO"。
	const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	for (const [id, mark] of Object.entries({
		codearts: "CA", buddy: "CB", workbuddy: "WB", lobsterai: "LA", qoder: "QD",
		qodercn: "QN", trae: "TR", cline: "CL", loomy: "LM", raccoon: "RC", zcode: "ZC"
	})) {
		assert.match(source, new RegExp(`\\b${id}: "${mark}"`), `${id} 缺少标识 ${mark}`);
	}
});

let failed = 0;
for (const [name, fn] of tests) {
	try {
		await fn();
		process.stdout.write(`${name} ok\n`);
	} catch (error) {
		failed += 1;
		process.stdout.write(`${name} FAILED\n  ${error?.message ?? error}\n`);
	}
}
if (failed > 0) {
	process.stdout.write(`\n${failed} / ${tests.length} codearts-credits 用例失败\n`);
	process.exit(1);
}
process.stdout.write(`\nCODEARTS CREDITS TESTS PASSED (${tests.length})\n`);
