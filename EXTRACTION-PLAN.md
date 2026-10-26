# Extraction plan: notifications

## Candidate and reason

I would pull out **notifications** first, but only after establishing durable
event delivery. It has the narrowest useful responsibility: turn an
`order.placed` event into a customer confirmation. Orders already publishes
that event, and notifications subscribes to it, so the modules have a natural
contract that does not require the order flow to call a notification API and
wait for an email provider.

The **step 14 signal** for doing this would be a second team taking ownership
of notification delivery and needing to release or scale it independently.
That is a concrete ownership/deployment signal, not a claim that the current
shop already has that need. The sample has no production load or team data
showing that a service split is necessary. Without that signal, I would keep
notifications as a module in the monolith and complete the same reliability
work there first.

I would not start with payments: payment latency and uncertain outcomes can
leave an order with an ambiguous charge, requiring idempotency and
reconciliation at the point of sale. Nor would I start with inventory, whose
reservation must stay consistent with order creation. Notifications is the
least risky first boundary only if its delivery is made reliable; “it is easy
to extract” is not sufficient justification.

## Data ownership and current readers

Notifications owns the `outbox` table, whose rows have an ID, recipient, and
subject. Only `notifications/repo.ts` and its service read or write that
table. The app and flow test call the public `sent()` API to observe messages;
they do not access the table directly. The event bus is in-process and has no
persistent event storage. The other modules own `orders`, `stock`, and
`charges`; notifications should not read or write any of them.

After extraction, notifications must own its persistent message/delivery
state. No other service should share or query its database. The message
outbox should track delivery state and retry metadata, and event consumption
should have a durable deduplication record.

## What changes when the boundary becomes a network

Today `eventBus.publish` invokes subscribers in-process. If notification
handling throws, the bus logs the error and continues, but the event is not
automatically retried. If the process exits after the order is saved but
before the listener saves the message, that confirmation is lost.

After extraction, orders must not make a synchronous HTTP call to
notifications as part of `placeOrder`. A timeout would not tell orders
whether notifications accepted the message; retrying the call could create a
duplicate, while not retrying could lose the confirmation. It must not turn a
successfully placed order into a failure just because the mail service is
temporarily unavailable.

Instead, orders should persist an `order.placed` event in a transactional
outbox alongside the order, and a relay should publish it to durable
messaging. Notifications consumes and acknowledges the event only after its
own durable state is committed. If the notifications service is down for ten
minutes, the broker retains the event and orders continue accepting valid
orders. On recovery, notifications drains the backlog and sends confirmations;
the delay is observable, but the event is not silently dropped.

Delivery is at-least-once, so notifications must deduplicate using a stable
event ID (or a unique key such as event type plus order ID). It should retry
transient provider failures with bounded backoff, expose backlog age and
failure metrics, and send poison events to a monitored dead-letter queue.
An email-provider timeout can occur after the provider accepted a message;
use the provider's idempotency support if available, and otherwise document
that a duplicate email remains possible and provide operational
reconciliation. Do not acknowledge the event before recording enough durable
state to resume safely.

## Five extraction steps

### 1. Confirm the signal and define the contract

Measure notification volume, delivery latency, failure rate, and the cost of
notification deployments blocking the owning team. Confirm the step 14
independent-ownership/deployment signal before funding the split. Document the
event schema (`eventId`, `orderId`, `email`, and amount), compatibility rules,
delivery guarantees, and what counts as accepted versus delivered.

**Check before moving on:** the ownership or operational need is evidenced,
the event contract has an owner and versioning policy, and stakeholders agree
that order placement succeeds independently from email delivery.

### 2. Make the existing module reliable and data ownership explicit

Keep the code in the monolith. Give the event a stable ID and persist it
transactionally with the order in an outbox; add a relay that retries
publishing. Make notifications record event consumption and message state
durably, deduplicate deliveries, and retry transient provider errors. Remove
any future need for other modules to inspect the notifications table.

**Check before moving on:** tests prove a process restart does not lose a
queued confirmation, repeated delivery does not create repeated work, and
provider timeouts/retries have documented outcomes. Verify the outbox and
order write cannot diverge on success or rollback.

### 3. Extract behind the event contract

Move the notifications handler, delivery logic, and its data store into a
separately deployable process. Keep the event schema independent of internal
TypeScript types and repositories. Configure credentials and provider
access for the new owner; do not copy the shared in-memory `outbox` table or
let the new service connect to the monolith's database.

**Check before moving on:** the service can start, consume a representative
event, persist its state, and send through a test provider in an isolated
environment. Its health checks and backlog/failure metrics are available.

### 4. Run in shadow/canary mode and switch event consumption

Initially feed a copy of production-shaped events to the extracted service
without sending duplicate customer emails. Compare its decisions and delivery
records with the in-process module. Then enable the new consumer for a small
canary cohort, with deduplication active, and progressively route all events
to it. Keep the publisher contract unchanged; do not introduce a synchronous
orders-to-notifications request.

**Check before moving on:** event counts reconcile, no events are lost, the
backlog drains within the delivery objective, duplicate handling is verified,
and the ten-minute outage/recovery scenario passes in a controlled test.
Rollback is a routing change that does not cause both consumers to send.

### 5. Cut over, observe, and remove the old implementation

Make the extracted service the sole notification consumer. Monitor delivery
latency, queue age, retries, dead-letter volume, and provider outcomes through
at least one representative operating period. Exercise rollback while
preserving event IDs and consumer state. Once the new path is stable, remove
the in-process notification subscription and any obsolete local delivery
state; retain the event contract and operational runbook.

**Check before moving on:** the old handler is not receiving events, the new
service meets the agreed delivery objective, alerts and runbooks have an
owner, and rollback/replay do not send unintended duplicates.

## Where I would stop

I would stop before step 2—and keep notifications modular inside the
monolith—if there is no independent team/deployment need or measurable
operational pressure. I would also stop before cutover if event durability,
deduplication, timeout behavior, or rollback cannot be demonstrated. A
separate deployment is not an improvement if a ten-minute outage turns into
lost confirmations, duplicate emails, or hidden backlog.
