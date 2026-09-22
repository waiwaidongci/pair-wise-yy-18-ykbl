const express = require('express');
const config = require('./project.config');
const db = require('./lib/db');
const rodStore = require('./lib/rodStore');
const rodRoutes = require('./lib/rodRoutes');

const app = express();
const PORT = process.env.PORT || config.port;

app.use(express.json({ limit: '2mb' }));

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

// 操控杆疲劳验收专用入口：判定（lib/rodJudge）、归档（lib/rodStore）与入口（lib/rodRoutes）分离
app.use('/api', rodRoutes);

app.get('/api/:collection', async (req, res, next) => {
  try {
    db.findCollection(req.params.collection);
    const rows = await db.listRecords(req.params.collection);
    let filtered = applyQuery(rows, req.query);
    // 偶头列表附带操控杆登台状态，与单头履历、登台状态接口同源
    if (req.params.collection === 'puppetHeads') {
      const map = await rodStore.stageStatusMap();
      filtered = filtered.map((head) => ({
        ...head,
        rodStageReady: Boolean(map[head.id] && map[head.id].ready)
      }));
    }
    const limit = Number(req.query.limit || 0);
    res.json(limit > 0 ? filtered.slice(0, limit) : filtered);
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection', async (req, res, next) => {
  try {
    const collectionConfig = db.findCollection(req.params.collection);
    const data = { ...collectionConfig.defaults, ...req.body };
    const status = data.status || collectionConfig.defaultStatus || '';
    data.status = status;
    db.validate(collectionConfig, data);
    const id = db.newId();
    await db.insertRecord({ id, collection: req.params.collection, status, data });
    await db.insertEvent({
      recordId: id,
      collection: req.params.collection,
      action: req.body.action || '创建',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data
    });
    res.status(201).json(await db.loadRecord(req.params.collection, id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id', async (req, res, next) => {
  try {
    db.findCollection(req.params.collection);
    const record = await db.loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/:collection/:id', async (req, res, next) => {
  try {
    db.findCollection(req.params.collection);
    const record = await db.loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const nextData = { ...record, ...req.body };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    const status = nextData.status || record.status;
    nextData.status = status;
    await db.saveRecord(req.params.collection, req.params.id, nextData, status);
    await db.insertEvent({
      recordId: req.params.id,
      collection: req.params.collection,
      action: req.body.action || '更新',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    res.json(await db.loadRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection/:id/events', async (req, res, next) => {
  try {
    const collectionConfig = db.findCollection(req.params.collection);
    const record = await db.loadRecord(req.params.collection, req.params.id);
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
    await db.saveRecord(req.params.collection, req.params.id, nextData, status);
    await db.insertEvent({
      recordId: req.params.id,
      collection: req.params.collection,
      action: req.body.action || status || '记录',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    res.json(await db.loadRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id/timeline', async (req, res, next) => {
  try {
    db.findCollection(req.params.collection);
    const record = await db.loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const events = await db.listEvents(req.params.id);
    res.json({ record, events });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/:collection/:id', async (req, res, next) => {
  try {
    db.findCollection(req.params.collection);
    await db.deleteRecord(req.params.collection, req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  const body = { error: error.message || 'server error' };
  if (error.conflicts) body.conflicts = error.conflicts;
  res.status(error.status || 500).json(body);
});

async function start() {
  await db.initDb();
  await rodStore.init();
  app.listen(PORT, () => {
    console.log(config.title + ' API running at http://localhost:' + PORT);
  });
}

start().catch((error) => {
  console.error('启动失败:', error);
  process.exit(1);
});
