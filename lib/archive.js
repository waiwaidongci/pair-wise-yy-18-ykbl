'use strict';

// 归档层：验收单与偶头档案的持久化读写，以及登台状态对账。
// 只负责存取与状态落档，不做业务判定（判定见 domain.js）。
const { randomUUID } = require('crypto');
const db = require('./db');
const { ACTIVE_STATUSES, STATUS_APPROVED, STATUS_SUPERSEDED } = require('./domain');

const ACCEPTANCES = 'rodFatigueAcceptances';
const HEADS = 'puppetHeads';

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

function acceptanceTitle(data) {
  return [data.puppetHeadId, data.rodId, data.counterweightId].filter(Boolean).join(' / ');
}

function addEvent({ recordId, collection, action, status, actor, note, data }) {
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

function insertAcceptance(data) {
  const id = data.id || randomUUID();
  const timestamp = now();
  const status = data.status;
  const record = { ...data, id };
  db.run(
    'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    [id, ACCEPTANCES, status, acceptanceTitle(data), JSON.stringify(record), timestamp, timestamp]
  );
  return getAcceptance(id);
}

function updateAcceptance(data) {
  db.run(
    'UPDATE records SET status = ?, title = ?, data = ?, updated_at = ? WHERE collection = ? AND id = ?',
    [data.status, acceptanceTitle(data), JSON.stringify(data), now(), ACCEPTANCES, data.id]
  );
  return getAcceptance(data.id);
}

function getAcceptance(id) {
  const row = db.get('SELECT * FROM records WHERE collection = ? AND id = ? LIMIT 1', [ACCEPTANCES, id]);
  return row ? toRecord(row) : null;
}

function listAcceptances() {
  return db
    .all('SELECT * FROM records WHERE collection = ? ORDER BY updated_at DESC', [ACCEPTANCES])
    .map(toRecord);
}

function listByHead(headId) {
  return listAcceptances()
    .filter((record) => record.puppetHeadId === headId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function listActive() {
  return listAcceptances().filter((record) => ACTIVE_STATUSES.includes(record.status));
}

function listEvents(recordId) {
  return db
    .all('SELECT * FROM events WHERE record_id = ? ORDER BY created_at ASC, rowid ASC', [recordId])
    .map((event) => ({
      id: event.id,
      action: event.action,
      status: event.status,
      actor: event.actor,
      note: event.note,
      data: JSON.parse(event.data || '{}'),
      createdAt: event.created_at
    }));
}

function getHead(id) {
  const row = db.get('SELECT * FROM records WHERE collection = ? AND id = ? LIMIT 1', [HEADS, id]);
  return row ? toRecord(row) : null;
}

function listHeads() {
  return db.all('SELECT * FROM records WHERE collection = ? ORDER BY updated_at DESC', [HEADS]).map(toRecord);
}

function saveHead(record) {
  const { id, status, createdAt, collection, ...data } = record;
  const title = [data.role, data.play].filter(Boolean).join(' / ') || data.name || '';
  db.run(
    'UPDATE records SET status = ?, title = ?, data = ?, updated_at = ? WHERE collection = ? AND id = ?',
    [status, title, JSON.stringify({ ...data, status }), now(), HEADS, id]
  );
  return getHead(id);
}

// 登台状态：准演 -> 可登台；其余有效单（待调/待复核/试演中）-> 暂不可登台；
// 一张有效单都没有 -> 未验收。只写派生态，偶头本体状态（修补流转）不动。
function stageStateFor(headId) {
  const active = listByHead(headId).filter((record) => ACTIVE_STATUSES.includes(record.status));
  if (active.some((record) => record.status === STATUS_APPROVED)) {
    return { stageReady: true, stageStatus: '可登台', activeAcceptanceId: null };
  }
  if (active.length > 0) {
    const earliest = active[active.length - 1];
    return { stageReady: false, stageStatus: '暂不可登台', activeAcceptanceId: earliest.id };
  }
  return { stageReady: false, stageStatus: '未验收', activeAcceptanceId: null };
}

// 刷新偶头登台状态；列表、单头履历、登台入口读的都是这里落档的同一份结果。
function reconcileHead(headId) {
  const head = getHead(headId);
  if (!head) return null;
  const { stageReady, stageStatus, activeAcceptanceId } = stageStateFor(headId);
  if (head.stageStatus === stageStatus && head.stageReady === stageReady) return head;
  const next = { ...head, stageReady, stageStatus, activeAcceptanceId };
  saveHead(next);
  addEvent({
    recordId: headId,
    collection: HEADS,
    action: '登台状态刷新',
    status: stageStatus,
    actor: 'system',
    note: '按操控杆疲劳验收结果对账',
    data: { stageReady, stageStatus, activeAcceptanceId }
  });
  return getHead(headId);
}

function reconcileAll() {
  return db.transaction(() => listHeads().map((head) => reconcileHead(head.id)).filter(Boolean));
}

// 原验收作废（旧值仍在归档中可查，事件一并落档）。
function supersede(record, reasons, newAcceptanceId, actor) {
  const previousStatus = record.status;
  const next = { ...record, status: STATUS_SUPERSEDED };
  updateAcceptance(next);
  addEvent({
    recordId: record.id,
    collection: ACCEPTANCES,
    action: '作废原验收',
    status: STATUS_SUPERSEDED,
    actor: actor || 'system',
    note: '更换' + reasons.map((reason) => reason.label).join('、') + '，原验收失效；历史测量值保留可查',
    data: { reasons, previousStatus, newAcceptanceId }
  });
  return getAcceptance(record.id);
}

module.exports = {
  ACCEPTANCES,
  HEADS,
  now,
  toRecord,
  addEvent,
  insertAcceptance,
  updateAcceptance,
  getAcceptance,
  listAcceptances,
  listByHead,
  listActive,
  listEvents,
  getHead,
  listHeads,
  saveHead,
  stageStateFor,
  reconcileHead,
  reconcileAll,
  supersede
};
