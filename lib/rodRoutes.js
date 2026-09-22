/**
 * 操控杆疲劳验收 —— 入口层
 * 专用入口与通用集合接口隔离：验收单不走 /api/:collection 通用路由。
 * 只负责协议解析与流程编排，规则判定在 rodJudge，存取在 rodStore。
 */

const express = require('express');
const db = require('./db');
const judge = require('./rodJudge');
const store = require('./rodStore');

const router = express.Router();

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
}

async function requireOrder(id) {
  const order = await store.getOrder(id);
  if (!order) {
    const error = new Error('验收单不存在');
    error.status = 404;
    throw error;
  }
  return order;
}

function assertStatus(order, allowed) {
  if (!allowed.includes(order.status)) {
    throw judge.badRequest('当前状态为「' + order.status + '」，不能执行该操作（允许状态：' + allowed.join('、') + '）');
  }
}

async function assertHeadExists(puppetHeadId) {
  const head = await db.loadRecord('puppetHeads', puppetHeadId);
  if (!head) {
    const error = new Error('偶头不存在：' + puppetHeadId);
    error.status = 400;
    throw error;
  }
  return head;
}

async function assertComponentsFree(components, excludeId) {
  const occupants = await store.findComponentOccupants(components, excludeId);
  if (occupants.length) {
    const first = occupants[0];
    const error = judge.conflict(
      first.label + ' ' + components[first.field] + ' 已被在途验收单 ' + first.by.id +
      '（偶头' + first.by.puppetHeadId + '，状态' + first.by.status + '）占用，重复占用只认首单'
    );
    error.conflicts = occupants.map((item) => ({
      field: item.field,
      label: item.label,
      componentNo: components[item.field],
      occupiedBy: item.by.id,
      puppetHeadId: item.by.puppetHeadId,
      status: item.by.status
    }));
    throw error;
  }
}

async function assertNoActiveOrderForHead(puppetHeadId, excludeId) {
  const existing = await store.findActiveOrderByHead(puppetHeadId, excludeId);
  if (existing) {
    throw judge.conflict('偶头 ' + puppetHeadId + ' 已有在途验收单 ' + existing.id + '（状态' + existing.status + '）');
  }
}

// ── 登台状态（全体） ──────────────────────────────────────────────
router.get('/stage-status', wrap(async (req, res) => {
  const map = await store.stageStatusMap();
  const heads = await db.listRecords('puppetHeads');
  const list = heads.map((head) => {
    const state = map[head.id] || {
      ready: false,
      currentApprovalId: null,
      activeOrderIds: [],
      total: 0
    };
    return {
      puppetHeadId: head.id,
      role: head.role,
      play: head.play,
      headStatus: head.status,
      rodStageReady: state.ready,
      currentApprovalId: state.currentApprovalId,
      activeOrderIds: state.activeOrderIds,
      inspectionCount: state.total
    };
  });
  res.json(list);
}));

// ── 单头登台状态 ─────────────────────────────────────────────────
router.get('/puppetHeads/:puppetHeadId/stage-status', wrap(async (req, res) => {
  await assertHeadExists(req.params.puppetHeadId);
  const state = await store.stageStatus(req.params.puppetHeadId);
  res.json({
    puppetHeadId: state.puppetHeadId,
    rodStageReady: state.ready,
    currentApprovalId: state.currentApprovalId,
    activeOrderIds: state.activeOrderIds,
    inspectionCount: state.total
  });
}));

// ── 验收单列表 ───────────────────────────────────────────────────
router.get('/rod-inspections', wrap(async (req, res) => {
  const filter = {};
  if (req.query.puppetHeadId) filter.puppetHeadId = String(req.query.puppetHeadId);
  if (req.query.status) {
    filter.status = String(req.query.status)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        if (!judge.STATUSES.includes(s)) throw judge.badRequest('非法状态：' + s);
        return s;
      });
  }
  res.json(await store.listOrders(filter));
}));

// ── 单头履历（含已失效单，旧值可查） ─────────────────────────────
router.get('/rod-inspections/by-head/:puppetHeadId/history', wrap(async (req, res) => {
  await assertHeadExists(req.params.puppetHeadId);
  const history = await store.historyByHead(req.params.puppetHeadId);
  const readiness = store.deriveStageReadiness(history);
  res.json({
    puppetHeadId: req.params.puppetHeadId,
    rodStageReady: readiness.ready,
    currentApprovalId: readiness.currentApprovalId,
    activeOrderIds: readiness.activeOrderIds,
    orders: history
  });
}));

// ── 验收单详情（附履历事件） ─────────────────────────────────────
router.get('/rod-inspections/:id', wrap(async (req, res) => {
  const order = await requireOrder(req.params.id);
  const events = await store.orderEvents(order.id);
  res.json({ ...order, events });
}));

// ── 登记验收 ─────────────────────────────────────────────────────
router.post('/rod-inspections', wrap(async (req, res) => {
  const input = judge.parseRegistration(req.body);
  await assertHeadExists(input.puppetHeadId);
  // 重复占用只认首单：操控杆、提线轮、配重块编号被在途单占用即拒收
  await assertComponentsFree(input, null);
  // 同一偶头一次只允许一张在途验收单
  await assertNoActiveOrderForHead(input.puppetHeadId, null);

  const decision = judge.judgeInitialStatus(input.measurements);
  const order = {
    id: db.newId('rod'),
    puppetHeadId: input.puppetHeadId,
    rodNo: input.rodNo,
    pulleyNo: input.pulleyNo,
    weightNo: input.weightNo,
    operators: input.operators,
    measurements: input.measurements,
    status: decision.status,
    failReasons: decision.failReasons,
    reviews: [],
    trials: [],
    supersedesId: null,
    supersededById: null,
    note: input.note
  };
  const created = await store.createOrder(order, {
    action: '登记验收',
    actor: req.body.actor || input.operators[0],
    note: decision.passed
      ? '初测达标，转待复核'
      : '初测异常只转待调：' + decision.failReasons.join('；'),
    data: { measurements: input.measurements, operators: input.operators }
  });
  res.status(201).json(created);
}));

// ── 调校（仅待调） ───────────────────────────────────────────────
router.post('/rod-inspections/:id/tune', wrap(async (req, res) => {
  const current = await requireOrder(req.params.id);
  assertStatus(current, [judge.STATUS.PENDING_TUNE]);

  const nextComponents = {
    rodNo: (req.body.rodNo || '').trim() || current.rodNo,
    pulleyNo: (req.body.pulleyNo || '').trim() || current.pulleyNo,
    weightNo: (req.body.weightNo || '').trim() || current.weightNo
  };
  let operators = current.operators;
  if (req.body.operatorA || req.body.operatorB) {
    const operatorA = (req.body.operatorA || '').trim();
    const operatorB = (req.body.operatorB || '').trim();
    if (!operatorA || !operatorB) throw judge.badRequest('更换操纵员须同时提供 operatorA、operatorB');
    if (operatorA === operatorB) throw judge.badRequest('两名操纵员不能为同一人');
    operators = [operatorA, operatorB];
  }
  const measurements = judge.parseMeasurements(req.body);
  const changed = judge.detectComponentChanges(current, nextComponents);

  // 改杆件（操控杆/提线轮）或改配重（配重块）：原验收失效，另开新单，旧值存档可查
  if (changed.length) {
    await assertComponentsFree(nextComponents, current.id);
    await assertNoActiveOrderForHead(current.puppetHeadId, current.id);

    const decision = judge.judgeInitialStatus(measurements);
    const replacement = {
      id: db.newId('rod'),
      puppetHeadId: current.puppetHeadId,
      rodNo: nextComponents.rodNo,
      pulleyNo: nextComponents.pulleyNo,
      weightNo: nextComponents.weightNo,
      operators,
      measurements,
      status: decision.status,
      failReasons: decision.failReasons,
      reviews: [],
      trials: [],
      supersedesId: current.id,
      supersededById: null,
      note: typeof req.body.note === 'string' ? req.body.note.trim() : ''
    };

    const invalidated = {
      ...current,
      status: judge.STATUS.INVALIDATED,
      supersededById: replacement.id
    };
    await store.updateOrder(invalidated, {
      action: '改件失效',
      actor: req.body.actor || operators[0],
      note: '调校改动 ' + changed.join('、') + '，原验收失效，由新单 ' + replacement.id + ' 接续',
      data: { changed, replacementId: replacement.id }
    });
    const created = await store.createOrder(replacement, {
      action: '改件重验登记',
      actor: req.body.actor || operators[0],
      note:
        '接续失效单 ' + current.id + '，' +
        (decision.passed ? '测量达标转待复核' : '测量异常只转待调：' + decision.failReasons.join('；')),
      data: { supersedesId: current.id, changed, measurements }
    });
    return res.status(201).json({ replaced: true, invalidatedOrderId: current.id, order: created });
  }

  // 未改件：同单重测，重新判定
  const decision = judge.judgeInitialStatus(measurements);
  const updated = await store.updateOrder(
    {
      ...current,
      operators,
      measurements,
      status: decision.status,
      failReasons: decision.failReasons,
      reviews: decision.passed ? current.reviews : [],
      trials: []
    },
    {
      action: '调校重测',
      actor: req.body.actor || operators[0],
      note: decision.passed
        ? '调校后重测达标，转待复核'
        : '调校后仍异常，保持待调：' + decision.failReasons.join('；'),
      data: { measurements }
    }
  );
  return res.json({ replaced: false, order: updated });
}));

// ── 复核（仅待复核，复核人须未参与调校） ──────────────────────────
router.post('/rod-inspections/:id/review', wrap(async (req, res) => {
  const order = await requireOrder(req.params.id);
  assertStatus(order, [judge.STATUS.PENDING_REVIEW]);

  const reviewer = judge.assertIndependentReviewer(order.operators, req.body.reviewer);
  const approved = req.body.approved !== false;
  const status = judge.judgeReview(approved);
  const review = {
    reviewer,
    approved,
    at: db.now(),
    note: typeof req.body.note === 'string' ? req.body.note.trim() : ''
  };
  const updated = await store.updateOrder(
    {
      ...order,
      status,
      reviews: [...order.reviews, review],
      trials: approved ? [] : order.trials
    },
    {
      action: approved ? '复核通过' : '复核退回',
      actor: reviewer,
      note: approved
        ? '复核人未参与调校，进入试演'
        : review.note || '复核未通过，退回待调',
      data: review
    }
  );
  res.json(updated);
}));

// ── 试演（仅试演中；两次间隔四小时达标才准登台） ─────────────────
router.post('/rod-inspections/:id/trials', wrap(async (req, res) => {
  const order = await requireOrder(req.params.id);
  assertStatus(order, [judge.STATUS.IN_TRIAL]);

  const passed = req.body.passed !== false;
  let atMs = Date.now();
  if (req.body.at !== undefined) {
    atMs = Date.parse(req.body.at);
    if (Number.isNaN(atMs)) throw judge.badRequest('at 必须是合法时间');
  }
  const result = judge.judgeTrial(order, { passed, atMs });
  const updated = await store.updateOrder(
    { ...order, status: result.status, trials: result.trials },
    {
      action: passed ? (result.approved ? '试演达标·准登台' : '试演达标') : '试演未达标',
      actor: (typeof req.body.actor === 'string' && req.body.actor.trim()) || '',
      note: result.reason,
      data: { passed, at: new Date(atMs).toISOString(), counted: result.counted }
    }
  );
  res.json({ ...updated, lastResult: { counted: result.counted, approved: result.approved, reason: result.reason } });
}));

module.exports = router;
