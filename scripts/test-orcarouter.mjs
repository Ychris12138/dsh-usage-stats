import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
	addOrcaRouterPreset,
	ORCAROUTER_PROFILE,
	orcaRouterIntegrationState
} from "../lib/orcarouter.js";

const exactProfile = {
	displayName: "OrcaRouter",
	apiKeyEnv: "ORCAROUTER_API_KEY",
	api: "openai-completions",
	baseURL: "https://api.orcarouter.ai/v1",
	models: [{ id: "orcarouter/auto", name: "OrcaRouter Auto" }]
};

assert.deepEqual(ORCAROUTER_PROFILE, exactProfile, "the built-in profile must match the documented OrcaRouter contract exactly");
assert.equal(Object.hasOwn(ORCAROUTER_PROFILE, "apiKey"), false, "the preset must reference an environment slot, never contain a key value");

function settingsFixture(initialProviders = {}, { conflictOnce = false } = {}) {
	let revision = 7;
	let providers = structuredClone(initialProviders);
	let mutateCalls = 0;
	let sawRedactedDescribe = false;
	return {
		get providers() { return providers; },
		get mutateCalls() { return mutateCalls; },
		get sawRedactedDescribe() { return sawRedactedDescribe; },
		describe(options) {
			sawRedactedDescribe ||= options?.redactSecrets === true;
			return [{ ns: "llm-pi-ai", revision, value: { providers: structuredClone(providers) } }];
		},
		async mutate(ns, ops, expectedRevision) {
			mutateCalls += 1;
			assert.equal(ns, "llm-pi-ai");
			assert.equal(expectedRevision, revision, "writes must carry the descriptor revision");
			assert.deepEqual(ops, [{
				op: "set",
				path: ["providers", "orcarouter"],
				value: exactProfile
			}], "only the OrcaRouter provider path may be written");
			if (conflictOnce && mutateCalls === 1) {
				providers.orcarouter = structuredClone(exactProfile);
				revision += 1;
				const error = new Error("settings moved");
				error.code = "SETTINGS_CONFLICT";
				throw error;
			}
			providers.orcarouter = structuredClone(ops[0].value);
			revision += 1;
		}
	};
}

{
	const settings = settingsFixture({
		company: { displayName: "Company gateway", baseURL: "https://relay.invalid/v1" }
	});
	assert.deepEqual(orcaRouterIntegrationState(settings), { available: true, installed: false });
	const result = await addOrcaRouterPreset(settings);
	assert.deepEqual(result, { available: true, installed: true, added: true });
	assert.deepEqual(settings.providers.company, { displayName: "Company gateway", baseURL: "https://relay.invalid/v1" }, "unrelated llm-pi-ai providers must survive the path mutation");
	assert.deepEqual(settings.providers.orcarouter, exactProfile);
	assert.equal(settings.sawRedactedDescribe, true, "settings descriptors must always be requested with secret redaction");

	const second = await addOrcaRouterPreset(settings);
	assert.deepEqual(second, { available: true, installed: true, added: false });
	assert.equal(settings.mutateCalls, 1, "repeated adds must be idempotent");
}

{
	const custom = {
		displayName: "My Orca gateway",
		apiKeyEnv: "COMPANY_ORCA_KEY",
		api: "openai-responses",
		baseURL: "https://orcarouter-proxy.invalid/v1",
		models: [{ id: "custom/model", name: "Custom" }]
	};
	const settings = settingsFixture({ orcarouter: custom, keep: { displayName: "Keep me" } });
	const result = await addOrcaRouterPreset(settings);
	assert.deepEqual(result, { available: true, installed: true, added: false });
	assert.deepEqual(settings.providers.orcarouter, custom, "an existing OrcaRouter profile must never be normalized or overwritten");
	assert.equal(settings.mutateCalls, 0);
}

{
	const settings = settingsFixture({}, { conflictOnce: true });
	const result = await addOrcaRouterPreset(settings);
	assert.deepEqual(result, { available: true, installed: true, added: false }, "a concurrent equivalent add must converge idempotently");
}

assert.deepEqual(orcaRouterIntegrationState({ describe: () => [] }), { available: false, installed: false });

const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
assert.match(readme, /https:\/\/www\.orcarouter\.ai\/ref\/ref_13c34663d1527ac16963/);
assert.match(readme, /OrcaRouter sponsors this project and is available as an optional OpenAI-compatible provider\./);
assert.match(readme, /Powered_by-OrcaRouter-2563eb/);
assert.match(readme, /available as an optional OpenAI-compatible provider[\s\S]{0,160}Referral link\./);
assert.doesNotMatch(readme, /^### .*OrcaRouter/im, "the compact sponsorship disclosure must not grow into a separate marketing section");
assert.match(readme, /POST` \| `\/api\/usage-stats\/integrations\/orcarouter/);
const security = await readFile(new URL("../SECURITY.md", import.meta.url), "utf8");
assert.match(security, /X-DSH-Usage-Stats-Action: add-orcarouter/);
assert.match(security, /plugin startup never performs this write/);

console.log("ORCAROUTER PRESET + SETTINGS INTEGRATION TESTS PASSED");
