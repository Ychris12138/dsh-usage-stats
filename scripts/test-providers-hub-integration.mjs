/**
 * 使用已构建的真实 Providers Hub 与真实 Cordis 做隔离联调。
 * 仅供应商网络取数由合成读数替换，不读取用户凭据，不启动浏览器或真实 DSH profile。
 * 用法：node scripts/test-providers-hub-integration.mjs /absolute/path/to/hub
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAccountService, resolveAccountSpec } from "../lib/accounts.js";
import { jsonExport } from "../lib/export.js";

if (!process.argv[2]) throw new Error("请传入已构建的 Providers Hub 目录");
const root = resolve(process.argv[2]);
const stateDir = await mkdtemp(join(tmpdir(), "dsh-usage-hub-integration-"));
const previousStateDir = process.env.DSH_JET_HUB_STATE_DIR;
process.env.DSH_JET_HUB_STATE_DIR = stateDir;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("联调测试禁止访问真实供应商网络"); };
const forks = [];

try {
  const peer = createRequire(join(root, "package.json"));
  const { Context } = await import(pathToFileURL(peer.resolve("@deepseek-ai/cordis")).href);
  const { AccountPool } = await import(pathToFileURL(join(root, "lib/account-pool.js")).href);
  const { registerJetHubRpc } = await import(pathToFileURL(join(root, "lib/jet-hub-rpc.js")).href);
  const { PROVIDER_REGISTRY } = await import(pathToFileURL(join(root, "lib/provider-registry.js")).href);
  const ctx = new Context();
  const hostCredentialReads = [];
  const secrets = ["alpha_PRIVATE_TOKEN", "beta_PRIVATE_TOKEN", "PRIVATE_EMAIL", "PRIVATE_ACCOUNT_ID"];
  const hostCredentials = new Map([
    ["ZCODE_ALPHA", JSON.stringify({ access_token: secrets[0] })],
    ["ZCODE_BETA", JSON.stringify({ access_token: secrets[1] })],
  ]);
  ctx.provide("credentials", { resolve: async (ref) => {
    hostCredentialReads.push(String(ref));
    const value = hostCredentials.get(String(ref));
    return value === undefined ? undefined : { value, source: "fixture" };
  } });
  ctx.provide("commands", { register: () => () => {}, definitions: [] });
  ctx.provide("llm", { listModels: async () => [] });
  let state;
  ctx.provide("settings", {
    register: () => ({ get: () => state, replace: (value) => { state = value; } }), describe: () => [],
  });
  const pool = new AccountPool(ctx);
  for (const [index, ref] of ["ZCODE_ALPHA", "ZCODE_BETA"].entries()) {
    await pool.addAccount({ id: `PRIVATE_ACCOUNT_ID_${index}`, provider: "zcode", nickname: "PRIVATE_EMAIL", credentialRef: ref, enabled: true, refreshable: false, createdAt: 1 });
  }
  let failAll = false;
  let remaining = 750000;
  let supplierReads = 0;
  const auths = Object.fromEntries(PROVIDER_REGISTRY.map((p) => [p.id, {}]));
  auths.zcode = { fetchBalanceFor: async (credential) => {
    supplierReads += 1;
    assert.ok([secrets[0], secrets[1]].includes(credential.access_token));
    if (failAll || credential.access_token === secrets[1]) return undefined;
    return { buckets: [
      { showName: "GLM A", totalUnits: 1000000, availableUnits: remaining },
      { showName: "GLM B", totalUnits: 500000, availableUnits: 125000 },
    ], remaining: remaining + 125000, total: 1500000, claimablePlans: [] };
  } };
  const host = ctx.plugin((inner) => registerJetHubRpc(inner, pool, auths));
  forks.push(host);
  const mount = () => {
    const connection = ctx.plugin((inner) => inner.provide("connection", { fetch: { register: () => () => {} } }));
    forks.push(connection);
    return connection;
  };
  const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((done) => setTimeout(done, 0)); };
  const snapshots = [];
  const stats = createAccountService({
    getProviders: () => [{ id: "zcode" }, { id: "minimax" }, { id: "minimax-cn" }],
    credentials: { resolve: async () => undefined },
    deps: { includeLegacyProviders: false, creditBalance: () => ctx.creditBalance },
  });
  const missing = await stats.get("zcode");
  assert.equal(missing.status, "unsupported");
  const connection = mount();
  await settle();
  assert.ok(ctx.creditBalance, "真实 Cordis 必须能发现宿主服务");
  assert.equal(ctx.creditBalance.supportedProviders().some((p) => p.id === "opencode"), false, "通道可用数不是 Go 额度");
  const views = await stats.providerViews();
  for (const id of ["minimax", "minimax-cn"]) {
    assert.equal(views.find((p) => p.id === id)?.adapter, "minimax-token-plan", "服务不能抢占原生 MiniMax 路由");
  }
  assert.equal(resolveAccountSpec({ id: "minimax" }, { monitors: { minimax: { adapter: "codearts-credits" } } }).adapter, "codearts-credits");
  const reading = await stats.get("zcode");
  snapshots.push(reading);
  assert.equal(reading.status, "ok");
  assert.deepEqual(reading.windows.map((w) => [w.label, w.amount, w.usedPercent, w.unit]), [
    ["GLM A", 750000, 25, "token"], ["GLM B", 125000, 75, "token"],
  ]);
  assert.deepEqual(reading.partial, ["unknown"], "单号失败保留其他账号的读数");
  assert.ok(supplierReads > 0);
  assert.ok(hostCredentialReads.every((ref) => ["ZCODE_ALPHA", "ZCODE_BETA"].includes(ref)), "读取范围必须留在已选供应商");
  failAll = true;
  const stale = await stats.get("zcode", { force: true });
  snapshots.push(stale);
  assert.equal(stale.status, "unavailable");
  assert.equal(stale.stale, true);
  assert.equal(stale.windows[0].amount, 750000, "失败时只保留此前安全读数");
  await connection.dispose();
  await settle();
  const removed = await stats.get("zcode");
  snapshots.push(removed);
  assert.equal(removed.status, "unsupported");
  assert.deepEqual(removed.windows, [], "移除服务后必须失效旧实例余额");
  failAll = false;
  remaining = 500000;
  mount();
  await settle();
  const replaced = await stats.get("zcode");
  snapshots.push(replaced);
  assert.equal(replaced.status, "ok");
  assert.equal(replaced.windows[0].amount, 500000);
  const empty = await stats.get("buddy");
  assert.equal(empty.status, "not-configured");
  snapshots.push(empty);
  const exported = jsonExport({}, await stats.providerViews());
  const text = JSON.stringify({ snapshots, exported, views });
  for (const secret of secrets) assert.equal(text.includes(secret), false, "登录标识与凭据不得进入快照、视图或导出");
  console.log("PROVIDERS HUB INTEGRATION PASSED: real Cordis, real Host balance dispatch, anonymous projection, stats cache/export, supplier isolation, native MiniMax, late load/remove/reload, partial/stale/empty accounts");
} finally {
  for (const fork of forks.reverse()) await fork.dispose();
  globalThis.fetch = originalFetch;
  if (previousStateDir === undefined) delete process.env.DSH_JET_HUB_STATE_DIR;
  else process.env.DSH_JET_HUB_STATE_DIR = previousStateDir;
  await rm(stateDir, { recursive: true, force: true });
}
