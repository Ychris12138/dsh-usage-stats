import assert from "node:assert/strict";

import { resolveAccountSpec } from "../lib/accounts.js";
import { resolveProviderIdentity } from "../lib/provider-identity.js";
import { applyUsageDelta, createUsageState, currentSessionContext } from "../lib/usage.js";

function provider(id, baseURL, displayName = id) {
	return { id, displayName, ...(baseURL === void 0 ? {} : { baseURL }) };
}

function requestEvent(seq, providerId, model, time = Date.UTC(2026, 7, 23, 12, 0, seq)) {
	return {
		seq,
		time,
		type: "request/header",
		data: { header: { config: { provider: providerId, model } } }
	};
}

function assistantEvent(seq, providerId, model, time = Date.UTC(2026, 7, 23, 12, 1, seq)) {
	return {
		seq,
		time,
		type: "assistant/message",
		data: { message: { source: { kind: "model", provider: providerId, model } } }
	};
}

{
	const identity = resolveProviderIdentity(provider("deepseek-official", "https://relay.invalid/v1", "Anything"));
	assert.deepEqual(identity, {
		routeId: "deepseek-official",
		displayName: "Anything",
		providerFamily: "deepseek",
		accountAdapter: "deepseek-balance",
		pricingFamily: "deepseek",
		baseURL: "https://relay.invalid/v1",
		confidence: "canonical-id"
	});
}

{
	const identity = resolveProviderIdentity(provider("relay-a", "https://api.deepseek.com/v1", "Not DeepSeek"));
	assert.equal(identity.providerFamily, "deepseek");
	assert.equal(identity.accountAdapter, "deepseek-balance");
	assert.equal(identity.confidence, "canonical-host");
	assert.equal(resolveAccountSpec(provider("relay-a", "https://api.deepseek.com/v1")).adapter, "deepseek-balance", "AccountService must consume the shared resolver policy");
}

{
	const canonical = resolveProviderIdentity(provider("ollama", "https://ollama.com"));
	assert.equal(canonical.providerFamily, "ollama");
	assert.equal(canonical.accountAdapter, "ollama");
	assert.equal(canonical.confidence, "canonical-id");

	const exactHost = resolveProviderIdentity(provider("my-ollama", "https://ollama.com"));
	assert.equal(exactHost.providerFamily, "ollama");
	assert.equal(exactHost.accountAdapter, "ollama");
	assert.equal(exactHost.confidence, "canonical-host");

	const cloud = resolveProviderIdentity(provider("private-ollama-route", "https://api.ollama.com/v1"));
	assert.equal(cloud.providerFamily, "ollama");
	assert.equal(cloud.accountAdapter, "ollama");
	assert.equal(cloud.confidence, "canonical-host");

	for (const baseURL of ["http://localhost:11434", "http://127.0.0.1:11434", "http://[::1]:11434"]) {
		const local = resolveProviderIdentity(provider("ollama", baseURL, "Ollama Cloud"));
		assert.equal(local.providerFamily, "unknown", `${baseURL} must not be classified as Ollama Cloud`);
		assert.equal(local.accountAdapter, null);
		assert.equal(local.confidence, "unknown");
	}
	const customLoopback = resolveProviderIdentity(provider("my-ollama", "http://127.0.0.1:11434", "Ollama Cloud"));
	assert.equal(customLoopback.providerFamily, "unknown");
	assert.equal(customLoopback.accountAdapter, null);
}

{
	const unknown = resolveProviderIdentity(provider("custom-route", "https://relay.invalid/v1", "DeepSeek"));
	assert.equal(unknown.providerFamily, "unknown", "displayName alone must never drive identity");
	assert.equal(unknown.accountAdapter, null);
	assert.equal(unknown.pricingFamily, "unknown");
	assert.equal(unknown.confidence, "unknown");

	const malformed = resolveProviderIdentity(provider("custom-route", "not a URL", "Ollama"));
	assert.equal(malformed.providerFamily, "unknown");
	assert.equal(malformed.baseURL, "not a URL", "connection facts should be preserved without trusting them");

	const absent = resolveProviderIdentity(provider("custom-route", void 0, "DeepSeek"));
	assert.equal(absent.providerFamily, "unknown");
	assert.equal(absent.accountAdapter, null);
	assert.equal(absent.baseURL, null);
}

{
	const identity = resolveProviderIdentity(provider("deepseek", "https://api.deepseek.com"), {
		monitors: {
			deepseek: { providerId: "deepseek", adapter: "new-api", usageBaseURL: "https://usage.invalid" }
		}
	});
	assert.equal(identity.providerFamily, "new-api", "explicit monitor adapter must beat canonical id and host");
	assert.equal(identity.accountAdapter, "new-api");
	assert.equal(identity.pricingFamily, "unknown", "a gateway adapter does not prove the future model pricing family");
	assert.equal(identity.confidence, "explicit");

	const generic = resolveProviderIdentity(provider("deepseek", "https://api.deepseek.com"), {
		monitors: { deepseek: { providerId: "deepseek", adapter: "general" } }
	});
	assert.equal(generic.providerFamily, "unknown", "a generic account protocol must not masquerade as provider identity");
	assert.equal(generic.accountAdapter, "general");
	assert.equal(generic.pricingFamily, "unknown");
}

{
	const state = createUsageState();
	applyUsageDelta(state, [
		requestEvent(0, "route-a", "shared-model"),
		assistantEvent(1, "route-b", "shared-model")
	]);
	const context = currentSessionContext("session-1", state, provider("route-b", "https://api.deepseek.com"));
	assert.deepEqual(context, {
		sessionId: "session-1",
		providerId: "route-b",
		providerFamily: "deepseek",
		model: "shared-model",
		accountId: "route-b",
		updatedAt: Date.UTC(2026, 7, 23, 12, 1, 1)
	});
	assert.equal(state.currentModel, "route-a/shared-model", "session context must not change request-driven usage attribution state");

	applyUsageDelta(state, [requestEvent(2, "route-a", "shared-model")]);
	assert.equal(currentSessionContext("session-1", state, provider("route-a", "https://relay.invalid")).providerId, "route-a");
	assert.equal(state.currentModel, "route-a/shared-model", "same model on two routes must stay route-distinct");
}

{
	const state = createUsageState();
	assert.equal(currentSessionContext("empty", state, provider("deepseek")), null);
}

console.log("PROVIDER IDENTITY + SESSION CONTEXT TESTS PASSED");
