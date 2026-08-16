/**
 * 复杂记账（一句话多意图拆分）测试集 — 30 题
 *
 * 量化"复杂记账"能力：多意图句子拆分为多笔账单的准确性。
 * 分类分布（核心为主 + 边界 + 安全）：
 *   正确拆分 10 / 不误拆 6 / 缺金额追问 4 / 收支混合 4 / 金额格式边界 4 / 非记账 2
 *
 * 标准答案口径（可接受集合）：
 *   - multi:  期望拆出 n 笔；每笔断言 amount(±0.01) + category(按 nlu 词库可推导) + type
 *   - single: 期望不拆分（返回 null，走单笔路径）——含"缺金额子句"（追问由上层处理）
 *
 * 生成：2026-08-16（部署后），跑法：node scripts/run_multi_record_eval.mjs
 */
export const multiRecordCases = [
  // ========== A. 正确拆分（10） ==========
  { name: '奶茶20和地铁5块', category: '拆分', input: '奶茶20和地铁5块',
    expect: { multi: true, n: 2, records: [
      { amount: 20, category: '餐饮', type: 'expense' },
      { amount: 5, category: '交通', type: 'expense' } ] } },
  { name: '早餐8、咖啡15还有打车30', category: '拆分', input: '早餐8、咖啡15还有打车30',
    expect: { multi: true, n: 3, records: [
      { amount: 8, category: '餐饮' }, { amount: 15, category: '餐饮' },
      { amount: 30, category: '交通' } ] } },
  { name: '中午外卖25和下午打车12', category: '拆分', input: '中午外卖25和下午打车12',
    expect: { multi: true, n: 2, records: [
      { amount: 25, category: '餐饮' }, { amount: 12, category: '交通' } ] } },
  { name: '买菜35、水果20还有公交2块', category: '拆分', input: '买菜35、水果20还有公交2块',
    expect: { multi: true, n: 3, records: [
      { amount: 35, category: '购物' }, { amount: 20, category: '其他' },
      { amount: 2, category: '交通' } ] } },
  { name: '电影票40和爆米花25', category: '拆分', input: '电影票40和爆米花25',
    expect: { multi: true, n: 2, records: [
      { amount: 40, category: '娱乐' }, { amount: 25, category: '其他' } ] } },
  { name: '高铁票120和酒店200', category: '拆分', input: '高铁票120和酒店200',
    expect: { multi: true, n: 2, records: [
      { amount: 120, category: '交通' }, { amount: 200, category: '其他' } ] } },
  { name: '午饭15和晚饭28', category: '拆分', input: '午饭15和晚饭28',
    expect: { multi: true, n: 2, records: [
      { amount: 15, category: '餐饮' }, { amount: 28, category: '餐饮' } ] } },
  { name: '打车20、地铁3还有早餐10', category: '拆分', input: '打车20、地铁3还有早餐10',
    expect: { multi: true, n: 3, records: [
      { amount: 20, category: '交通' }, { amount: 3, category: '交通' },
      { amount: 10, category: '餐饮' } ] } },
  { name: '话费充50和流量包30', category: '拆分', input: '话费充50和流量包30',
    expect: { multi: true, n: 2, records: [
      { amount: 50, category: '通讯' }, { amount: 30, category: '通讯' } ] } },
  { name: '奶茶15和鸡排20', category: '拆分', input: '奶茶15和鸡排20',
    expect: { multi: true, n: 2, records: [
      { amount: 15, category: '餐饮' }, { amount: 20, category: '其他' } ] } },

  // ========== B. 不误拆（6） ==========
  { name: '和牛套餐88（和字误拆防御）', category: '不误拆', input: '和牛套餐88',
    expect: { multi: false } },
  { name: '家庭聚餐5人花了300（量词非金额）', category: '不误拆', input: '家庭聚餐5人花了300',
    expect: { multi: false } },
  { name: '和朋友吃饭花了120（和字前无数字）', category: '不误拆', input: '和朋友吃饭花了120',
    expect: { multi: false } },
  { name: '地铁和公交都坐了（无金额）', category: '不误拆', input: '地铁和公交都坐了',
    expect: { multi: false } },
  { name: '合计消费200', category: '不误拆', input: '合计消费200',
    expect: { multi: false } },
  { name: '今天和昨天共花了50（和字前后无金额）', category: '不误拆', input: '今天和昨天共花了50',
    expect: { multi: false } },

  // ========== C. 缺金额子句（4，期望不猜、走单笔/追问） ==========
  { name: '奶茶20和地铁（缺金额追问）', category: '追问', input: '奶茶20和地铁',
    expect: { multi: false } },
  { name: '早餐和咖啡15（缺金额追问）', category: '追问', input: '早餐和咖啡15',
    expect: { multi: false } },
  { name: '打车30还有晚饭（缺金额追问）', category: '追问', input: '打车30还有晚饭',
    expect: { multi: false } },
  { name: '买了奶茶和地铁5块（缺金额追问）', category: '追问', input: '买了奶茶和地铁5块',
    expect: { multi: false } },

  // ========== D. 收支混合（4） ==========
  { name: '工资8000和奶茶20', category: '收支混合', input: '工资8000和奶茶20',
    expect: { multi: true, n: 2, records: [
      { amount: 8000, type: 'income' }, { amount: 20, category: '餐饮', type: 'expense' } ] } },
  { name: '报销300和打车15', category: '收支混合', input: '报销300和打车15',
    expect: { multi: true, n: 2, records: [
      { amount: 300, type: 'income' }, { amount: 15, category: '交通', type: 'expense' } ] } },
  { name: '奖金500和晚餐50', category: '收支混合', input: '奖金500和晚餐50',
    expect: { multi: true, n: 2, records: [
      { amount: 500, type: 'income' }, { amount: 50, category: '餐饮', type: 'expense' } ] } },
  { name: '红包收100和午饭20', category: '收支混合', input: '红包收100和午饭20',
    expect: { multi: true, n: 2, records: [
      { amount: 100, type: 'income' }, { amount: 20, category: '餐饮', type: 'expense' } ] } },

  // ========== E. 金额/格式边界（4） ==========
  { name: '奶茶20.5和地铁3（小数金额）', category: '边界', input: '奶茶20.5和地铁3',
    expect: { multi: true, n: 2, records: [
      { amount: 20.5, category: '餐饮' }, { amount: 3, category: '交通' } ] } },
  { name: '奶茶200和地铁50（大额）', category: '边界', input: '奶茶200和地铁50',
    expect: { multi: true, n: 2, records: [
      { amount: 200, category: '餐饮' }, { amount: 50, category: '交通' } ] } },
  { name: '奶茶20、地铁5（顿号）', category: '边界', input: '奶茶20、地铁5',
    expect: { multi: true, n: 2, records: [
      { amount: 20, category: '餐饮' }, { amount: 5, category: '交通' } ] } },
  { name: '奶茶20，地铁5（逗号）', category: '边界', input: '奶茶20，地铁5',
    expect: { multi: true, n: 2, records: [
      { amount: 20, category: '餐饮' }, { amount: 5, category: '交通' } ] } },

  // ========== F. 非记账（2） ==========
  { name: '今天天气不错（无金额不拆）', category: '非记账', input: '今天天气不错',
    expect: { multi: false } },
  { name: '分析一下这个月的财务状况（分析意图）', category: '非记账', input: '分析一下这个月的财务状况',
    expect: { multi: false } },
]
