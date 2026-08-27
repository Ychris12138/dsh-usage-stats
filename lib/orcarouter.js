/**
 * Optional OrcaRouter provider preset and its narrow DSH settings mutation.
 *
 * The plugin never edits settings.yaml directly and never installs this route
 * during startup. A caller must explicitly request the single path mutation;
 * an existing `orcarouter` profile always wins unchanged.
 *
 * @module dsh-usage-stats/orcarouter
 */

const SETTINGS_NAMESPACE = "llm-pi-ai";
const PROVIDER_ID = "orcarouter";

export const ORCAROUTER_PROFILE = Object.freeze({
	displayName: "OrcaRouter",
	apiKeyEnv: "ORCAROUTER_API_KEY",
	api: "openai-completions",
	baseURL: "https://api.orcarouter.ai/v1",
	models: Object.freeze([Object.freeze({ id: "orcarouter/auto", name: "OrcaRouter Auto" })])
});

function descriptorOf(settings) {
	if (typeof settings?.describe !== "function") return null;
	const descriptors = settings.describe({ redactSecrets: true });
	if (!Array.isArray(descriptors)) return null;
	return descriptors.find((entry) => entry?.ns === SETTINGS_NAMESPACE) ?? null;
}
function hasOrcaRouter(descriptor) {
	const providers = descriptor?.value?.providers;
	return providers !== null && typeof providers === "object" && !Array.isArray(providers)
		&& Object.hasOwn(providers, PROVIDER_ID);
}

/** Secret-free availability state suitable for the browser integration card. */
export function orcaRouterIntegrationState(settings) {
	const descriptor = descriptorOf(settings);
	const available = descriptor !== null && typeof settings?.mutate === "function" && settings.writable !== false;
	return {
		available,
		installed: descriptor !== null && hasOrcaRouter(descriptor)
	};
}

function detachedProfile() {
	return {
		displayName: ORCAROUTER_PROFILE.displayName,
		apiKeyEnv: ORCAROUTER_PROFILE.apiKeyEnv,
		api: ORCAROUTER_PROFILE.api,
		baseURL: ORCAROUTER_PROFILE.baseURL,
		models: ORCAROUTER_PROFILE.models.map((model) => ({ ...model }))
	};
}

/**
 * Add the preset with one revision-guarded path mutation. This preserves all
 * unrelated providers and converges cleanly if another writer adds the same
 * route between our read and write.
 */
export async function addOrcaRouterPreset(settings) {
	const before = descriptorOf(settings);
	const available = before !== null && typeof settings?.mutate === "function" && settings.writable !== false;
	if (!available) return { available: false, installed: hasOrcaRouter(before), added: false };
	if (hasOrcaRouter(before)) return { available: true, installed: true, added: false };

	try {
		await settings.mutate(SETTINGS_NAMESPACE, [{
			op: "set",
			path: ["providers", PROVIDER_ID],
			value: detachedProfile()
		}], before.revision);
		return { available: true, installed: true, added: true };
	} catch (error) {
		if (error?.code === "SETTINGS_CONFLICT") {
			const after = descriptorOf(settings);
			if (hasOrcaRouter(after)) return { available: true, installed: true, added: false };
		}
		throw error;
	}
}
