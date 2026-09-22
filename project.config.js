module.exports = {
  port: 3914,
  title: '传统木偶戏班偶头与巡演装箱API',
  description: '维护偶头、服装配件、修补流转、巡演装箱、返场缺损追踪与操控杆疲劳验收。',
  collections: {
    puppetHeads: {
      label: '偶头档案',
      defaultStatus: '可演出',
      statuses: ['可演出', '待修补', '修补中', '试演中', '不可演出', '已装箱'],
      required: ['role', 'play', 'paintStatus', 'mechanism', 'boxNo'],
      titleFields: ['role', 'play'],
      defaults: { currentUsable: true }
    },
    accessories: {
      label: '服装配件',
      defaultStatus: '在库',
      statuses: ['在库', '已装箱', '缺损', '遗失'],
      required: ['name', 'role', 'play', 'boxNo'],
      titleFields: ['name', 'role']
    },
    repairRecords: {
      label: '修补记录',
      defaultStatus: '待处理',
      statuses: ['待处理', '补漆中', '换线中', '修机关中', '换眼珠中', '试演中', '已完成'],
      required: ['puppetHeadId', 'repairType', 'handler'],
      titleFields: ['repairType', 'handler']
    },
    tourBoxes: {
      label: '巡演装箱单',
      defaultStatus: '草稿',
      statuses: ['草稿', '已装箱', '巡演中', '返场清点中', '已闭环'],
      required: ['showName', 'venue', 'play', 'headIds', 'accessoryIds'],
      titleFields: ['showName', 'play']
    },
    lossReports: {
      label: '缺损追踪',
      defaultStatus: '待处理',
      statuses: ['待处理', '修复中', '已补齐', '确认为遗失'],
      required: ['tourBoxId', 'itemType', 'itemName', 'problem'],
      titleFields: ['itemName', 'problem']
    },
    rodFatigueAcceptances: {
      label: '操控杆疲劳验收',
      governed: true,
      defaultStatus: '待调',
      statuses: ['待调', '待复核', '试演中', '准演', '失效'],
      required: [
        'puppetHeadId',
        'rodId',
        'wheelId',
        'counterweightId',
        'rodLengthCm',
        'reboundSeconds',
        'peakPullN',
        'weightDeviationG',
        'operatorA',
        'operatorB'
      ],
      titleFields: ['puppetHeadId', 'rodId']
    }
  },
  seed: [
    {
      collection: 'puppetHeads',
      id: 'head-seed-1',
      status: '待修补',
      data: {
        role: '武生',
        play: '火焰山',
        paintStatus: '左颊掉彩',
        mechanism: '开口机关偏紧',
        accessories: ['红缨冠', '短靠'],
        boxNo: '木箱乙-04',
        currentUsable: false
      },
      note: '返场发现掉彩'
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-1',
      status: '在库',
      data: {
        name: '红缨冠',
        role: '武生',
        play: '火焰山',
        boxNo: '配件箱-02'
      }
    },
    {
      // 历史验收：已因更换操控杆作废，旧测量值仍保留在归档中可查
      collection: 'rodFatigueAcceptances',
      id: 'rod-acc-seed-1',
      status: '失效',
      eventAction: '登记验收',
      actor: '周班主',
      note: '历史验收单（换杆后失效，旧值可查）',
      data: {
        puppetHeadId: 'head-seed-1',
        rodId: 'gan-jia-02',
        wheelId: 'lun-jia-01',
        counterweightId: 'zhong-jia-03',
        rodLengthCm: 62,
        reboundSeconds: 1.2,
        peakPullN: 28.5,
        weightDeviationG: 20,
        stuck: false,
        operatorA: '陈阿福',
        operatorB: '林小翠',
        verdict: {
          pass: true,
          failures: [],
          limits: { reboundLimitSeconds: 1.8, weightDeviationLimitGrams: 50 }
        },
        trialAudit: []
      }
    }
  ],
  examples: [
    'GET /api/puppetHeads?play=火焰山&status=可演出 查询某剧目可用偶头',
    'POST /api/tourBoxes 创建巡演装箱单',
    'POST /api/lossReports 登记返场缺损或遗失',
    'POST /api/rod-fatigue/acceptances 登记操控杆疲劳验收（三件套编号+杆长/回弹/拉力+两名操纵员）',
    'POST /api/rod-fatigue/acceptances/:id/adjust 调校登记（卡滞/回弹>1.8秒/配重偏差>50克只转待调）',
    'POST /api/rod-fatigue/acceptances/:id/review 未参与人员复核',
    'POST /api/rod-fatigue/acceptances/:id/trial 试演登记（两次相隔四小时达标方准登台）',
    'GET /api/rod-fatigue/heads/:headId/history 单头验收履历（含已失效旧值）',
    'GET /api/rod-fatigue/stage 登台状态看板'
  ]
};
