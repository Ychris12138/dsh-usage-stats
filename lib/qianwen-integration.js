import { createQianwenAuth } from "./qianwen-token-plan.js";

export const QIANWEN_AUTH_REF = "QIANWEN_TOKEN_PLAN_AUTH";

/** All login state and tokens remain server-side; the client sees only the official verification URL. */
export function createQianwenIntegration({ credentials, auth = createQianwenAuth() }) {
	let busy = false;
	return {
		async action(action) {
			if (busy) return { status: "busy" };
			if (!["start", "poll", "disconnect"].includes(action)) return { status: "unsupported" };
			if (!credentials || typeof credentials.set !== "function" || typeof credentials.resolve !== "function") return { status: "storage-unavailable" };
			busy = true;
			try {
				if (action === "start") {
					auth.cancel();
					const started = await auth.start();
					return { status: "pending", verificationUrl: started.verificationUrl, expiresIn: started.expiresIn };
				}
				if (action === "disconnect") {
					if (typeof credentials.unset !== "function") return { status: "storage-unavailable" };
					auth.cancel();
					await credentials.unset(QIANWEN_AUTH_REF);
					const existing = await credentials.resolve(QIANWEN_AUTH_REF);
					return { status: existing?.value ? "storage-shadowed" : "disconnected" };
				}
				const outcome = await auth.poll();
				if (outcome.status !== "complete") return { status: outcome.status };
				const value = JSON.stringify(outcome.credential);
				await credentials.set(QIANWEN_AUTH_REF, value);
				const resolved = await credentials.resolve(QIANWEN_AUTH_REF);
				return { status: resolved?.value === value ? "connected" : "storage-shadowed" };
			} catch (error) {
				return { status: error?.code === "qianwen-no-pending-login" ? "expired" : "unavailable" };
			} finally { busy = false; }
		},
		cancel() { auth.cancel(); }
	};
}
