/**
 * 操控杆疲劳验收 —— 归档层
 * 验收单独立存档（rod_inspections 表），履历写 events 表。
 * 对外只暴露归档/读取能力，不包含规则判定与 HTTP 逻辑。
 */

const db = require('./db');
const judge = require('./rodJudge');

const { COLLECTION, STATUS, ACTIVE_STATUSES } = judge;
const TABLE = 'rod_inspections';

const ACTIVE_IN = ACTIVE_STATUSES.map(() => '?').join(', ');

function rowToOrder(row) {
  return {
    id: row.id,
    puppetHeadId: row.puppet_head_id,
    rodNo: row.rod_no,
    pulleyNo: row.pulley_no,
    weightNo: row.weight_no,
    operators: JSON.parse(row.operators || '[]'),
    measurements: JSON.parse(row.measurements || '{}'),
    status: row.status,
    failReasons: JSON.parse(row.fail_reasons || '[]'),
    reviews: JSON.parse(row.reviews || '[]'),
    trials: JSON.parse(row.trials || '[]'),
    supersedesId: row.supersedes_id || null,
    supersededById: row.superseded_by_id || null,
    note: row.note || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function titleFor(order) {
  return '偶头' + order.puppetHeadId + ' / 杆' + order.rodNo;
}

async function insertOrderEvent(orderId, action, status, actor, note, data) {
  await db.insertEvent({
    recordId: orderId,
    collection: COLLECTION,
    action,
    status: status || '',
    actor: actor || '',
    note: note || '',
    data: data || {}
  });
}

async function createOrder(order, { action, actor, note, data, createdAt }) {
  const stamp = createdAt || db.now();
  await db.run(
    `INSERT INTO ${TABLE}
       (id, puppet_head_id, rod_no, pulley_no, weight_no, operators, measurements,
        status, fail_reasons, reviews, trials, supersedes_id, superseded_by_id,
        note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      order.id,
      order.puppetHeadId,
      order.rodNo,
      order.pulleyNo,
      order.weightNo,
      JSON.stringify(order.operators || []),
      JSON.stringify(order.measurements || {}),
      order.status,
      JSON.stringify(order.failReasons || []),
      JSON.stringify(order.reviews || []),
      JSON.stringify(order.trials || []),
      order.supersedesId || null,
      order.supersededById || null,
      order.note || '',
      stamp,
      stamp
    ]
  );
  await insertOrderEvent(orderId(order), action || '登记验收', order.status, actor, note, data || order);
  return getOrder(order.id);
}

function orderId(order) {
  return order.id;
}

async function updateOrder(order, { action, actor, note, data }) {
  await db.run(
    `UPDATE ${TABLE}
       SET puppet_head_id = ?, rod_no = ?, pulley_no = ?, weight_no = ?, operators = ?,
           measurements = ?, status = ?, fail_reasons = ?, reviews = ?, trials = ?,
           supersedes_id = ?, superseded_by_id = ?, note = ?, updated_at = ?
     WHERE id = ?`,
    [
      order.puppetHeadId,
      order.rodNo,
      order.pulleyNo,
      order.weightNo,
      JSON.stringify(order.operators || []),
      JSON.stringify(order.measurements || {}),
      order.status,
      JSON.stringify(order.failReasons || []),
      JSON.stringify(order.reviews || []),
      JSON.stringify(order.trials || []),
      order.supersedesId || null,
      order.supersededById || null,
      order.note || '',
      db.now(),
      order.id
    ]
  );
  await insertOrderEvent(order.id, action || '更新', order.status, actor, note, data || {});
  return getOrder(order.id);
}

async function getOrder(id) {
  const row = await db.get(`SELECT * FROM ${TABLE} WHERE id = ?`, [id]);
  return row ? rowToOrder(row) : null;
}

async function listOrders(filter = {}) {
  const where = [];
  const params = [];
  if (filter.puppetHeadId) {
    where.push('puppet_head_id = ?');
    params.push(filter.puppetHeadId);
  }
  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    where.push('status IN (' + statuses.map(() => '?').join(', ') + ')');
    params.push(...statuses);
  }
  const sql =
    `SELECT * FROM ${TABLE}` +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY updated_at DESC, rowid DESC';
  const rows = await db.all(sql, params);
  return rows.map(rowToOrder);
}

/**
 * 重复占用只认首单：同一编号字段在任何在途验收单（待调/待复核/试演中）中已占用即冲突。
 * 返回每条占用线索（首单即报）。excludeId 用于调校场景排除自身。
 */
async function findComponentOccupants(components, excludeId) {
  const rows = await db.all(
    `SELECT * FROM ${TABLE} WHERE status IN (${ACTIVE_IN}) ORDER BY created_at ASC, rowid ASC`,
    ACTIVE_STATUSES
  );
  const occupants = [];
  for (const row of rows.map(rowToOrder)) {
    if (excludeId && row.id === excludeId) continue;
    if (row.rodNo === components.rodNo) occupants.push({ field: 'rodNo', label: '操控杆编号', by: row });
    if (row.pulleyNo === components.pulleyNo) occupants.push({ field: 'pulleyNo', label: '提线轮编号', by: row });
    if (row.weightNo === components.weightNo) occupants.push({ field: 'weightNo', label: '配重块编号', by: row });
  }
  return occupants;
}

/** 同一偶头只允许一张在途验收单。 */
async function findActiveOrderByHead(puppetHeadId, excludeId) {
  const rows = await db.all(
    `SELECT * FROM ${TABLE} WHERE status IN (${ACTIVE_IN}) AND puppet_head_id = ?
     ORDER BY created_at ASC, rowid ASC`,
    [...ACTIVE_STATUSES, puppetHeadId]
  );
  const orders = rows.map(rowToOrder).filter((order) => !excludeId || order.id !== excludeId);
  return orders[0] || null;
}

/** 单头履历：按时间正序返回该偶头全部验收单（含已失效，旧值可查）。 */
async function historyByHead(puppetHeadId) {
  const rows = await db.all(
    `SELECT * FROM ${TABLE} WHERE puppet_head_id = ? ORDER BY created_at ASC, rowid ASC`,
    [puppetHeadId]
  );
  return rows.map(rowToOrder);
}

async function orderEvents(orderId) {
  return db.listEvents(orderId);
}

async function countOrders() {
  const row = await db.get(`SELECT COUNT(*) AS count FROM ${TABLE}`);
  return row.count;
}

/**
 * 登台状态（由归档数据即时派生，列表、单头履历、登台状态共用同一判定）：
 * 最新一张准登台单未被取代、且无在途单 → 可登台。
 */
function deriveStageReadiness(history) {
  const active = history.filter((order) => ACTIVE_STATUSES.includes(order.status));
  const approved = history
    .filter((order) => order.status === STATUS.APPROVED && !order.supersededById)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const current = approved[0] || null;
  const ready = Boolean(current) && active.length === 0;
  return {
    ready,
    currentApprovalId: current ? current.id : null,
    activeOrderIds: active.map((order) => order.id),
    total: history.length
  };
}

async function stageStatus(puppetHeadId) {
  const history = await historyByHead(puppetHeadId);
  return { puppetHeadId, ...deriveStageReadiness(history), history };
}

async function stageStatusMap() {
  const orders = await listOrders();
  const byHead = new Map();
  for (const order of orders) {
    if (!byHead.has(order.puppetHeadId)) byHead.set(order.puppetHeadId, []);
    byHead.get(order.puppetHeadId).push(order);
  }
  const result = {};
  for (const [headId, history] of byHead) {
    result[headId] = { puppetHeadId: headId, ...deriveStageReadiness(history) };
  }
  return result;
}

async function initRodTable() {
  await db.run(`
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id TEXT PRIMARY KEY,
  puppet_head_id TEXT NOT NULL,
  rod_no TEXT NOT NULL,
  pulley_no TEXT NOT NULL,
  weight_no TEXT NOT NULL,
  operators TEXT NOT NULL,
  measurements TEXT NOT NULL,
  status TEXT NOT NULL,
  fail_reasons TEXT NOT NULL,
  reviews TEXT NOT NULL,
  trials TEXT NOT NULL,
  supersedes_id TEXT,
  superseded_by_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
  await db.run(
    'CREATE INDEX IF NOT EXISTS idx_rod_head_status ON ' + TABLE + '(puppet_head_id, status)'
  );
}

/**
 * 演示用种子：
 * - head-seed-2 一张已准登台单（两次达标试演相隔四小时以上）
 * - head-seed-1 一张待调单（卡滞 + 回弹超时）
 */
async function seedIfEmpty() {
  if ((await countOrders()) > 0) return;

  const base = Date.parse('2026-09-20T09:00:00.000Z');
  const approved = {
    id: 'rod-seed-1',
    puppetHeadId: 'head-seed-2',
    rodNo: '杆-甲07',
    pulleyNo: '轮-甲03',
    weightNo: '坠-戊12',
    operators: ['陈阿龙', '林小凤'],
    measurements: {
      rodLengthCm: 128,
      reboundSeconds: 1.2,
      pullPeakN: 36.5,
      weightDeviationG: 20,
      jamming: false
    },
    status: STATUS.APPROVED,
    failReasons: [],
    reviews: [{ reviewer: '周班主', approved: true, at: new Date(base + 3600_000).toISOString(), note: '独立复核通过' }],
    trials: [
      { at: new Date(base + 2 * 3600_000).toISOString(), note: '首次试演达标' },
      { at: new Date(base + 7 * 3600_000).toISOString(), note: '二次试演达标，间隔五小时' }
    ],
    supersedesId: null,
    supersededById: null,
    note: '新排《白蛇传》武旦用杆出厂验收'
  };
  await createOrder(approved, {
    action: '登记验收',
    actor: '陈阿龙',
    note: '初次测量全部达标',
    data: approved.measurements,
    createdAt: new Date(base).toISOString()
  });
  await insertOrderEvent(
    approved.id,
    '复核通过',
    STATUS.IN_TRIAL,
    '周班主',
    '复核人未参与调校，准予试演',
    approved.reviews[0]
  );
  await insertOrderEvent(approved.id, '试演达标', STATUS.IN_TRIAL, '陈阿龙', approved.trials[0].note, {
    passed: true,
    at: approved.trials[0].at
  });
  await insertOrderEvent(approved.id, '试演达标·准登台', STATUS.APPROVED, '林小凤', approved.trials[1].note, {
    passed: true,
    at: approved.trials[1].at
  });

  const pending = {
    id: 'rod-seed-2',
    puppetHeadId: 'head-seed-1',
    rodNo: '杆-乙02',
    pulleyNo: '轮-乙09',
    weightNo: '坠-丙05',
    operators: ['吴守义', '郑小满'],
    measurements: {
      rodLengthCm: 131,
      reboundSeconds: 2.4,
      pullPeakN: 41.2,
      weightDeviationG: 70,
      jamming: true
    },
    status: STATUS.PENDING_TUNE,
    failReasons: [
      '操控杆卡滞',
      '回弹2.4秒超过' + judge.REBOUND_LIMIT_SECONDS + '秒',
      '配重偏差70克超过' + judge.WEIGHT_DEVIATION_LIMIT_GRAMS + '克'
    ],
    reviews: [],
    trials: [],
    supersedesId: null,
    supersededById: null,
    note: '返场后疲劳复测，三项异常只转待调'
  };
  await createOrder(pending, {
    action: '登记验收',
    actor: '吴守义',
    note: pending.failReasons.join('；'),
    data: pending.measurements,
    createdAt: new Date(base + 86400_000).toISOString()
  });
}

async function init() {
  await initRodTable();
  await seedIfEmpty();
}

module.exports = {
  COLLECTION,
  TABLE,
  titleFor,
  createOrder,
  updateOrder,
  getOrder,
  listOrders,
  findComponentOccupants,
  findActiveOrderByHead,
  historyByHead,
  orderEvents,
  stageStatus,
  stageStatusMap,
  deriveStageReadiness,
  init
};
