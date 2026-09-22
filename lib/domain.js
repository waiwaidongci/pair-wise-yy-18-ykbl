'use strict';

// 判定层：操控杆疲劳验收的全部业务规则（纯函数，不碰数据库）。
// 阈值以业务术语集中声明，便于戏班验收标准变更时只改一处。

const REBOUND_LIMIT_SECONDS = 1.8; // 回弹秒数：超过一点八秒即不合格
const WEIGHT_DEVIATION_LIMIT_GRAMS = 50; // 配重偏差：超过五十克即不合格
const TRIAL_INTERVAL_MS = 4 * 60 * 60 * 1000; // 两次试演须相隔四小时
const REQUIRED_TRIALS = 2; // 两次达标试演才准登台

const STATUS_REGISTERED = '待调'; // 登记判定不通过，只转待调
const STATUS_PENDING_REVIEW = '待复核'; // 调校后等待未参与人员复核
const STATUS_TRIAL = '试演中'; // 复核通过，进入两次隔时试演
const STATUS_APPROVED = '准演'; // 试演达标，准登台
const STATUS_SUPERSEDED = '失效'; // 换杆件或配重后原验收失效

const ACTIVE_STATUSES = [
  STATUS_REGISTERED,
  STATUS_PENDING_REVIEW,
  STATUS_TRIAL,
  STATUS_APPROVED
];

const EQUIPMENT_FIELDS = [
  ['rodId', '操控杆'],
  ['wheelId', '提线轮'],
  ['counterweightId', '配重块']
];

const REGISTER_FIELDS = [
  ['puppetHeadId', '偶头'],
  ['rodId', '操控杆编号'],
  ['wheelId', '提线轮编号'],
  ['counterweightId', '配重块编号'],
  ['rodLengthCm', '杆长（厘米）'],
  ['reboundSeconds', '回弹秒数'],
  ['peakPullN', '拉力峰值（牛）'],
  ['weightDeviationG', '配重偏差（克）'],
  ['operatorA', '操纵员甲'],
  ['operatorB', '操纵员乙']
];

class DomainError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fail(status, message) {
  throw new DomainError(status, message);
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function assertNumber(body, field, label) {
  const raw = body[field];
  if (isBlank(raw)) fail(400, '缺少必填项：' + label);
  const value = Number(raw);
  if (!Number.isFinite(value)) fail(400, label + '必须是数字');
  return value;
}

// 登记/重新测量的完整性校验：三件套编号、杆长、回弹、拉力、两名操纵员齐全。
function validateMeasurements(body) {
  const values = {};
  for (const [field, label] of REGISTER_FIELDS) {
    if (isBlank(body[field])) fail(400, '缺少必填项：' + label);
  }
  values.rodLengthCm = assertNumber(body, 'rodLengthCm', '杆长');
  values.reboundSeconds = assertNumber(body, 'reboundSeconds', '回弹秒数');
  values.peakPullN = assertNumber(body, 'peakPullN', '拉力峰值');
  values.weightDeviationG = assertNumber(body, 'weightDeviationG', '配重偏差');
  for (const key of ['rodLengthCm', 'reboundSeconds', 'peakPullN']) {
    if (values[key] <= 0) fail(400, '杆长、回弹秒数和拉力峰值必须为正数');
  }
  if (values.weightDeviationG < 0) fail(400, '配重偏差不能为负数');
  if (String(body.operatorA).trim() === String(body.operatorB).trim()) {
    fail(400, '两名操纵员不能是同一人');
  }
  return {
    puppetHeadId: String(body.puppetHeadId).trim(),
    rodId: String(body.rodId).trim(),
    wheelId: String(body.wheelId).trim(),
    counterweightId: String(body.counterweightId).trim(),
    ...values,
    operatorA: String(body.operatorA).trim(),
    operatorB: String(body.operatorB).trim()
  };
}

// 卡滞 / 回弹超 1.8 秒 / 配重偏差超 50 克，任一命中即不合格。
function evaluate(values) {
  const failures = [];
  if (values.stuck) failures.push('卡滞');
  if (values.reboundSeconds > REBOUND_LIMIT_SECONDS) failures.push('回弹超' + REBOUND_LIMIT_SECONDS + '秒');
  if (values.weightDeviationG > WEIGHT_DEVIATION_LIMIT_GRAMS) failures.push('配重偏差超' + WEIGHT_DEVIATION_LIMIT_GRAMS + '克');
  return {
    pass: failures.length === 0,
    failures,
    limits: {
      reboundLimitSeconds: REBOUND_LIMIT_SECONDS,
      weightDeviationLimitGrams: WEIGHT_DEVIATION_LIMIT_GRAMS
    }
  };
}

function initialStatus(values) {
  const verdict = evaluate(values);
  // 不合格只转待调；合格则进入调校后的复核环节
  return verdict.pass ? STATUS_PENDING_REVIEW : STATUS_REGISTERED;
}

// 重复占用只认首单：任一设备编号已被另一张有效验收占用即拒绝。
function equipmentConflicts(values, others) {
  const conflicts = [];
  for (const other of others) {
    const fields = EQUIPMENT_FIELDS
      .filter(([field]) => other[field] === values[field])
      .map(([, label]) => label);
    if (fields.length) {
      conflicts.push({
        id: other.id,
        puppetHeadId: other.puppetHeadId,
        status: other.status,
        fields
      });
    }
  }
  return conflicts;
}

// 改杆件（操控杆编号）或配重（配重块编号）使原验收失效；只换提线轮不算。
function supersedeReasons(previous, values) {
  const reasons = [];
  if (previous.rodId !== values.rodId) {
    reasons.push({ field: 'rodId', label: '操控杆', from: previous.rodId, to: values.rodId });
  }
  if (previous.counterweightId !== values.counterweightId) {
    reasons.push({ field: 'counterweightId', label: '配重块', from: previous.counterweightId, to: values.counterweightId });
  }
  return reasons;
}

// 调校由未参与人员复核：复核人与两名操纵员均不得相同。
function assertReviewer(record, reviewer) {
  if (isBlank(reviewer)) fail(400, '缺少必填项：复核人');
  const name = String(reviewer).trim();
  const participants = [record.operatorA, record.operatorB]
    .concat(record.adjuster ? [record.adjuster] : []);
  if (participants.includes(name)) {
    fail(409, '复核必须由未参与登记与调校的人员执行');
  }
  return name;
}

function assertStatus(record, allowed, message) {
  if (!allowed.includes(record.status)) {
    fail(409, message || '当前状态（' + record.status + '）不允许此操作');
  }
}

// 调校只允许改测量值与杆件之外的编号：杆/配重绝不能在此换（换件必须重新登记）；
// 规则只规定改杆件或配重才失效，故只换提线轮允许在此登记且不影响验收效力。
function assertNoEquipmentChange(record, body) {
  for (const [field, label] of [
    ['rodId', '操控杆'],
    ['counterweightId', '配重块']
  ]) {
    if (!isBlank(body[field]) && String(body[field]).trim() !== record[field]) {
      fail(400, '调校不得更换' + label + '，更换' + label + '请重新登记（原验收将失效）');
    }
  }
  if (!isBlank(body.puppetHeadId) && String(body.puppetHeadId).trim() !== record.puppetHeadId) {
    fail(400, '调校不得更换偶头，请重新登记');
  }
}

// 提线轮被另一张有效单占用时同样不允许换入（首单占用规则覆盖三件套）。
function wheelOccupiedByOthers(wheelId, others) {
  return others.filter((record) => record.wheelId === wheelId);
}

function parseTime(value, label) {
  if (isBlank(value)) return Date.now();
  const time = Date.parse(value);
  if (Number.isNaN(time)) fail(400, label + '时间格式无效');
  return time;
}

// 两次试演均达标且相隔至少四小时（达标试演全量保留，从中取最近一对核验间隔）。
function qualifiesAfterTrials(trials) {
  const passed = (trials || []).filter((trial) => trial.pass).map((trial) => trial.atMs).sort((a, b) => a - b);
  if (passed.length < REQUIRED_TRIALS) return false;
  const latest = passed[passed.length - 1];
  return passed.slice(0, -1).some((time) => latest - time >= TRIAL_INTERVAL_MS);
}

module.exports = {
  REBOUND_LIMIT_SECONDS,
  WEIGHT_DEVIATION_LIMIT_GRAMS,
  TRIAL_INTERVAL_MS,
  REQUIRED_TRIALS,
  STATUS_REGISTERED,
  STATUS_PENDING_REVIEW,
  STATUS_TRIAL,
  STATUS_APPROVED,
  STATUS_SUPERSEDED,
  ACTIVE_STATUSES,
  EQUIPMENT_FIELDS,
  DomainError,
  fail,
  isBlank,
  validateMeasurements,
  evaluate,
  initialStatus,
  equipmentConflicts,
  supersedeReasons,
  assertReviewer,
  assertStatus,
  assertNoEquipmentChange,
  wheelOccupiedByOthers,
  parseTime,
  qualifiesAfterTrials
};
