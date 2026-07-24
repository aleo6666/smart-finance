/**
 * 3 Agent 架构冒烟测试
 * 验证主控 + 检索 + 计算 Agent 的主从协同流程
 *
 * 运行方式：node src/scripts/test-3agent.js
 */

import masterAgent from '../services/masterAgent.js'
import retrievalAgent, { RETRIEVAL_TYPES } from '../services/retrievalAgent.js'
import calculatorAgent, { CALCULATION_TYPES } from '../services/calculatorAgent.js'

const TEST_USER_ID = 1  // 假设用户ID为1，实际使用时替换

async function testRetrievalAgent() {
  console.log('\n=== 测试检索 Agent ===')

  // 测试1: 财务汇总查询
  console.log('\n1. 财务汇总查询...')
  const r1 = await retrievalAgent.execute({
    type: RETRIEVAL_TYPES.FINANCE_SUMMARY,
    userId: TEST_USER_ID,
    params: { hints: {} }
  })
  console.log('   结果:', r1.success ? `成功 - ${r1.data.count} 条记录，总计 ${r1.data.total?.toFixed(2)} 元` : `失败 - ${r1.error}`)

  // 测试2: 预算配置查询
  console.log('\n2. 预算配置查询...')
  const r2 = await retrievalAgent.execute({
    type: RETRIEVAL_TYPES.BUDGET_CONFIG,
    userId: TEST_USER_ID,
    params: {}
  })
  console.log('   结果:', r2.success ? `成功 - ${r2.data.count} 条预算` : `失败 - ${r2.error}`)

  // 测试3: 分类统计查询
  console.log('\n3. 分类统计查询...')
  const r3 = await retrievalAgent.execute({
    type: RETRIEVAL_TYPES.CATEGORY_STATS,
    userId: TEST_USER_ID,
    params: {}
  })
  console.log('   结果:', r3.success ? `成功 - ${r3.data.stats?.length} 个分类` : `失败 - ${r3.error}`)

  return { r1, r2, r3 }
}

async function testCalculatorAgent() {
  console.log('\n=== 测试计算 Agent ===')

  // 测试1: 预算执行计算
  console.log('\n1. 预算执行计算...')
  const c1 = await calculatorAgent.execute({
    type: CALCULATION_TYPES.BUDGET_EXECUTION,
    params: {
      budgets: [
        { category: 'total', amount: 5000 },
        { category: '餐饮', amount: 2000 }
      ],
      categoryStats: [
        { category: '餐饮', total: 1800 },
        { category: '交通', total: 500 }
      ],
      totalSpending: 3500
    }
  })
  console.log('   结果:', c1.success ? `成功 - ${c1.data.summary.overCount} 项超支, ${c1.data.summary.warningCount} 项预警` : `失败 - ${c1.error}`)

  // 测试2: 周期对比计算
  console.log('\n2. 周期对比计算...')
  const c2 = await calculatorAgent.execute({
    type: CALCULATION_TYPES.PERIOD_COMPARISON,
    params: {
      current: { total: 3500, count: 45 },
      previous: { total: 3000, count: 40 },
      periodLabel: '环比'
    }
  })
  console.log('   结果:', c2.success ? `成功 - 趋势: ${c2.data.trend}, 差额: ${c2.data.diff.amount} 元 (${c2.data.diff.percent}%)` : `失败 - ${c2.error}`)

  // 测试3: 分类占比计算
  console.log('\n3. 分类占比计算...')
  const c3 = await calculatorAgent.execute({
    type: CALCULATION_TYPES.CATEGORY_RATIO,
    params: {
      categoryStats: [
        { category: '餐饮', total: 1800, count: 20 },
        { category: '交通', total: 500, count: 15 },
        { category: '购物', total: 1200, count: 10 }
      ]
    }
  })
  console.log('   结果:', c3.success ? `成功 - ${c3.data.categoryCount} 个分类, TOP: ${c3.data.topCategory?.category}` : `失败 - ${c3.error}`)

  // 测试4: 合规校验
  console.log('\n4. 合规校验...')
  const c4 = await calculatorAgent.execute({
    type: CALCULATION_TYPES.COMPLIANCE_CHECK,
    params: {
      record: { amount: 150000, category: '餐饮', type: 'expense' }
    }
  })
  console.log('   结果:', c4.success ? `成功 - 风险等级: ${c4.data.riskLevel}, ${c4.data.warningCount} 个警告` : `失败 - ${c4.error}`)

  return { c1, c2, c3, c4 }
}

async function testMasterAgent() {
  console.log('\n=== 测试主控 Agent（主从协同）===')

  const testCases = [
    { name: '简单查询', message: '我这个月花了多少钱' },
    { name: '预算分析', message: '帮我看看预算执行情况' },
    { name: '周期对比', message: '对比一下本月和上月的消费' },
    { name: '分类分析', message: '我的消费分类占比是多少' },
    { name: '综合分析', message: '给我做个全面的消费分析报告' }
  ]

  const results = []
  for (const tc of testCases) {
    console.log(`\n测试「${tc.name}」: "${tc.message}"`)
    try {
      const result = await masterAgent.processQuery({
        userId: TEST_USER_ID,
        message: tc.message
      })
      console.log(`   模式: ${result.pattern}`)
      console.log(`   执行: ${result.execution.succeededCount}/${result.execution.stepCount} 步成功`)
      console.log(`   回答预览: ${result.answer.slice(0, 80)}${result.answer.length > 80 ? '...' : ''}`)
      results.push({ name: tc.name, success: result.success, pattern: result.pattern })
    } catch (error) {
      console.log(`   失败: ${error.message}`)
      results.push({ name: tc.name, success: false, error: error.message })
    }
  }

  return results
}

async function main() {
  console.log('🚀 开始 3 Agent 架构冒烟测试')
  console.log('架构: 主控 Agent → 检索 Agent + 计算 Agent')

  try {
    // 1. 单独测试检索 Agent
    await testRetrievalAgent()

    // 2. 单独测试计算 Agent
    await testCalculatorAgent()

    // 3. 测试主控 Agent（端到端主从协同）
    const masterResults = await testMasterAgent()

    console.log('\n=== 测试总结 ===')
    const passed = masterResults.filter(r => r.success).length
    console.log(`主控测试: ${passed}/${masterResults.length} 通过`)
    masterResults.forEach(r => {
      console.log(`  ${r.success ? '✅' : '❌'} ${r.name}${r.pattern ? ` (${r.pattern})` : ''}`)
    })

    console.log('\n🎉 3 Agent 架构冒烟测试完成！')
  } catch (error) {
    console.error('\n❌ 测试执行失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

main()
