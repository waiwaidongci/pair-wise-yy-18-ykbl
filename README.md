# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱、返场缺损追踪，以及操控杆疲劳验收。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

## 常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `POST /api/tourBoxes`
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`

SQLite数据库文件会在首次启动时创建到`data/app.db`。

## 操控杆疲劳验收

每次调试同一偶头须登记一张验收单：操控杆编号 `rodNo`、提线轮编号 `pulleyNo`、配重块编号 `weightNo` 齐全，
同一编号在在途验收单（待调/待复核/试演中）中只认首单，重复占用直接拒收（409）。

登记字段：杆长 `rodLengthCm`(cm)、回弹秒数 `reboundSeconds`(s)、拉力峰值 `pullPeakN`(N)、
配重偏差 `weightDeviationG`(g)、是否卡滞 `jamming`、两名操纵员 `operatorA`/`operatorB`。

判定规则（`lib/rodJudge.js`）：

- 卡滞、回弹超 1.8 秒或配重偏差超 50 克 —— 只转 `待调`
- 初测达标 —— 转 `待复核`，须由未参与调校的人员复核
- 复核通过进 `试演中`；两次达标试演间隔不少于四小时才转 `准登台`
- 试演不达标退回 `待调`，已计次清零
- 调校时改杆件（操控杆/提线轮）或配重块 —— 原验收转 `已失效`，另开新单接续，旧值履历可查

验收单接口（专用入口，与通用集合接口分离）：

- `POST /api/rod-inspections` 登记验收
- `POST /api/rod-inspections/:id/tune` 调校（可带新编号/新测量值）
- `POST /api/rod-inspections/:id/review` 复核 `{ reviewer, approved }`
- `POST /api/rod-inspections/:id/trials` 试演 `{ passed, at? }`
- `GET /api/rod-inspections?puppetHeadId=&status=` 验收单列表
- `GET /api/rod-inspections/:id` 验收单详情（含履历事件）
- `GET /api/rod-inspections/by-head/:puppetHeadId/history` 单头履历
- `GET /api/stage-status` / `GET /api/puppetHeads/:puppetHeadId/stage-status` 登台状态

列表、单头履历与登台状态由同一份归档数据即时派生，刷新后一致；
偶头列表（`GET /api/puppetHeads`）附带 `rodStageReady` 字段。

代码分层：`lib/rodJudge.js`（判定）、`lib/rodStore.js`（归档）、`lib/rodRoutes.js`（入口）。
