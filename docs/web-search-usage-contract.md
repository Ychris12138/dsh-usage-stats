# Auxiliary search usage integration

## Current upstream status (2026-10-29)

DSH master `f3803c96974ad4a94195fb97e5c637e9c2a3afe3` still does not emit or register `web/deepseek-search-usage`. Its Messages search provider records `web/deepseek-search-llm-request`, which is an input/request log, not evidence of consumed tokens. Usage Stats must not bill this request log.

DSH also now has a separate `web-deepseek-api` Search/Fetch provider. It performs a direct search operation without an auxiliary model turn. Search-operation fees are a different quantity from model tokens and are outside this PR; do not synthesize model usage from its query or result count.

PR #133 consumes an explicit response-usage event, retains dispatch identities across interleaved reports/restarts, and requires explicit reasoning-token semantics. Updating this consumer alone cannot recover usage absent from upstream session logs.

## Producer contract to finish upstream

```ts
type SearchUsageEvent = {
  eventId: string
  provider: string
  model: string
  usage: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  }
  reasoningTokensMode?: 'included' | 'additional'
}
```

Append it as `web/deepseek-search-usage` after receiving actual response usage. Use a stable unique identity per dispatch; a corrected sample with the same identity replaces the prior sample, while separate dispatches remain additive. Counts must be nonnegative finite safe integers. The consumer supports its documented camel/snake aliases and rejects contradictory aliases.

Capture the initiating Session before asynchronous credential/network work, and append to that same Session even if another Session becomes current. Attribute the actual auxiliary model and credential route: a DeepSeek Account grant belongs to `deepseek-account`; an API-key search belongs to the matching API provider. Never inherit the surrounding conversation's unrelated MiniMax/Z.ai route. Custom endpoints require explicit attribution rather than being assumed official DeepSeek pricing.

Positive reasoning details need `reasoningTokensMode`. Ordinary Messages output totals already include their output breakdown, so use `included` for that contract. Use `additional` only when the producer's actual wire semantics prove the count is extra. Do not add a detail twice. Missing or ambiguous usage must fail closed, not become guessed usage.

Only copy the bounded identity, provider/model, token counts and reasoning semantics. Do not append headers, API keys, account tokens, raw responses, prompts or signed request data to this usage event.

## Persistence and release gates

The Host must register and serialize the event, generate its event catalog/persistence acknowledgement, and define older-reader/downgrade behavior. An unknown required event cannot be treated as harmless without upstream acceptance.

This branch uses cache schema 11. Older folds are rebuilt from authoritative session logs because prior reasoning semantics must not remain additive. The consumer tests cover deduplication, correction, malformed samples, cache restart/migration, and cold replay from a synthetic disk-backed persistence seam through the usage and JSON-export handlers. These tests do not establish that a released DSH producer emits or persists the event.

Before removing Draft: publish the upstream event implementation; install exact Host and plugin versions in an isolated profile; run an actual opted-in auxiliary search; restart the Host from its real session archive; compare the panel and export to response usage and provider billing. Keep search-operation fees separate and preserve the conversation route. No live search/billing acceptance is currently claimed.

The draft is reconciled with main schema-10 inherited/compaction evidence ledgers and rankings. Search replacements use their own persisted ledger and the shared source-sample projection, so fork copies and interleaved compactions retain their accounting semantics. Schema 11 refolds readable older sources; opaque unavailable aggregates remain fallbacks. The missing upstream producer still prevents merge or stable release.
