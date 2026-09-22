'use strict';

// 入口层：验收业务编排。判定委托 domain.js（纯规则），
// 存取委托 archive.js（归档），本层只组织流程、落事件、刷登台状态。
const db = require('./db');
const archive = require('./archive');
const D = require('./domain');

function conflictMessage(conflicts) {
  const lines = conflicts.map((conflict) => {
    const fields = conflict.fields.join('、');
    return fields + '已被验收单 ' + conflict.id + '（偶头 ' + conflict.puppetHeadId + '，' + conflict.status + '）首单占用';
  });
  return '设备重复占用，只认首单：' + lines.join('；');
}

// 登记验收单：三件套编号齐全、测量值与两名操纵员齐全；
// 改杆件/配重重登自动作废原单；跨头重复占用只认首单；不合格只转待调。
function registerAcceptance(body, actor) {
  const values = D.validateMeasurements(body);
  const head = archive.getHead(values.puppetHeadId);
  if (!head) D.fail(404, '偶头不存在：' + values.puppetHeadId);

  const stuck = Boolean(body.stuck);
  const verdict = D.evaluate({ ...values, stuck });

  return db.transaction(() => {
    const previous = archive.listByHead(values.puppetHeadId).filter((record) =>
      D.ACTIVE_STATUSES.includes(record.status)
    );

    // 同一偶头：换操控杆或配重块才允许重登，并把原有效单全部作废
    const superseded = [];
    for (const record of previous) {
      const reasons = D.supersedeReasons(record, values);
      if (reasons.length) {
        archive.supersede(record, reasons, null, actor);
        superseded.push(record.id);
      }
    }
    if (previous.length > 0 && superseded.length === 0) {
      D.fail(409, '该偶头已有有效验收单，杆件与配重均未更换，原验收继续有效；如需处理请走调校/复核/试演入口');
    }

    // 重复占用只认首单（作废后的旧单不再占位）
    const others = archive
      .listActive()
      .filter((record) => !superseded.includes(record.id));
    const conflicts = D.equipmentConflicts(values, others);
    if (conflicts.length) D.fail(409, conflictMessage(conflicts));

    const status = verdict.pass ? D.STATUS_PENDING_REVIEW : D.STATUS_REGISTERED;
    let saved = archive.insertAcceptance({
      ...values,
      stuck,
      status,
      verdict,
      trialAudit: [],
      supersededAcceptanceIds: superseded
    });
    archive.addEvent({
      recordId: saved.id,
      collection: archive.ACCEPTANCES,
      action: '登记验收',
      status,
      actor: actor || '',
      note: verdict.pass ? '登记测量合格，待复核' : '判定不合格：' + verdict.failures.join('、') + '，转待调',
      data: { ...values, stuck, verdict, supersededAcceptanceIds: superseded }
    });
    // 作废单事件回填新单编号
    for (const oldId of superseded) {
      archive.addEvent({
        recordId: oldId,
        collection: archive.ACCEPTANCES,
        action: '新验收承接',
        status: D.STATUS_SUPERSEDED,
        actor: actor || '',
        note: '由新验收单 ' + saved.id + ' 承接',
        data: { newAcceptanceId: saved.id }
      });
    }
    saved = archive.getAcceptance(saved.id);
    const refreshedHead = archive.reconcileHead(values.puppetHeadId);
    return { acceptance: saved, head: refreshedHead };
  });
}

// 调校：只能改测量值与卡滞情况；重新判定，合格转待复核，仍不合格留待调。
function adjustAcceptance(id, body, actor) {
  const record = archive.getAcceptance(id);
  if (!record) D.fail(404, '验收单不存在');
  D.assertStatus(record, [D.STATUS_REGISTERED], '只有待调状态的验收单可以调校');
  D.assertNoEquipmentChange(record, body);

  if (D.isBlank(body.adjuster)) D.fail(400, '缺少必填项：调校人');
  const adjuster = String(body.adjuster).trim();

  const values = {
    rodLengthCm: D.isBlank(body.rodLengthCm) ? record.rodLengthCm : Number(body.rodLengthCm),
    reboundSeconds: D.isBlank(body.reboundSeconds) ? record.reboundSeconds : Number(body.reboundSeconds),
    peakPullN: D.isBlank(body.peakPullN) ? record.peakPullN : Number(body.peakPullN),
    weightDeviationG: D.isBlank(body.weightDeviationG) ? record.weightDeviationG : Number(body.weightDeviationG),
    stuck: Object.prototype.hasOwnProperty.call(body, 'stuck') ? Boolean(body.stuck) : Boolean(record.stuck)
  };
  for (const [key, label] of [
    ['rodLengthCm', '杆长'],
    ['reboundSeconds', '回弹秒数'],
    ['peakPullN', '拉力峰值']
  ]) {
    if (!Number.isFinite(values[key]) || values[key] <= 0) D.fail(400, label + '必须是正数');
  }
  if (!Number.isFinite(values.weightDeviationG) || values.weightDeviationG < 0) {
    D.fail(400, '配重偏差必须是非负数');
  }

  const verdict = D.evaluate(values);
  const status = verdict.pass ? D.STATUS_PENDING_REVIEW : D.STATUS_REGISTERED;

  return db.transaction(() => {
    let saved = archive.updateAcceptance({
      ...record,
      ...values,
      adjuster,
      status,
      verdict,
      adjustedAt: archive.now()
    });
    archive.addEvent({
      recordId: id,
      collection: archive.ACCEPTANCES,
      action: '调校登记',
      status,
      actor: actor || '',
      note: '调校人 ' + adjuster + '；' + (verdict.pass ? '复测合格，待未参与人员复核' : '仍不合格：' + verdict.failures.join('、')),
      data: { ...values, adjuster, verdict }
    });
    saved = archive.getAcceptance(id);
    const head = archive.reconcileHead(record.puppetHeadId);
    return { acceptance: saved, head };
  });
}

// 换提线轮：规则只规定换杆件/配重才失效，故换轮保留原验收状态，
// 但新轮号不得被其他有效单占用（首单占用）。任何有效状态都可登记。
function changeWheel(id, body, actor) {
  const record = archive.getAcceptance(id);
  if (!record) D.fail(404, '验收单不存在');
  D.assertStatus(record, D.ACTIVE_STATUSES, '已失效的验收单不能换轮，请重新登记');
  if (D.isBlank(body.wheelId)) D.fail(400, '缺少必填项：新提线轮编号');
  const wheelId = String(body.wheelId).trim();
  if (wheelId === record.wheelId) D.fail(400, '新提线轮编号与原编号相同');

  const occupied = D.wheelOccupiedByOthers(
    wheelId,
    archive.listActive().filter((item) => item.id !== id)
  );
  if (occupied.length) {
    const who = occupied.map((item) => item.id + '（偶头 ' + item.puppetHeadId + '）').join('、');
    D.fail(409, '提线轮 ' + wheelId + ' 已被验收单 ' + who + ' 首单占用');
  }

  return db.transaction(() => {
    const previousWheelId = record.wheelId;
    archive.updateAcceptance({ ...record, wheelId, wheelChangedAt: archive.now() });
    archive.addEvent({
      recordId: id,
      collection: archive.ACCEPTANCES,
      action: '更换提线轮',
      status: record.status,
      actor: actor || '',
      note: '提线轮 ' + previousWheelId + ' 更换为 ' + wheelId + '；规则未规定换轮失效，验收状态维持' + record.status,
      data: { previousWheelId, wheelId }
    });
    const acceptance = archive.getAcceptance(id);
    const head = archive.reconcileHead(record.puppetHeadId);
    return { acceptance, head };
  });
}

// 复核：复核人必须是未参与登记与调校的人员；通过则进试演，否则退回待调。
function reviewAcceptance(id, body, actor) {
  const record = archive.getAcceptance(id);
  if (!record) D.fail(404, '验收单不存在');
  D.assertStatus(record, [D.STATUS_PENDING_REVIEW], '只有待复核状态的验收单可以复核');
  const reviewer = D.assertReviewer(record, body.reviewer);

  const pass = Boolean(body.pass);
  const status = pass ? D.STATUS_TRIAL : D.STATUS_REGISTERED;

  return db.transaction(() => {
    archive.updateAcceptance(
      pass
        ? { ...record, reviewer, reviewedAt: archive.now(), status, trialAudit: [] }
        : { ...record, reviewer, reviewedAt: archive.now(), status, reviewRejected: true }
    );
    archive.addEvent({
      recordId: id,
      collection: archive.ACCEPTANCES,
      action: '复核',
      status,
      actor: actor || reviewer,
      note: '复核人 ' + reviewer + '（未参与登记/调校）；' + (pass ? '复核通过，进入隔时试演' : '复核未通过，退回待调'),
      data: { reviewer, pass }
    });
    const acceptance = archive.getAcceptance(id);
    const head = archive.reconcileHead(record.puppetHeadId);
    return { acceptance, head };
  });
}

// 试演：试演中可反复登记；两次达标且相隔至少四小时才准登台（准演）。
function trialAcceptance(id, body, actor) {
  const record = archive.getAcceptance(id);
  if (!record) D.fail(404, '验收单不存在');
  D.assertStatus(record, [D.STATUS_TRIAL], '只有试演中状态的验收单可以登记试演');

  const pass = Boolean(body.pass);
  const atIso = body.performedAt || archive.now();
  const atMs = D.parseTime(body.performedAt, '试演');

  const previousTrials = Array.isArray(record.trialAudit) ? record.trialAudit.filter((trial) => trial.pass) : [];
  // 达标试演全量保留供间隔核验；一旦不达标，此前试演作废，回待调重来
  const trialAudit = pass
    ? [...previousTrials, { pass, at: atIso, atMs, note: body.note || '' }]
    : [{ pass, at: atIso, atMs, note: body.note || '' }];

  const qualified = pass && D.qualifiesAfterTrials(trialAudit);
  const status = qualified ? D.STATUS_APPROVED : pass ? D.STATUS_TRIAL : D.STATUS_REGISTERED;

  return db.transaction(() => {
    archive.updateAcceptance({
      ...record,
      status,
      trialAudit,
      lastTrialAt: atIso,
      ...(qualified ? { approvedAt: archive.now() } : {})
    });
    archive.addEvent({
      recordId: id,
      collection: archive.ACCEPTANCES,
      action: '试演登记',
      status,
      actor: actor || '',
      note: qualified
        ? '两次试演均达标且相隔不少于四小时，准登台'
        : pass
          ? '本次试演达标，尚需另一次间隔四小时以上的达标试演'
          : '本次试演未达标，退回待调',
      data: { pass, performedAt: atIso, trialAudit }
    });
    const acceptance = archive.getAcceptance(id);
    const head = archive.reconcileHead(record.puppetHeadId);
    return { acceptance, head };
  });
}

// 单头履历：偶头档案 + 全部验收单（含已失效，旧值可查）+ 登台状态，读同一份归档。
function headHistory(headId) {
  const head = archive.getHead(headId);
  if (!head) D.fail(404, '偶头不存在：' + headId);
  const acceptances = archive.listByHead(headId).map((record) => ({
    acceptance: record,
    events: archive.listEvents(record.id)
  }));
  const stage = archive.stageStateFor(headId);
  return {
    head,
    stage,
    acceptances,
    headEvents: archive.listEvents(headId)
  };
}

module.exports = {
  registerAcceptance,
  adjustAcceptance,
  changeWheel,
  reviewAcceptance,
  trialAcceptance,
  headHistory
};
