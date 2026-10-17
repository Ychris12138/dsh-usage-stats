# PR #128 independent integration review — 2026-10-17

Status: BLOCKED. No merge, release, version change, or real-account acceptance performed.

## Pinned evidence

- usage-stats main: da11021f432ab7de836704e09acd9e6024fd34e7 (branch API and Git clone agree).
- PR head: 46fc0cfa9961a840f7a6cbba34bbe67ef2f33969; open, conflicting.
- Follow-up: e33e8006a6cfd23bd800d45d5d9ec04979c6f4c2.
- New upstream cloned successfully from https://gitee.com/iJetLi/deepseek-harness-codearts.git at 1266165baf6cc2918a06ac35a2df472980c89d6e.
- Upstream package is dsh-providers-hub@0.2.0-rc.11. Repository README says it is not published to npm; Git/local installation is supported.
- Full src search finds no creditsBalances, supportedProviders, or creditBalance service registration. CreditBalance type references are not a service.
- src/index.ts registers accountPool; src/jet-hub-rpc.ts has internal credits.balances and usageBadge calls it directly. Its shared cache, credential refresh, sequential account processing and special provider branches already exist.

Conclusion: missing public cross-plugin contract at this exact upstream commit. A small companion bridge is feasible, but is a proposal until upstream builds, tests, publishes a pinned installable revision, and accepts it. Do not infer support from internal RPC or the CreditBalance type.

## Follow-up review

Git ancestry proves original contributor commit 83e0b6f and PR head 46fc0cf are retained. Merge 9758a8c has parents 46fc0cf and da11021; current main is an ancestor of follow-up. Fast-forwarding the author's branch to follow-up resolves the current conflict without rewriting author attribution.

Compared with original PR head, follow-up is ahead by five commits, behind by zero. Changes include main's Command Code/release work plus quota normalization and expired package fixes; these unrelated main changes are ancestry, not new CodeArts scope.

Reviewed consumer behavior:
- Existing MiniMax registry collisions retain token-plan ownership; explicit monitors select CodeArts.
- New service-supplied routes carry accountService marker; no missing-connection heuristic.
- Credentials remain in Host; lookup is lazy.
- Unknown/negative/malformed amounts are not invented as zero. Partial packages and aggregate fallback do not double count.
- Expired packages retain known consumption but do not affect active minimum/alerts.
- Stale/error accounts are excluded from fresh windows; caught errors become fixed codes.
- Service discovery assumes supportedProviders is synchronous and well formed. This must be part of the published contract; an incompatible throwing/noniterable discovery implementation can disrupt specs().
- Existing registered routes, including newly added upstream routes, may need explicit adapter configuration. Do not assume every Hub route is automatically classified.

## Independently executed verification

npm ci --ignore-scripts and npm run check passed.
CodeArts standalone suite passed all 53 cases.
Full npm test did NOT complete green: test:accounts failed at synchronous pinned failure child spawnSync timeout (ETIMEDOUT, five seconds), and an isolated retry also failed. Earlier suites ran before that failure; test:install was run separately and passed. Eleven suites before test:accounts completed.
This is neither real-account validation nor proof all fourteen suites pass in this environment. The same test script on main passed in the same environment (no script diff), so the failure cannot yet be dismissed as environmental or baseline. Keep the full-suite gate open pending diagnosis and a reproducible green run. Do not increase timeouts merely to conceal a hang.

## Minimal upstream contract proposal (not an implemented/released service)

Register ctx.provide('creditBalance', service) in the Host RPC assembly scope after the same provider implementations and internal handleMethod exist. Use a typed service interface in upstream types and the same disposal mechanism as existing Host services. Do not add HTTP access, scrape private RPC from usage-stats, export tokens, or duplicate provider protocol code.

```ts
interface CreditBalanceServiceV1 {
  supportedProviders(): readonly { id: string; displayName: string }[];
  creditsBalances(providerId: string): Promise<{
    accounts: readonly {
      accountId: string; // opaque local id, not credentialRef/email
      nickname: string; // explicit user-facing label
      balance: {
        total: number; // CURRENT available remainder, not lifetime entitlement
        packages: readonly {
          name: string;
          total?: number;
          used?: number;
          remaining?: number;
          active?: boolean;
          unit?: string;
          expiredTime?: string;
          deductionEndTime?: string;
        }[];
        unit?: string;
      } | null;
      stale?: boolean;
      at?: number; // epoch milliseconds of actual reading
      error?: 'unavailable' | 'invalid-response' | 'auth-required';
    }[];
  }>;
}
```

Implementation sequence:
1. Derive supported providers dynamically from actual wired credit implementations plus supported special branches. Filter to real balance semantics; opencode's local channel count must be explicitly labelled or excluded. Avoid a second hand-maintained provider list. Use product/auth display names, not descriptor displayName that upstream marks non-authoritative.
2. Validate provider membership before any account/credential access. Unknown ids (including prototype keys) throw Error with name UnsupportedProviderError and a fixed safe message.
3. Reuse handleMethod('credits.balances', { provider }) exactly as usageBadge already does. Unwrap {ok:true,value:{accounts}}; never return the RPC wrapper to usage-stats. Reject failed/malformed envelopes using fixed errors.
4. Allowlist-copy output fields and nested package fields; never spread raw RPC/account/credential objects. Omit extra, credentialRef, tokens, headers, endpoints and raw error strings.
5. Existing collector represents stale cache through a nonempty error string, without a structured stale flag in RpcCreditsBalanceAccount. For the initial bridge, conservatively map ANY account error to balance:null + safe error. This sacrifices stale display but prevents stale data being labelled fresh. A later structured stale/at addition can expose historical readings safely; do not parse localized error text.
6. Preserve existing sequential queries, self-heal and shared cache. Avoid force:true on routine polling. Add single-flight for concurrent calls per provider without retaining successful snapshots outside the authoritative cache.
7. Runtime-test actual ctx service registration, both plugin load orders, unload/reload, sync discovery shape, unsupported ids, no-account, valid zero, errors/secrets, stale cache and provider collision. A standalone mock mapper test cannot establish that the real Host registered the service.

## Executable two-plugin acceptance procedure

Use a dedicated DSH profile and the same supported Host version for both plugins. Keep normal profiles untouched. Operator must supply a real account interactively; do not copy credentials into fixtures, logs or Git.

```sh
# In usage-stats checkout, pinned follow-up:
git checkout --detach e33e8006a6cfd23bd800d45d5d9ec04979c6f4c2
npm ci --ignore-scripts
npm run check
npm test

# In upstream checkout, first checkout the future published bridge revision:
pnpm install --frozen-lockfile
pnpm build:all
pnpm typecheck
pnpm test

# Install built local directories into an isolated, operator-created profile:
dsh plugin --profile codearts-review install /absolute/path/to/dsh-providers-hub
dsh plugin --profile codearts-review install /absolute/path/to/dsh-usage-stats
```

Use the repository's supported Host startup procedure for codearts-review. Confirm both dependencies and dsh.profile.bundles use the current dsh-providers-hub package name. A successful install alone is not activation evidence.

Set explicit monitor where a provider id already exists:
```yaml
monitors:
  codearts:
    adapter: codearts-credits
```
For a Hub-owned minimax route, set the same adapter under monitors.minimax deliberately. Separately test a native API-key MiniMax profile without that override.

Acceptance matrix:
- Inspect actual ctx.get('creditBalance') in Host-side diagnostic context: two methods exist, discovery is synchronous, CodeArts listed.
- No account: not-configured, never zero. Log in through Jet Hub; compare same account/package current remainder and expiry between Hub and usage-stats within cache TTL.
- Query true zero (if available), multiple accounts and mixed valid/failed accounts; absent scenarios remain explicitly NOT TESTED.
- Disable network after successful query; old Host data must not become a fresh successful usage-stats reading. Restore network and verify recovery.
- Restart in both plugin orders; unload/reload Hub; service disappearance degrades safely and return recovers.
- Native MiniMax API-key route remains token-plan with Hub absent/present. Explicit Hub MiniMax override reads Hub balance.
- Inspect browser snapshots/export and diagnostic surfaces for credential/endpoint/raw-error leakage, without recording real secrets.
- Record Host version, OS, plugin package versions AND commit SHAs, activation evidence, timestamps, redacted comparison values, matrix result and untested cases. Existing upstream test:e2e:codearts-credits checks provider query only; it cannot substitute for this dual-plugin matrix.

## Contributor branch and safe merge path

A fresh non-force, expected-head update to the contributor branch was attempted in this review. GitHub returned FORBIDDEN: Resource not accessible by integration. This is an integration permission failure, not a merge conflict; do not force push or repeatedly retry equivalent API writes.

Preferred path: contributor (or an identity with fork write access) runs:
```sh
git fetch origin feat/codearts-credits-balance
git switch feat/codearts-credits-balance
git fetch https://github.com/Ychris12138/dsh-usage-stats.git fix/codearts-credits-followup
git merge --ff-only FETCH_HEAD
git push origin HEAD:feat/codearts-credits-balance
```
First verify origin points to fengs2021/dsh-usage-stats and its head is still 46fc0cf. If it changed, review new commits and merge normally on an isolated branch; never overwrite new work.

Alternative if fork access remains unavailable: open a replacement DRAFT PR from the maintainer follow-up branch, explicitly linking #128 and crediting fengs2021/xuexi-bot. Keep 83e0b6f and all descendants as ancestry; use a merge commit when eventually integrating, rather than squash/rebase, to preserve original commit objects. Do not close #128 until replacement is accepted. No replacement PR was opened by this review.

Merge gates, all mandatory:
1. Public installable upstream bridge revision with declared stable contract and compatibility range.
2. Actual two-plugin real-account acceptance with redacted evidence.
3. Full checks pass on exact candidate SHA against then-current main.
4. Original author commit retained; contributor branch fast-forwarded or replacement PR reviewed.
5. Explicit later release decision. This work remains outside v0.3.6; package version stays 0.3.5.
