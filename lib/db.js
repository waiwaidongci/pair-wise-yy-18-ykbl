const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { randomUUID } = require('crypto');
const config = require('../project.config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const driver = new sqlite3.Database(DB_FILE);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    driver.run(sql, params, function callback(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    driver.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function get(sql, params = []) {
  return all(sql, params).then((rows) => rows[0] || null);
}

function now() {
  return new Date().toISOString();
}

function newId(prefix) {
  return prefix ? prefix + '-' + randomUUID() : randomUUID();
}

function toRecord(row) {
  const data = JSON.parse(row.data || '{}');
  return {
    id: row.id,
    collection: row.collection,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...data
  };
}

function findCollection(name) {
  const collection = config.collections[name];
  if (!collection) {
    const error = new Error('unknown collection: ' + name);
    error.status = 404;
    throw error;
  }
  return collection;
}

function titleFor(collectionConfig, data) {
  return (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
}

function validate(collectionConfig, data) {
  const missing = (collectionConfig.required || []).filter(
    (field) => data[field] === undefined || data[field] === ''
  );
  if (missing.length) {
    const error = new Error('missing required fields: ' + missing.join(', '));
    error.status = 400;
    throw error;
  }
}

async function insertEvent({ recordId, collection, action, status, actor, note, data }) {
  await run(
    `INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      recordId,
      collection,
      action || '记录',
      status || '',
      actor || '',
      note || '',
      JSON.stringify(data || {}),
      now()
    ]
  );
}

async function listEvents(recordId) {
  const rows = await all(
    'SELECT * FROM events WHERE record_id = ? ORDER BY created_at ASC, rowid ASC',
    [recordId]
  );
  return rows.map((event) => ({
    id: event.id,
    action: event.action,
    status: event.status,
    actor: event.actor,
    note: event.note,
    data: JSON.parse(event.data || '{}'),
    createdAt: event.created_at
  }));
}

async function listRecords(collection) {
  const rows = await all(
    'SELECT * FROM records WHERE collection = ? ORDER BY updated_at DESC, rowid DESC',
    [collection]
  );
  return rows.map(toRecord);
}

async function loadRecord(collection, id) {
  const row = await get(
    'SELECT * FROM records WHERE collection = ? AND id = ? LIMIT 1',
    [collection, id]
  );
  return row ? toRecord(row) : null;
}

async function saveRecord(collection, id, data, status) {
  const collectionConfig = findCollection(collection);
  await run(
    `UPDATE records
       SET status = ?, title = ?, data = ?, updated_at = ?
     WHERE collection = ? AND id = ?`,
    [status, titleFor(collectionConfig, data), JSON.stringify(data), now(), collection, id]
  );
}

async function insertRecord({ id, collection, status, data }) {
  const collectionConfig = findCollection(collection);
  const createdAt = now();
  await run(
    `INSERT INTO records (id, collection, status, title, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, collection, status, titleFor(collectionConfig, data), JSON.stringify(data), createdAt, createdAt]
  );
}

async function deleteRecord(collection, id) {
  await run('DELETE FROM records WHERE collection = ? AND id = ?', [collection, id]);
  await run('DELETE FROM events WHERE record_id = ?', [id]);
}

async function seedGenericRecords() {
  for (const seed of config.seed || []) {
    const collectionConfig = findCollection(seed.collection);
    const id = seed.id || randomUUID();
    const createdAt = seed.createdAt || now();
    const status = seed.status || collectionConfig.defaultStatus || '';
    const data = { ...seed.data, status };
    await run(
      `INSERT OR IGNORE INTO records (id, collection, status, title, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        seed.collection,
        status,
        titleFor(collectionConfig, data),
        JSON.stringify(data),
        createdAt,
        seed.updatedAt || createdAt
      ]
    );
    const existingEvent = await get('SELECT 1 AS x FROM events WHERE record_id = ? LIMIT 1', [id]);
    if (!existingEvent) {
      await insertEvent({
        recordId: id,
        collection: seed.collection,
        action: seed.eventAction || '创建',
        status,
        actor: seed.actor || 'system',
        note: seed.note || '',
        data
      });
    }
  }
}

async function initDb() {
  await run(`
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
  await run('CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection)');
  await run('CREATE INDEX IF NOT EXISTS idx_records_status ON records(status)');
  await run(`
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT,
  actor TEXT,
  note TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);
  await run('CREATE INDEX IF NOT EXISTS idx_events_record ON events(record_id)');

  await seedGenericRecords();
}

module.exports = {
  run,
  all,
  get,
  now,
  newId,
  initDb,
  findCollection,
  validate,
  insertEvent,
  listEvents,
  listRecords,
  loadRecord,
  saveRecord,
  insertRecord,
  deleteRecord,
  toRecord
};
