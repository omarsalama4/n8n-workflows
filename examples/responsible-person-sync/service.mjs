import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const identifier = /^[a-z0-9-]{1,40}$/;

function sameToken(header, token) {
  const actual = Buffer.from(header ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createSyncService({ filename, writer, viewer }) {
  if (!filename || !writer || !viewer || writer === viewer) {
    throw new Error('A database path and two distinct demo tokens are required');
  }

  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 2000;
    CREATE TABLE IF NOT EXISTS ticket (id TEXT PRIMARY KEY, owner TEXT NOT NULL, revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS conversation (id TEXT PRIMARY KEY, ticket TEXT NOT NULL, owner TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS receipt (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    INSERT OR IGNORE INTO ticket VALUES ('ticket-1', 'agent-1', 0);
    INSERT OR IGNORE INTO conversation VALUES ('thread-1', 'ticket-1', 'agent-1'), ('thread-2', 'ticket-1', 'agent-1');
  `);

  const receipt = db.prepare('SELECT payload FROM receipt WHERE id = ?');
  const saveReceipt = db.prepare('INSERT INTO receipt VALUES (?, ?)');
  const readTicket = db.prepare('SELECT revision FROM ticket WHERE id = ?');
  const writeTicket = db.prepare('UPDATE ticket SET owner = ?, revision = ? WHERE id = ?');
  const writeConversations = db.prepare('UPDATE conversation SET owner = ? WHERE ticket = ?');

  function apply({ eventId, ticketId, ownerId, revision }) {
    const payload = JSON.stringify([ticketId, ownerId, revision]);
    db.exec('BEGIN IMMEDIATE');
    try {
      const seen = receipt.get(eventId);
      const ticket = readTicket.get(ticketId);
      let outcome;
      if (seen) {
        outcome = seen.payload === payload ? [200, 'duplicate'] : [409, 'EVENT_CONFLICT'];
      } else if (!ticket) {
        outcome = [404, 'TICKET_NOT_FOUND'];
      } else if (revision <= ticket.revision) {
        outcome = [409, 'STALE_REVISION'];
      } else {
        writeTicket.run(ownerId, revision, ticketId);
        writeConversations.run(ownerId, ticketId);
        saveReceipt.run(eventId, payload);
        outcome = [200, 'applied'];
      }
      db.exec('COMMIT');
      return outcome;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const server = createServer(async (request, response) => {
    const send = (status, code) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(status < 400 ? { status: code } : { error: code }));
    };

    if (request.method !== 'POST' || request.url !== '/assignments') return send(404, 'NOT_FOUND');
    if (!sameToken(request.headers.authorization, writer)) {
      const readOnly = sameToken(request.headers.authorization, viewer);
      return readOnly ? send(403, 'WRITE_FORBIDDEN') : send(401, 'UNAUTHENTICATED');
    }

    let event;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > 4096) return send(413, 'EVENT_TOO_LARGE');
        chunks.push(chunk);
      }
      event = JSON.parse(Buffer.concat(chunks));
    } catch {
      return send(400, 'INVALID_EVENT');
    }

    if (!event || ![event.eventId, event.ticketId, event.ownerId].every(value =>
      typeof value === 'string' && identifier.test(value)) ||
      !Number.isSafeInteger(event.revision) || event.revision < 1) return send(400, 'INVALID_EVENT');

    try {
      return send(...apply(event));
    } catch (error) {
      return (error.errcode & 255) === 5 ? send(503, 'DATABASE_BUSY') : send(500, 'TRANSACTION_FAILED');
    }
  });
  server.once('close', () => db.close());
  return server;
}

if (import.meta.main) {
  createSyncService({
    filename: process.env.OWNER_SYNC_DB,
    writer: process.env.OWNER_SYNC_WRITER_TOKEN,
    viewer: process.env.OWNER_SYNC_VIEWER_TOKEN,
  }).listen(8765, '127.0.0.1');
}
