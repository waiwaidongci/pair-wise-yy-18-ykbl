'use strict';

// 入口路由：操控杆疲劳验收专属入口，与通用台账接口分开。
// 判定/归档不经通用 PATCH/events，全部走这里的编排入口。
const express = require('express');
const archive = require('../lib/archive');
const entries = require('../lib/entries');
const { DomainError } = require('../lib/domain');

const router = express.Router();

function actorOf(req) {
  return (req.body && (req.body.actor || req.body.operator || '')) || '';
}

function handle(fn) {
  return (req, res, next) => {
    try {
      fn(req, res);
    } catch (error) {
      if (error instanceof DomainError) {
        return res.status(error.status).json({ error: error.message });
      }
      next(error);
    }
  };
}

// 验收单列表（刷新后与单头履历、登台状态一致——均直接读归档）
router.get('/acceptances', (req, res, next) => {
  try {
    let records = archive.listAcceptances();
    if (req.query.status) records = records.filter((record) => record.status === req.query.status);
    if (req.query.puppetHeadId) {
      records = records.filter((record) => record.puppetHeadId === req.query.puppetHeadId);
    }
    if (req.query.rodId) records = records.filter((record) => record.rodId === req.query.rodId);
    res.json(records);
  } catch (error) {
    next(error);
  }
});

// 登台状态看板：偶头登台状态以验收归档对账结果为准
router.get('/stage', (req, res, next) => {
  try {
    const heads = archive.listHeads().map((head) => ({
      id: head.id,
      role: head.role,
      play: head.play,
      status: head.status,
      stageReady: head.stageReady,
      stageStatus: head.stageStatus,
      activeAcceptanceId: head.activeAcceptanceId
    }));
    res.json(heads);
  } catch (error) {
    next(error);
  }
});

// 单头履历：含已失效验收单旧值与完整事件流
router.get('/heads/:headId/history', handle((req, res) => {
  res.json(entries.headHistory(req.params.headId));
}));

// 登记
router.post('/acceptances', handle((req, res) => {
  const result = entries.registerAcceptance(req.body || {}, actorOf(req));
  res.status(201).json(result);
}));

// 调校
router.post('/acceptances/:id/adjust', handle((req, res) => {
  res.json(entries.adjustAcceptance(req.params.id, req.body || {}, actorOf(req)));
}));

// 更换提线轮（不影响验收效力，原状态保留）
router.post('/acceptances/:id/change-wheel', handle((req, res) => {
  res.json(entries.changeWheel(req.params.id, req.body || {}, actorOf(req)));
}));

// 未参与人员复核
router.post('/acceptances/:id/review', handle((req, res) => {
  res.json(entries.reviewAcceptance(req.params.id, req.body || {}, actorOf(req)));
}));

// 试演
router.post('/acceptances/:id/trial', handle((req, res) => {
  res.json(entries.trialAcceptance(req.params.id, req.body || {}, actorOf(req)));
}));

module.exports = router;
