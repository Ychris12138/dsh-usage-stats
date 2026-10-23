# Providers Hub credit-balance integration

PR #128 depends on a Host-owned Cordis service named `creditBalance`. This is a cross-plugin service, not an HTTP route or a browser RPC. Providers Hub owns authentication, signing, refresh and account selection; Usage Stats receives only projected balance data.

## Current status (2026-10-23)

The latest public npm archive, `dsh-providers-hub@2.1.261022`, was independently downloaded and verified against registry integrity:

```text
sha512-GEqoEoMGy0dJ4eiWefoeIzOo525KRcdCSqad24zryYMH+txHicPJ24APAWdl8+icFY1eLAwIh+dkZA8VZxeuaQ==
```

None of its 461 JavaScript/TypeScript/JSON/Markdown files contains `creditBalance`, `creditsBalances` or `supportedProviders`. Installing the current official package does not satisfy this integration.

Upstream [#4](https://github.com/iJetLi/dsh-providers-hub/pull/4) was superseded by [#9](https://github.com/iJetLi/dsh-providers-hub/pull/9); #9 is now closed without merging. In the [2026-10-22 maintainer response](https://github.com/iJetLi/dsh-providers-hub/pull/9#issuecomment-6339239309), the maintainer declined external data provision of login information for now. That response does not establish approval for the anonymous balance projection proposed here. A supported service design and release must not be assumed forthcoming.

The source and runtime patches below are historical experiments for their named baselines, not patches for the current package. Their synthetic integration checks do not establish current official-package or real-account acceptance. Before resuming stable-support work, settle the supported public projection with upstream and identify its exact supported build; then exercise actual sibling-plugin visibility and connection removal/reload in an isolated Host.

## Historical preparation (2026-10-20)

The official npm archive `dsh-providers-hub@1.9.261020` was downloaded with its registry SHA-512 verified. Its published JavaScript/TypeScript/JSON/Markdown files contain no `creditBalance`, `creditsBalances` or `supportedProviders` service implementation. Installing this version alone therefore does not satisfy this integration. A green Usage Stats mock suite is not two-plugin or real-account acceptance.

The maintainer follow-up retains the original contributor commits, merges the complete 0.3.6 mainline, and preserves native MiniMax/Z.ai/DeepSeek behavior. Services that load late can become available; replaced/removed services invalidate cached balances, while Cordis traceable proxies preserve normal caching. Bad optional provider lists do not block unrelated accounts.

A concrete companion is now implemented against official Gitee commit `4c428487bd75e0a02d7b4faa789e456ff44955e0`: [Host source patch](../integrations/providers-hub/credit-balance-service-4c42848.patch). It registers the projection through the Host's existing balance dispatcher. Host/client builds and 31 new projection/lifecycle tests pass. The real Cordis + real Host dispatcher + Usage Stats integration passes with synthetic supplier readings; reproduce with `npm run test:providers-hub -- /absolute/path/to/built/hub`. This is stronger than a mocked service contract, but is still not real supplier/account acceptance or a publicly released upstream service.

The same service is also ported to the verified npm `1.9.261020` runtime: [exact-version runtime patch and reproduction](../integrations/providers-hub/README.md). Both source and published-runtime candidate tarballs pass the same real-Cordis integration after unpacking. The full upstream suite has 16 failures reproduced unchanged on the official baseline; see the reproduction notes rather than treating it as a complete green upstream run.

## Required public service

```ts
interface CreditBalanceService {
  supportedProviders(): Array<{ id: string; displayName: string }>
  creditsBalances(providerId: string): Promise<{
    accounts: Array<{
      accountId: string
      nickname?: string
      stale?: boolean
      error?: string
      balance?: {
        total?: number
        unit?: string
        packages?: Array<{
          name?: string
          remaining?: number
          total?: number
          used?: number
          active?: boolean
          unit?: string
          expiredTime?: string
          deductionEndTime?: number // milliseconds
        }>
      } | null
    }>
  }>
}
```

Publish one stable service instance for the lifetime of the plugin, using `ctx.provide('creditBalance', service)`. `supportedProviders()` is synchronous and lists only routes whose balances the service can query. Do not auto-claim an existing native route such as `minimax`; Usage Stats retains existing registrations, and a collision requires an explicit `codearts-credits` monitor.

`creditsBalances()` performs a balance read through the existing Host-owned pipeline. It must not log in, select another default account or claim rewards. Normal Host credential self-healing and cache updates may occur, exactly as on the Host's own balance screen; Usage Stats does not implement or own that refresh. Return `{ accounts: [] }` when there is no configured account. Unsupported routes may throw an `Error` whose name is `UnsupportedProviderError`. Other failures must use bounded safe errors; do not return raw request URLs, cookies, tokens, authorization headers, signed payloads or credential objects. Project only the fields above instead of returning internal RPC/account-pool records. Account IDs/nicknames must be response-local opaque labels, not login identifiers. Mark retained old balances `stale: true`; a failed account must not look like a fresh zero balance.

The Host's `opencode` balance-shaped value is a local channel-availability count. Exclude it from this service: it is neither an account balance nor Go subscription quota. Native MiniMax API Key routes retain their own adapters even when the Host can read MiniMax Code account-pool credits.

`balance.total` means aggregate **remaining** credits, matching the existing Providers Hub normalization; it is not a percentage denominator. Package `total` is its original quota, and `used` is consumption. An expired package may retain historical consumption, but its zeroed remainder does not imply 100% consumed. When upstream cannot provide an amount, omit it instead of inventing zero.

## Completion gates

0. Establish an accepted public projection and explicitly supported Host build. Upstream #9 was closed without merging; green consumer tests or historical companion patches do not resolve that decision.
1. Publish or explicitly install the exact companion Host build. A local candidate exists for isolated acceptance; the ordinary npm Hub release still does not implement the service.
2. Require CI on the chosen consumer and companion source heads. PR #144 already merged with the original #128 contributor history; that merge does not establish stable-support or real-account acceptance. Rewriting the inaccessible contributor fork is not required.
3. The automated real-Cordis integration covers missing service, late activation, native provider collisions, removal/replacement, multiple accounts, partial failures, stale fallback and empty accounts. Also verify both installed bundles in an isolated real DSH profile.
4. Use a real opted-in account to reconcile displayed packages and remaining amounts with its provider dashboard. No such account acceptance is currently claimed.

Until these gates are satisfied, keep the integration outside a stable release. Do not bypass Host ownership by scraping the authenticated browser RPC or reading another plugin's token store.
