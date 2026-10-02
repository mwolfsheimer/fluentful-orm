# Backend evidence and fidelity

Historical test evidence is not a promise that every DynamoDB behaviour is simulated locally. Check the [backend limits](../guides/local-storage.md) and date of each live run.

| Behavior | Offline evidence | Real-service evidence |
| --- | --- | --- |
| Request construction, cancellation, cached terminals, retries/recovery | Fake SDK and type tests | Live verification pending |
| Structured updates, sparse returns, atomic reads, multi-key indexes, ordered base-query changed-record cursors | Shared memory contract | Shared AWS contract passed in eu-west-2 on 2026-10-02 |
| Changed-record index-query and table/index scan cursors, including parallel scans | Shared memory contract; deterministic ordering/validation and file/IndexedDB reopening regressions | Shared AWS contract passed all 105 tests in eu-west-2 on 2026-10-02, including deletion, index-key movement, sparse exit and segmented continuation |
| Durable values and index metadata | File and IndexedDB tests; packaged Chromium smoke | Not an AWS persistence model |
| Item/page/transaction/batch/expression byte limits | Not simulated in memory | AWS-only assertions passed in eu-west-2 on 2026-10-02; large fixture writes are paced |
| Throttling and transaction conflicts | Injected failures only | Observed 60 conflicts in 100 requests and 714 throttle responses in 1000 requests in eu-west-2 on 2026-10-02 |
| Eventual consistency | Memory is immediately consistent | GSI tests poll convergence; never require observing stale data |
| TTL | Configuration request/type tests; memory rejects it | Follow-up bounded probe passed in eu-west-2 on 2026-10-02: expired record deleted, future-expiry control retained |

The latest shared AWS contract run (`npm run test:integration`, `AWS_REGION=eu-west-2`, `ORM_AWS_PROBE` unset, `ORM_AWS_TIMEOUT_SECONDS=600`) passed all 105 tests with no failures or skips on 2026-10-02. This includes the new changed-record index-query and table/index scan cases, ascending/descending index-key movement, sparse exit, duplicate index values, and parallel-scan continuation. The earlier 103-test run on the same date preceded these additions. Live failures first identified and corrected memory differences in sparse list images, duplicate transaction reads, and empty transaction projections. These results establish evidence for the tested cases, not exhaustive service parity.

Dedicated stress probes on the same date observed 40 completed writes and 60 conflicts (100 requests), and 286 completed writes and 714 throttle responses (1000 requests), with concurrency <= 8 and SDK retries disabled. An initial 1000-request conflict attempt failed on an unexpected AWS HTTP 500 `InternalServerError`; the fresh 100-request run passed. These stress probes were not repeated in the latest cursor/TTL verification.

The initial TTL probe completed with a 600-second workload deadline and a maximum of 60 polls, but observed no deletion and was marked inconclusive (one skipped test, no failures). A follow-up on 2026-10-02 in eu-west-2 (`npm run test:integration`, `ORM_AWS_PROBE=ttl`, `ORM_AWS_TIMEOUT_SECONDS=600`, `ORM_AWS_MAX_REQUESTS=60`) passed: a strongly consistent read observed the expired numeric-seconds record absent while the future-expiry control remained present. The test, including cleanup, took approximately 445 seconds, with one pass and no failures or skips. Cleanup completed and a separate table listing found no tables remaining from the latest contract/TTL runs. This verifies an actual asynchronous TTL deletion, not a guaranteed expiry deadline; memory still does not simulate TTL, and a future probe without an observed deletion must remain inconclusive.

---

[Documentation home](../index.md) · [Documentation map](../reference/api.md)
