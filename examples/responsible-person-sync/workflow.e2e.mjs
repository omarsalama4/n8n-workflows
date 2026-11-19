import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSyncService } from './service.mjs';

test('responsible-person workflow through the n8n webhook', { timeout: 125000 }, async t => {
  const cli = process.env.N8N_CLI_PATH;
  assert.ok(cli, 'Set N8N_CLI_PATH to the installed n8n package bin/n8n');
  const source = fileURLToPath(new URL('../../templates/responsible-person-sync.json', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'owner-sync-'));
  const filename = join(directory, 'owner.sqlite');
  const writer = randomBytes(24).toString('hex');
  const viewer = randomBytes(24).toString('hex');
  const service = () => createSyncService({ filename, writer, viewer });
  let upstream;
  let n8n;
  t.after(async () => {
    if (n8n && n8n.exitCode === null && n8n.signalCode === null) {
      const exited = once(n8n, 'exit');
      n8n.kill();
      await exited;
    }
    if (upstream?.listening) await new Promise(resolve => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  async function startUpstream() {
    upstream = service();
    upstream.listen(8765, '127.0.0.1');
    await once(upstream, 'listening');
  }
  await startUpstream();

  const systemEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(path|systemroot|windir|temp|tmp|home|userprofile|appdata|localappdata)$/i.test(name)));
  const env = {
    ...systemEnv,
    N8N_USER_FOLDER: directory,
    N8N_PORT: '5679',
    N8N_HOST: '127.0.0.1',
    N8N_LISTEN_ADDRESS: '127.0.0.1',
    DB_TYPE: 'sqlite',
    EXECUTIONS_MODE: 'regular',
    N8N_DIAGNOSTICS_ENABLED: 'false',
    N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
    N8N_TEMPLATES_ENABLED: 'false',
    N8N_PERSONALIZATION_ENABLED: 'false',
    N8N_RUNNERS_ENABLED: 'false',
    N8N_RUNNERS_BROKER_PORT: '5680',
    N8N_ENCRYPTION_KEY: randomBytes(24).toString('hex'),
    N8N_LICENSE_AUTO_RENEW_ENABLED: 'false',
  };
  for (const args of [['import:workflow', `--input=${source}`], ['publish:workflow', '--id=synthetic-owner-sync']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.error?.message || result.stderr + result.stdout);
  }

  n8n = spawn(process.execPath, [cli, 'start'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let startup = '';
  for (const stream of [n8n.stdout, n8n.stderr]) stream.on('data', chunk => { startup = (startup + chunk).slice(-6000); });
  const host = 'http://127.0.0.1:5679';
  let healthy = false;
  const startupDeadline = Date.now() + 50000;
  while (Date.now() < startupDeadline && n8n.exitCode === null) {
    try {
      healthy = (await fetch(`${host}/healthz/readiness`, { signal: AbortSignal.timeout(500) })).ok;
    } catch {}
    if (healthy) break;
    await delay(250);
  }
  assert.ok(healthy, startup);

  const event = { eventId: 'event-1', ticketId: 'ticket-1', ownerId: 'agent-2', revision: 1 };
  async function post(body, token = writer) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${host}/webhook/synthetic-owner-sync`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
    });
    const raw = await response.text();
    assert.match(response.headers.get('content-type') || '', /application\/json/,
      `Unexpected webhook response ${response.status}: ${raw.slice(0, 600)}\n${startup}`);
    return [response.status, JSON.parse(raw)];
  }
  function state() {
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      return [
        db.prepare('SELECT owner FROM ticket').get().owner,
        db.prepare('SELECT owner FROM conversation ORDER BY id').all().map(row => row.owner),
        db.prepare('SELECT COUNT(*) AS count FROM receipt').get().count,
      ];
    } finally {
      db.close();
    }
  }

  const registrationDeadline = Date.now() + 15000;
  let probe = await post(event, null);
  while (probe[0] === 404 && probe[1].message?.includes('is not registered') && Date.now() < registrationDeadline) {
    await delay(250);
    probe = await post(event, null);
  }
  assert.deepEqual(probe, [401, { error: 'UNAUTHENTICATED' }]);

  await t.test('denies missing identity and read-only identity before writes', async () => {
    assert.deepEqual(await post(event, null), [401, { error: 'UNAUTHENTICATED' }]);
    assert.deepEqual(await post(event, viewer), [403, { error: 'WRITE_FORBIDDEN' }]);
    assert.deepEqual(state(), ['agent-1', ['agent-1', 'agent-1'], 0]);
  });
  await t.test('validates the event and handles missing records', async () => {
    assert.deepEqual(await post({ ...event, revision: 0 }), [400, { error: 'INVALID_EVENT' }]);
    assert.deepEqual(await post({ ...event, ticketId: 'ticket-unknown' }), [404, { error: 'TICKET_NOT_FOUND' }]);
  });
  await t.test('one concurrent delivery applies and the others replay', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => post(event)));
    assert.ok(results.every(([status]) => status === 200), JSON.stringify(results));
    assert.equal(results.filter(([, body]) => body.status === 'applied').length, 1);
    assert.equal(results.filter(([, body]) => body.status === 'duplicate').length, 7);
    assert.deepEqual(state(), ['agent-2', ['agent-2', 'agent-2'], 1]);
  });
  await t.test('rejects changed-key reuse and stale events', async () => {
    assert.deepEqual(await post({ ...event, ownerId: 'agent-3' }), [409, { error: 'EVENT_CONFLICT' }]);
    assert.deepEqual(await post({ ...event, eventId: 'old-event' }), [409, { error: 'STALE_REVISION' }]);
    assert.deepEqual(state(), ['agent-2', ['agent-2', 'agent-2'], 1]);
  });
  await t.test('rolls back assignments when saving the receipt fails', async () => {
    const db = new DatabaseSync(filename);
    try {
      db.exec("CREATE TRIGGER reject_demo_receipt BEFORE INSERT ON receipt BEGIN SELECT RAISE(ABORT, 'Synthetic failure'); END");
      const next = { ...event, eventId: 'event-2', ownerId: 'agent-3', revision: 2 };
      assert.deepEqual(await post(next), [500, { error: 'TRANSACTION_FAILED' }]);
      assert.deepEqual(state(), ['agent-2', ['agent-2', 'agent-2'], 1]);
    } finally {
      db.exec('DROP TRIGGER IF EXISTS reject_demo_receipt');
      db.close();
    }
  });
  await t.test('a competing database write lock returns a retryable response', async () => {
    const db = new DatabaseSync(filename);
    try {
      db.exec('BEGIN IMMEDIATE');
      const next = { ...event, eventId: 'event-2', ownerId: 'agent-3', revision: 2 };
      assert.deepEqual(await post(next), [503, { error: 'DATABASE_BUSY' }]);
      db.exec('ROLLBACK');
      assert.deepEqual(state(), ['agent-2', ['agent-2', 'agent-2'], 1]);
    } finally {
      db.close();
    }
  });
  await t.test('handles a transport outage and replays after a service restart', async () => {
    await new Promise(resolve => upstream.close(resolve));
    assert.deepEqual(await post(event), [503, { error: 'SERVICE_UNAVAILABLE' }]);
    await startUpstream();
    assert.deepEqual(await post(event), [200, { status: 'duplicate' }]);
    assert.deepEqual(await post({ ...event, eventId: 'event-2', ownerId: 'agent-3', revision: 2 }), [200, { status: 'applied' }]);
    assert.deepEqual(state(), ['agent-3', ['agent-3', 'agent-3'], 2]);
  });
});
