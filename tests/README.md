# Hana Test Policy

Hana uses risk-driven tests. Test value comes from protecting contracts and old-user safety, not from keeping a large file count.

## Test Layers

- `contract`: public behavior, architecture boundaries, permissions, and external protocols.
- `regression`: a real bug captured once. When the behavior stabilizes, merge it into a behavior-named contract test.
- `unit`: pure logic and small modules with stable inputs and outputs.
- `route`: HTTP or WebSocket boundaries, including auth, error shape, and resource scope.
- `build`: packaging, runtime assets, native dependencies, preload, and server bundle contracts.
- `platform`: path, shell, sandbox, and OS-specific behavior across macOS, Windows, and Linux.

## Keep Tests When

- They protect security, permissions, credentials, secrets, resource grants, or remote access.
- They protect cross-session or cross-agent ownership.
- They protect Resource, SessionFile, MediaItem, sidecar recovery, or legacy migration behavior.
- They protect build, packaged server runtime, native addons, preload output, or plugin runtime dependencies.
- They protect provider, Bridge, plugin, or other external protocol contracts.
- They protect cross-platform path, shell, sandbox, or source-launch behavior.
- They catch a historical bug that has not yet been absorbed into a stronger contract test.

## Delete Or Merge Tests When

- They only test temporary implementation details.
- They duplicate a stronger contract test.
- The old feature no longer exists and no migration or read compatibility remains.
- An issue-specific acceptance test has been absorbed by a permanent behavior-named contract.
- They only lock unstable copywriting instead of stable error type, code, or key fields.
- They mock private fields where a public API or service contract can express the behavior.

## Issue References

Keep issue references as short breadcrumbs when the file is already behavior-named and protects a long-term contract. Do not keep a test file named after an incident once the case can live inside the permanent contract.

For `migration #N` labels, treat the number as a durable data-version contract label rather than a GitHub issue reference.

## Required Validation

Run these before considering a cleanup complete:

```bash
npm test
npm run typecheck
npm run lint
```

For focused cleanup, run the affected test files first, then run the full validation set before commit or handoff.
