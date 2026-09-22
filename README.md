# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱、返场缺损追踪与操控杆疲劳验收。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

SQLite数据库文件（标准SQLite格式）会在首次启动时创建到`data/app.db`。

## 常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `POST /api/tourBoxes`
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`

## 操控杆疲劳验收

验收单集合 `rodFatigueAcceptances` 为流程治理集合，**判定、归档与入口分开**：
通用 POST/PATCH/events/delete 对其关闭（返回 405），全部走专属入口 `/api/rod-fatigue/*`。
代码分层：`lib/domain.js`（判定规则）、`lib/archive.js`（归档/对账）、`lib/entries.js`（流程编排）、
`routes/rodFatigue.js`（HTTP 入口）。

验收规则：

1. 每次调试同一偶头须登记操控杆、提线轮、配重块三个编号，以及杆长、回弹秒数、拉力峰值和两名操纵员；缺一不收。
2. 设备编号重复占用**只认首单**：后到登记若与另一张有效验收单共用任一编号即被拒（已失效单不占位）。
3. 出现卡滞、回弹超过 1.8 秒、配重偏差超过 50 克任一项，只转「待调」（1.8 秒与 50 克本身合格）。
4. 调校后须由**未参与**登记（两名操纵员）与调校的人员复核；复核通过进入「试演中」，不通过退回「待调」。
5. 两次试演均达标且相隔至少四小时，才判「准演」准予登台；单次试演不达标退回「待调」重来。
6. 更换操控杆或配重块重新登记时，原验收单判「失效」并保留全部旧值与事件流（旧值可查）；只换提线轮不使验收失效，走换轮入口。

接口：

| 方法/路径 | 说明 |
| --- | --- |
| `POST /api/rod-fatigue/acceptances` | 登记验收（字段：puppetHeadId, rodId, wheelId, counterweightId, rodLengthCm, reboundSeconds, peakPullN, weightDeviationG, stuck, operatorA, operatorB） |
| `POST /api/rod-fatigue/acceptances/:id/adjust` | 调校登记（adjuster 必填；不得改杆件/配重编号） |
| `POST /api/rod-fatigue/acceptances/:id/change-wheel` | 更换提线轮（状态保留，仍查首单占用） |
| `POST /api/rod-fatigue/acceptances/:id/review` | 未参与人员复核（reviewer 必填，body.pass 表示通过与否） |
| `POST /api/rod-fatigue/acceptances/:id/trial` | 试演登记（pass, performedAt 可省，默认当前时间） |
| `GET /api/rod-fatigue/acceptances?status=&puppetHeadId=&rodId=` | 验收单列表（含失效单） |
| `GET /api/rod-fatigue/heads/:headId/history` | 单头履历：偶头、全部验收单（含已失效旧值）与事件流、登台状态 |
| `GET /api/rod-fatigue/stage` | 登台状态看板（可登台 / 暂不可登台 / 未验收） |

每次流程动作都会即时对账偶头的 `stageReady`/`stageStatus` 派生态，因此列表、单头履历与登台看板刷新后始终一致。
