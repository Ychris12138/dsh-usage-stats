# Providers Hub credit-balance integration

PR #128 depends on a Host-owned Cordis service named `creditBalance`. This is a cross-plugin service, not an HTTP route or a browser RPC. Providers Hub owns authentication, signing, refresh and account selection; Usage Stats receives only projected balance data.

## Current status (2026-10-20)

The official npm archive `dsh-providers-hub@1.9.261020` was downloaded with its registry SHA-512 verified. Its published JavaScript/TypeScript/JSON/Markdown files contain no `creditBalance`, `creditsBalances` or `supportedProviders` service implementation. Installing this version alone therefore does not satisfy this integration. A green Usage Stats mock suite is not two-plugin or real-account acceptance.

The maintainer follow-up retains the original contributor commits, merges the complete 0.3.6 mainline, and preserves native MiniMax/Z.ai/DeepSeek behavior. Services that load late can become available; replaced/removed services invalidate cached balances, while Cordis traceable proxies preserve normal caching. Bad optional provider lists do not block unrelated accounts.

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
          deductionEndTime?: string
        }>
      } | null
    }>
  }>
}
```

Publish one stable service instance for the lifetime of the plugin, using `ctx.provide('creditBalance', service)`. `supportedProviders()` is synchronous and lists only routes whose balances the service can query. Do not auto-claim an existing native route such as `minimax`; Usage Stats retains existing registrations, and a collision requires an explicit `codearts-credits` monitor.

`creditsBalances()` must perform only a balance read, without rotating credentials, selecting another default account or claiming rewards. Return `{ accounts: [] }` when there is no configured account. Unsupported routes may throw an `Error` whose name is `UnsupportedProviderError`. Other failures must use bounded safe errors; do not return raw request URLs, cookies, tokens, authorization headers, signed payloads or credential objects. Project only the fields above instead of returning internal RPC/account-pool records. Mark retained old balances `stale: true`; a failed account must not look like a fresh zero balance.

`balance.total` means aggregate **remaining** credits, matching the existing Providers Hub normalization; it is not a percentage denominator. Package `total` is its original quota, and `used` is consumption. An expired package may retain historical consumption, but its zeroed remainder does not imply 100% consumed. When upstream cannot provide an amount, omit it instead of inventing zero.

## Completion gates

1. The upstream service must be present in an installable Providers Hub build. Port the prepared companion to that exact build and add its own projection, provider allow-list, exception secrecy and account-isolation tests.
2. Update the original PR branch from the maintainer follow-up, preserving contributor history, then rerun its exact-head CI.
3. Install both exact plugin versions in an isolated profile. Check missing service, late activation, provider collisions, replacement/removal, multiple accounts, partial failures, expiry and normal refresh.
4. Use a real opted-in account to reconcile displayed packages and remaining amounts with its provider dashboard. No such account acceptance is currently claimed.

Until these gates are satisfied, keep the integration outside a stable release. Do not bypass Host ownership by scraping the authenticated browser RPC or reading another plugin's token store.
