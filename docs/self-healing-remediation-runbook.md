# Self-healing remediation: operator configuration and runbook

## Configuration

### Error source configuration
- `inScopeErrorSources`: choose from `ci`, `runtime`, `lint`, `typecheck`, `test`.
- Recommendation for v1: include all five sources to maximize recoverable failures.

### Validation policy
- `validation.checks`: map of named checks (`lint`, `typecheck`, `test`) with `required` flags.
- `validation.stopOnRequiredFailure`: set to `true` to hard-stop PR creation if required checks fail.
- Repository command overrides are supported through `resolveValidationCommands` inputs.

### Remediation boundaries
- `remediationScope.allowedPathPrefixes`: default `src/` and `tests/`.
- `remediationScope.deniedPathPrefixes`: default `node_modules/` and `.git/`.
- `remediationScope.allowDependencyChanges`: defaults to `false`.
- `remediationScope.maxFilesChanged` and `maxLinesChanged` limit patch size.

### Runtime guardrails and retries
- `retry.maxAttempts` and `retry.backoffMs` configure retry behavior.
- `guardrails.maxRemediationDurationMs` bounds total attempt runtime.
- `guardrails.validationTimeoutMs` bounds validation execution windows.
- `guardrails.maxConcurrentAttempts` prevents noisy parallel attempt bursts.

## Monitoring guidance

Track these lifecycle statuses in logs/events:
1. `detected`
2. `remediating`
3. `validating`
4. `opened`
5. `failed`

Recommended dashboards:
- Success rate: opened / detected attempts.
- Validation pass rate: successful validation / total validations.
- Mean time to PR: average `timeToPrMs` for opened events.

## Triage and incident handling

1. Check duplicate suppression decisions (`fingerprintId`) before investigating repeated failures.
2. If an attempt fails in remediation, inspect patch-safety denial reasons first.
3. If validation fails, use command output in PR body or event metadata to route to owners.
4. Escalate blocked errors (`PANIC`, `SECURITY`, `OUTAGE`) to manual triage immediately.

## Rollback / disable procedure

1. Disable autonomous attempts by setting `inScopeErrorSources` to an empty list.
2. Optionally set all validation checks to required + failing placeholder command to force hard-stop.
3. Reduce risk rapidly by lowering `retry.maxAttempts` to `1` and `maxConcurrentAttempts` to `1`.
4. Re-enable incrementally (source-by-source) once metrics stabilize.

## Launch checklist and post-release metric review

- [ ] Confirm repository validation commands are configured and executable.
- [ ] Confirm patch scope allow/deny prefixes match repository layout.
- [ ] Confirm duplicate PR lookup is wired to open PR source of truth.
- [ ] Confirm lifecycle events are shipped to logging/metrics backend.
- [ ] Confirm dashboards for success rate, validation pass rate, and time-to-PR are live.
- [ ] Confirm runbook ownership and escalation rota.

Post-release (weekly for first month):
- Review auto-fix PR creation rate against 60% target.
- Review first-pass validation pass rate and top failure commands.
- Review mean time to PR trend and regressions.
- Sample merged PR quality and rollback frequency.
