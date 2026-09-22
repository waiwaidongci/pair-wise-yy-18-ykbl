/**
 * 操控杆疲劳验收 —— 判定层
 * 只做规则判定与数值校验，不接触数据库，不感知 HTTP。
 */

const COLLECTION = 'rodInspections';

// 验收阈值
const REBOUND_LIMIT_SECONDS = 1.8; // 回弹秒数超过（不含）此值即转待调
const WEIGHT_DEVIATION_LIMIT_GRAMS = 50; // 配重偏差超过（不含）此值即转待调
const TRIAL_GAP_HOURS = 4; // 两次试演需间隔至少四小时
const TRIAL_PASS_COUNT = 2; // 连续两次达标方可登台

const STATUS = {
  PENDING_TUNE: '待调',
  PENDING_REVIEW: '待复核',
  IN_TRIAL: '试演中',
  APPROVED: '准登台',
  INVALIDATED: '已失效'
};

const STATUSES = Object.values(STATUS);
// 仍占用编号、禁止同号再开单的状态（准登台/已失效释放占用）
const ACTIVE_STATUSES = [STATUS.PENDING_TUNE, STATUS.PENDING_REVIEW, STATUS.IN_TRIAL];
// 有效验收状态：准登台
const PASS_STATUSES = [STATUS.APPROVED];

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function conflict(message) {
  const error = new Error(message);
  error.status = 409;
  return error;
}

function toNumber(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest(field + ' 必须为数字');
  return n;
}

function trimString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw badRequest(field + '不能为空');
  return value.trim();
}

/**
 * 解析并校验一次登记/调校上报的测量数据。
 * rodLengthCm 杆长、reboundSeconds 回弹秒数、pullPeakN 拉力峰值为数值必填；
 * weightDeviationG 配重偏差为数值必填；jamming 是否卡滞可缺省为 false。
 */
function parseMeasurements(body) {
  return {
    rodLengthCm: toNumber(body.rodLengthCm, '杆长(rodLengthCm)'),
    reboundSeconds: toNumber(body.reboundSeconds, '回弹秒数(reboundSeconds)'),
    pullPeakN: toNumber(body.pullPeakN, '拉力峰值(pullPeakN)'),
    weightDeviationG: toNumber(body.weightDeviationG, '配重偏差(weightDeviationG)'),
    jamming: body.jamming === true || body.jamming === 'true'
  };
}

/** 解析登记单：偶头、操控杆/提线轮/配重块编号齐全，两名操纵员且不得为同一人。 */
function parseRegistration(body) {
  if (!body || typeof body !== 'object') throw badRequest('请求体不能为空');
  const puppetHeadId = trimString(body.puppetHeadId, '偶头编号(puppetHeadId)');
  const rodNo = trimString(body.rodNo, '操控杆编号(rodNo)');
  const pulleyNo = trimString(body.pulleyNo, '提线轮编号(pulleyNo)');
  const weightNo = trimString(body.weightNo, '配重块编号(weightNo)');
  const operatorA = trimString(body.operatorA, '操纵员甲(operatorA)');
  const operatorB = trimString(body.operatorB, '操纵员乙(operatorB)');
  if (operatorA === operatorB) throw badRequest('两名操纵员不能为同一人');
  return {
    puppetHeadId,
    rodNo,
    pulleyNo,
    weightNo,
    operators: [operatorA, operatorB],
    measurements: parseMeasurements(body),
    note: typeof body.note === 'string' ? body.note.trim() : ''
  };
}

/**
 * 卡滞、回弹超 1.8 秒或配重偏差超 50 克 —— 只转待调；
 * 全部达标进入待复核（由未参与人员复核）。
 */
function judgeInitialStatus(measurements) {
  const failReasons = [];
  if (measurements.jamming) failReasons.push('操控杆卡滞');
  if (measurements.reboundSeconds > REBOUND_LIMIT_SECONDS) {
    failReasons.push('回弹' + measurements.reboundSeconds + '秒超过' + REBOUND_LIMIT_SECONDS + '秒');
  }
  if (Math.abs(measurements.weightDeviationG) > WEIGHT_DEVIATION_LIMIT_GRAMS) {
    failReasons.push(
      '配重偏差' + measurements.weightDeviationG + '克超过' + WEIGHT_DEVIATION_LIMIT_GRAMS + '克'
    );
  }
  return {
    passed: failReasons.length === 0,
    status: failReasons.length ? STATUS.PENDING_TUNE : STATUS.PENDING_REVIEW,
    failReasons
  };
}

/** 调校复核人必须是未参与人员（不得是两名操纵员之一）。 */
function assertIndependentReviewer(operators, reviewer) {
  const who = trimString(reviewer, '复核人(reviewer)');
  if (operators.map(String).includes(who)) {
    throw badRequest('复核须由未参与调校的人员完成，' + who + ' 是本次操纵员');
  }
  return who;
}

/** 复核结论：复核人独立判定通过则进试演，否则退回待调。 */
function judgeReview(approved) {
  return approved ? STATUS.IN_TRIAL : STATUS.PENDING_TUNE;
}

const TRIAL_GAP_MS = TRIAL_GAP_HOURS * 60 * 60 * 1000;

/**
 * 试演时间是否与上一次达标试演间隔至少四小时。
 * 首次达标试演自动满足间隔要求。
 */
function hasEnoughTrialGap(previousPassAt, atMs) {
  if (!previousPassAt) return true;
  return atMs - Date.parse(previousPassAt) >= TRIAL_GAP_MS;
}

/**
 * 根据一次试演结果推进状态。
 * - 不达标：退回待调，已累计试演清零
 * - 达标且与上次达标间隔不足四小时：留在试演中（本次不计数）
 * - 达标且间隔足够：累计一次；满两次准登台
 */
function judgeTrial(order, { passed, atMs }) {
  if (!passed) {
    return {
      status: STATUS.PENDING_TUNE,
      trials: [],
      counted: false,
      approved: false,
      reason: '试演未达标，退回待调'
    };
  }
  const previousPassAt = order.trials && order.trials.length ? order.trials[order.trials.length - 1].at : null;
  if (!hasEnoughTrialGap(previousPassAt, atMs)) {
    return {
      status: STATUS.IN_TRIAL,
      trials: order.trials || [],
      counted: false,
      approved: false,
      reason: '与上次达标试演间隔不足' + TRIAL_GAP_HOURS + '小时，本次不计入'
    };
  }
  const trials = [...(order.trials || []), { at: new Date(atMs).toISOString() }];
  const approved = trials.length >= TRIAL_PASS_COUNT;
  return {
    status: approved ? STATUS.APPROVED : STATUS.IN_TRIAL,
    trials,
    counted: true,
    approved,
    reason: approved ? '两次试演均达标且间隔不少于四小时，准予登台' : '第' + trials.length + '次试演达标'
  };
}

/** 调校时改了哪些部件（改杆件：操控杆或提线轮；改配重：配重块）。 */
function detectComponentChanges(before, next) {
  const changes = [];
  if (next.rodNo && next.rodNo !== before.rodNo) changes.push('rodNo');
  if (next.pulleyNo && next.pulleyNo !== before.pulleyNo) changes.push('pulleyNo');
  if (next.weightNo && next.weightNo !== before.weightNo) changes.push('weightNo');
  return changes;
}

function isActive(status) {
  return ACTIVE_STATUSES.includes(status);
}

module.exports = {
  COLLECTION,
  REBOUND_LIMIT_SECONDS,
  WEIGHT_DEVIATION_LIMIT_GRAMS,
  TRIAL_GAP_HOURS,
  TRIAL_PASS_COUNT,
  STATUS,
  STATUSES,
  ACTIVE_STATUSES,
  PASS_STATUSES,
  badRequest,
  conflict,
  parseRegistration,
  parseMeasurements,
  judgeInitialStatus,
  assertIndependentReviewer,
  judgeReview,
  hasEnoughTrialGap,
  judgeTrial,
  detectComponentChanges,
  isActive
};
