const express = require('express');
const { randomUUID } = require('crypto');
const config = require('./project.config');
const db = require('./lib/db');
const archive = require('./lib/archive');
const rodFatigueRouter = require('./routes/rodFatigue');

const app = express();
const PORT = process.env.PORT || config.port;

app.use(express.json({ limit: '2mb' }));

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function now() {
  return new Date().toISOString();
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
  const missing = (collectionConfig.required || []).filter((field) => data[field] === undefined || data[field] === '');
  if (missing.length) {
    const error = new Error('missing required fields: ' + missing.join(', '));
    error.status = 400;
    throw error;
  }
}

function insertEvent({ recordId, collection, action, status, actor, note, data }) {
  db.run(
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
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

function initDb() {
  db.run(`CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
  db.run('CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection)');
  db.run('CREATE INDEX IF NOT EXISTS idx_records_status ON records(status)');
  db.run(`CREATE TABLE IF NOT EXISTS events (
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
  db.run('CREATE INDEX IF NOT EXISTS idx_events_record ON events(record_id)');

  const count = db.get('SELECT COUNT(*) AS count FROM records;').count;
  if (count > 0) return false;

  for (const seed of config.seed || []) {
    const collectionConfig = findCollection(seed.collection);
    const id = seed.id || randomUUID();
    const createdAt = seed.createdAt || now();
    const status = seed.status || collectionConfig.defaultStatus || '';
    const data = { ...seed.data, status };
    db.run(
      'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
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
    insertEvent({
      recordId: id,
      collection: seed.collection,
      action: seed.eventAction || '创建',
      status,
      actor: seed.actor || 'system',
      note: seed.note || '',
      data
    });
  }
  return true;
}

function loadRecord(collection, id) {
  const row = db.get(
    'SELECT * FROM records WHERE collection = ' + sqlValue(collection) + ' AND id = ' + sqlValue(id) + ' LIMIT 1;'
  );
  return row ? toRecord(row) : null;
}

function saveRecord(collection, id, data, status) {
  const collectionConfig = findCollection(collection);
  db.run(
    'UPDATE records SET status = ' + sqlValue(status) +
    ', title = ' + sqlValue(titleFor(collectionConfig, data)) +
    ', data = ' + sqlValue(JSON.stringify(data)) +
    ', updated_at = ' + sqlValue(now()) +
    ' WHERE collection = ' + sqlValue(collection) + ' AND id = ' + sqlValue(id) + ';'
  );
}

function applyQuery(records, query) {
  return records.filter((record) => {
    if (query.status && record.status !== query.status) return false;
    if (query.search) {
      const haystack = JSON.stringify(record).toLowerCase();
      if (!haystack.includes(String(query.search).toLowerCase())) return false;
    }
    for (const [key, value] of Object.entries(query)) {
      if (['status', 'search', 'limit'].includes(key)) continue;
      if (record[key] === undefined) return false;
      if (!String(record[key]).toLowerCase().includes(String(value).toLowerCase())) return false;
    }
    return true;
  });
}

// 验收判定与归档由专属入口负责，通用写接口对被治理集合关闭
function ensureWritable(collection) {
  if (findCollection(collection).governed) {
    const error = new Error('该集合为流程治理集合，写入请走专属入口：/api/rod-fatigue/...');
    error.status = 405;
    throw error;
  }
}

async function main() {
  await db.init();

  app.get('/health', (req, res) => {
    res.json({ ok: true, service: config.title, port: PORT });
  });

  app.get('/api/meta', (req, res) => {
    res.json({
      title: config.title,
      description: config.description,
      collections: config.collections,
      examples: config.examples || []
    });
  });

  // 操控杆疲劳验收专属入口（须在通用 /api/:collection 之前挂载）
  app.use('/api/rod-fatigue', rodFatigueRouter);

  app.get('/api/:collection', (req, res, next) => {
    try {
      findCollection(req.params.collection);
      const rows = db
        .all('SELECT * FROM records WHERE collection = ' + sqlValue(req.params.collection) + ' ORDER BY updated_at DESC;')
        .map(toRecord);
      const filtered = applyQuery(rows, req.query);
      const limit = Number(req.query.limit || 0);
      res.json(limit > 0 ? filtered.slice(0, limit) : filtered);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/:collection', (req, res, next) => {
    try {
      const collectionConfig = findCollection(req.params.collection);
      ensureWritable(req.params.collection);
      const data = { ...collectionConfig.defaults, ...req.body };
      const status = data.status || collectionConfig.defaultStatus || '';
      data.status = status;
      validate(collectionConfig, data);
      const id = randomUUID();
      const createdAt = now();
      db.run(
        'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
        [
          id,
          req.params.collection,
          status,
          titleFor(collectionConfig, data),
          JSON.stringify(data),
          createdAt,
          createdAt
        ]
      );
      insertEvent({
        recordId: id,
        collection: req.params.collection,
        action: req.body.action || '创建',
        status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data
      });
      res.status(201).json(loadRecord(req.params.collection, id));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/:collection/:id', (req, res, next) => {
    try {
      findCollection(req.params.collection);
      const record = loadRecord(req.params.collection, req.params.id);
      if (!record) return res.status(404).json({ error: 'not found' });
      res.json(record);
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/:collection/:id', (req, res, next) => {
    try {
      ensureWritable(req.params.collection);
      findCollection(req.params.collection);
      const record = loadRecord(req.params.collection, req.params.id);
      if (!record) return res.status(404).json({ error: 'not found' });
      const nextData = { ...record, ...req.body };
      delete nextData.id;
      delete nextData.collection;
      delete nextData.createdAt;
      delete nextData.updatedAt;
      const status = nextData.status || record.status;
      nextData.status = status;
      saveRecord(req.params.collection, req.params.id, nextData, status);
      insertEvent({
        recordId: req.params.id,
        collection: req.params.collection,
        action: req.body.action || '更新',
        status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data: req.body
      });
      res.json(loadRecord(req.params.collection, req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/:collection/:id/events', (req, res, next) => {
    try {
      const collectionConfig = findCollection(req.params.collection);
      ensureWritable(req.params.collection);
      const record = loadRecord(req.params.collection, req.params.id);
      if (!record) return res.status(404).json({ error: 'not found' });
      const status = req.body.status || record.status;
      if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
        return res.status(400).json({ error: 'invalid status: ' + status });
      }
      const nextData = { ...record, ...(req.body.fields || {}), status };
      delete nextData.id;
      delete nextData.collection;
      delete nextData.createdAt;
      delete nextData.updatedAt;
      saveRecord(req.params.collection, req.params.id, nextData, status);
      insertEvent({
        recordId: req.params.id,
        collection: req.params.collection,
        action: req.body.action || status || '记录',
        status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data: req.body
      });
      res.json(loadRecord(req.params.collection, req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/:collection/:id/timeline', (req, res, next) => {
    try {
      findCollection(req.params.collection);
      const record = loadRecord(req.params.collection, req.params.id);
      if (!record) return res.status(404).json({ error: 'not found' });
      const events = db
        .all('SELECT * FROM events WHERE record_id = ' + sqlValue(req.params.id) + ' ORDER BY created_at ASC;')
        .map((event) => ({
          id: event.id,
          action: event.action,
          status: event.status,
          actor: event.actor,
          note: event.note,
          data: JSON.parse(event.data || '{}'),
          createdAt: event.created_at
        }));
      res.json({ record, events });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/:collection/:id', (req, res, next) => {
    try {
      ensureWritable(req.params.collection);
      findCollection(req.params.collection);
      db.run('DELETE FROM records WHERE collection = ' + sqlValue(req.params.collection) + ' AND id = ' + sqlValue(req.params.id) + ';');
      db.run('DELETE FROM events WHERE record_id = ' + sqlValue(req.params.id) + ';');
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.use((error, req, res, next) => {
    res.status(error.status || 500).json({ error: error.message || 'server error' });
  });

  db.transaction(() => {
    const seeded = initDb();
    if (seeded) {
      // 种子数据落档后对账一次登台状态，保证首屏一致
      archive.reconcileAll();
    }
  });

  app.listen(PORT, () => {
    console.log(config.title + ' API running at http://localhost:' + PORT);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
