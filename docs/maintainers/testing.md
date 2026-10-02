# Run library and backend tests

These commands are for contributors. For documentation checks, see [documentation maintenance](./documentation.md). Live AWS tests create resources and may incur charges.

From this package:

```powershell
npm test
```

The live DynamoDB integration suite creates and removes temporary tables in the selected AWS region. It uses the standard AWS SDK credential provider chain and defaults to `eu-west-2` when `AWS_REGION` is unset:

```powershell
$env:AWS_PROFILE = 'your-profile'; $env:AWS_REGION = 'us-east-1'; npm run test:integration
```

The default AWS workload deadline is 600 seconds (`ORM_AWS_TIMEOUT_SECONDS`, range 30-3600). Credential/`ListTables` preflight is mandatory; no memory suite substitutes for it. Permissions must cover temporary table create/describe/delete, data operations, and the operations selected by a probe. Cleanup uses a separate 120-second signal and reports possible orphan resources; interrupted processes can still leave resources requiring manual cleanup.

Opt-in probes use the same command with `ORM_AWS_PROBE=conflicts`, `throttling`, or `ttl`. Stress probes cap concurrency at eight, disable SDK retries, and default to 100 workload requests (`ORM_AWS_MAX_REQUESTS`, maximum 1000), plus setup/cleanup calls. Throttling uses a 1-read/1-write provisioned table. A probe with no observed target event is explicitly skipped as **INCONCLUSIVE**, not service-parity evidence. Unexpected failures fail the test.

TTL probes default to 60 polls, spaced ten seconds apart. Their deadline may be increased to 259200 seconds (three days), with at most 25920 polls; longer runs incur charges. They verify deletion of an expired numeric-seconds record while retaining a future-expiry control. Configure both the time and request budgets deliberately. No AWS account, role, or environment is provisioned by these scripts.

---

[Documentation home](../index.md) · [Documentation map](../reference/api.md)
