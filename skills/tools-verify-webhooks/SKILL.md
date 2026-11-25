---
name: tools-verify-webhooks
description: Formal check of webhook delivery in the tools repo. A TLA+ model of worker/webhooks.ts, run by TLC, proves that cron runs, first attempts and "Send again" never send one delivery at the same time, and that a recorded success stays recorded. Use before and after changing deliverDue, the cron in worker/index.ts, a tool's delivery insert or requeue, or the first-attempt call in a tool's api.ts.
---

# Verify webhook delivery

## What it proves

- **No concurrent sends.** At most one sender is sending a given delivery at any moment. If this breaks, coach or the nutrition bot gets the same delivery twice at once, and the two results race when they're written back.
- **A recorded success stays recorded.** Once a send to a delivery is recorded as delivered, only "Send again" can mark it undelivered. If this breaks, a failed duplicate overwrites a success, and the cron sends a delivery the receiver already has.

The model covers one delivery row, two overlapping cron runs, the request's first attempt, one "Send again", every receiver answer (2xx or not), a Worker dying at any step, and a claim expiring. TLC checks every order of those steps, and the run takes a few seconds.

## When to run it

Run it when a change touches any file in the coverage table below. A change elsewhere can't affect it.

## Run

```sh
bun run verify:webhooks
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres bun test worker/webhooks.postgres.test.ts
```

The first command downloads TLC 1.7.4 (pinned by sha256) into `node_modules/.cache/tla/` and needs Java 11 or newer. It checks six configs in `skills/tools-verify-webhooks/`:

| Config | Design | Expected |
| --- | --- | --- |
| `claim.cfg` | `worker/webhooks.ts` today. Each send first claims its row with `claim_id` and `claimed_until`, sends with no transaction open, then records the result only `where claim_id` still matches. A claim expires after its holder stops. | Both invariants hold. |
| `claim-slow.cfg` | The same claim, but a claim can also expire while its holder is still sending. The lease is 60 seconds and a send times out after 10, so this needs a stalled Worker. | `DeliveredStaysDelivered` holds. `NoConcurrentSends` isn't checked, because two senders can overlap here. |
| `claim-nofence-slow.cfg` | The claim with the `where claim_id` check removed. | `DeliveredStaysDelivered` fails. |
| `select.cfg` | The workouts draft before claims: a plain `select`, then send. This is the bug the workouts author caught. | `NoConcurrentSends` fails. |
| `lease.cfg` | Main before claims: a 5-minute lease in `next_attempt_at` that the first attempt and "Send again" ignored. | `NoConcurrentSends` fails. |
| `lease-stale.cfg` | The same lease. | `DeliveredStaysDelivered` fails. |

The command exits non-zero if `claim.cfg` or `claim-slow.cfg` breaks an invariant, or if a past design stops failing, because then the model can no longer catch that bug. CI runs it in the `checks` job, along with the Postgres test, which runs the real `deliverDue` against concurrent senders, "Send again" during a send, and a sender whose claim expired.

Read every TLC result with the pstack `/statechart` skill. It shows a violation as its shortest path in plain words, and it charts the states when the check passes.

## Model to code

| Model (`delivery.tla`) | Code |
| --- | --- |
| `Claim` in `claim` | `claimOne` in `worker/webhooks.ts`: one `update ... set claimed_until, claim_id ... returning` on a row that is undelivered and unclaimed or whose claim expired. A cron run needs `next_attempt_at <= now()`. A first attempt or "Send again" names the id in `only`. |
| `Send` | `webhookBody`, then `sendWebhook`, with no transaction open. A payload whose `event` the webhook's `envelope` doesn't declare skips the send and is recorded like a `Rejected` answer. |
| `Accepted`, `Rejected` | The `update` that records `attempts`, `delivered_at` and `next_attempt_at` and clears the claim, `where claim_id` is still this sender's. A sender whose claim was taken over writes nothing. |
| `Crash` | The Worker dies mid-send. The claim stays until `claimed_until` passes. |
| `ClaimExpires` | `claimed_until < now()`. With `SlowSenders`, that can happen while the holder is still sending. |
| `SendAgain` | `requeue` in `tools/workouts/store.ts`. It doesn't touch the claim. Its first attempt goes through `claimOne`, so while a send is in flight it claims nothing, and that send's result stands. If that send fails, the cron retries. |
| `TimePasses` | `next_attempt_at` comes due. Requests claim within a minute of their insert or requeue, so time can't pass while one is about to claim. |
| `cron1`, `cron2` | `scheduled` in `worker/index.ts`. A cron run sends up to 20 rows one at a time, so it can outlast the next minute's run. It first reads every outbox in one query (`dueWebhooks`) and skips an outbox with no due, unclaimed row. That read takes no lock and changes nothing, so a skip is the same as a `Claim` that finds no row. |

## Real bug or modeling error

When `claim.cfg` or `claim-slow.cfg` fails, find each step of the counterexample in the table. If every step matches code that exists, the code has the bug. Fix the code, not the model. If a step does something the code can't do, the model is wrong. Fix the model, and keep the past designs failing.

## Changing delivery on purpose

Change `delivery.tla` in the same PR as the code, so that `claim.cfg` and `claim-slow.cfg` describe the new code. Keep `claim-nofence-slow.cfg`, `select.cfg`, `lease.cfg` and `lease-stale.cfg` failing. Add a config for any new past bug you find. Then move the sync commit below forward.

## Coverage

| File | What the model covers |
| --- | --- |
| `worker/webhooks.ts` | `deliverSoon`, `deliverDue`, `claimOne`, `sendWebhook` |
| `worker/index.ts` | `scheduled` |
| `tools/workouts/store.ts` | `finishSession` (insert), `requeue` |
| `tools/workouts/migrations/0003-claim-deliveries.sql`, `tools/nutrition/migrations/0002-claim-deliveries.sql` | the claim columns |
| `tools/workouts/api.ts` | `deliverSoon` after finish and after redeliver |
| `tools/nutrition/store.ts` | `closeDayFromUi` (insert) |
| `tools/nutrition/api.ts` | `deliverSoon` after close |
| `tools/liaison/webhook.ts`, `tools/liaison/migrations/0001-create-deliveries.sql` | `queueForLiaison` (insert) and the claim columns. Each close or finish inserts one row here and one in its own table under the same id; the two rows are sent independently, so each is one row of the model. |
| `tools/liaison/api.ts` | `deliverDue` for one notice right after it's queued |

Last confirmed against commit `06e509f`. When a covered file changes after that commit, check that the model still describes it before you trust a pass, then move this commit forward.

## Not covered

- Liveness: that a delivery is eventually sent once the receiver accepts. The cron's retry is unbounded, but TLC here checks only safety.
- More than one delivery row, or more than one "Send again" per run.
- The receiver's side. Coach and the nutrition bot dedupe on the delivery id, and the model doesn't check that.
