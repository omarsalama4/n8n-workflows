# Responsible-person sync

This independently authored portfolio example illustrates CRM assignment synchronization using a fictional ticket and two linked conversations. The companion service keeps the entire demo local. It uses synthetic IDs and makes no calls to external systems.

## How it works

1. The [n8n template](../../templates/responsible-person-sync.json) receives an event on a webhook and forwards the caller’s bearer header to the loopback service. The export starts inactive and stores no bearer credentials. Its execution data saving is disabled.
2. The service requires a writer token before parsing the event or opening the write transaction. An unknown or missing identity returns 401. The separately configured viewer identity receives 403.
3. SQLite acquires the write lock with `BEGIN IMMEDIATE`. The transaction checks the durable event receipt and record revision, then applies the ticket update, both conversation updates and receipt together. A repeat of an accepted event returns `duplicate`. Changed payload under the same event ID or a stale revision returns 409. A partial transaction rolls back.
4. n8n makes at most three attempts on transport errors. When the service remains unreachable, it returns 503. The caller can retry with the same event ID. A successful prior commit then returns `duplicate`, including after a service restart. A database 503 passes through immediately so that the caller can retry. Neither retry path exercises a database restore.

## Run and verify locally

Use Node.js 24 and n8n 2.30 to run the test. Ports 5679, 5680 and 8765 must be free. The suite generates two throwaway tokens, imports and activates the template in a temporary n8n profile, drives the webhook, checks SQLite state, and removes the temporary data.

```powershell
$env:N8N_CLI_PATH = Join-Path (npm root -g) 'n8n/bin/n8n'
node --test examples/responsible-person-sync/workflow.e2e.mjs
```

To inspect the graph, import the template into a disposable local n8n instance. Run `node examples/responsible-person-sync/service.mjs` with `OWNER_SYNC_DB` pointing to a disposable file and `OWNER_SYNC_WRITER_TOKEN` and `OWNER_SYNC_VIEWER_TOKEN` set to distinct randomly generated values. Make requests to the n8n instance’s local webhook with a JSON body and the appropriate bearer token. Keep the service and webhook on loopback.

```json
{ "eventId": "event-1", "ticketId": "ticket-1", "ownerId": "agent-2", "revision": 1 }
```

Atomicity in this example covers the synthetic database. A real CRM API would require a separate idempotent integration or reconciliation design for external side effects. Bring your own identity provider, retention policy and backup/restore design for production.
