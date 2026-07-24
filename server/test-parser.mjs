import { parseCsvContent, calculateSimilarity } from './src/services/import/billParser.js'

// 测试通用 CSV
const genericCsv = `日期,分类,金额,收支,商家,备注
2024-01-15,餐饮,35.50,支出,麦当劳,午餐
2024-01-16,交通,12.00,支出,地铁,通勤
2024-01-17,工资,15000,收入,公司,月薪`

console.log('=== 测试通用 CSV 解析 ===')
const r1 = parseCsvContent(genericCsv)
console.log('Source type:', r1.sourceType)
console.log('Total:', r1.totalCount, 'Valid:', r1.validCount)
console.log('First record:', JSON.stringify(r1.records[0], null, 2))

// 测试微信格式
const wechatCsv = `微信支付账单明细
微信昵称：测试用户
起始时间：[2024-01-01 00:00:00] 终止时间：[2024-01-31 23:59:59]
导出时间：[2024-02-01 10:00:00]
----------------------微信支付账单明细列表--------------------
交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注
2024-01-15 12:30:00,餐饮美食,麦当劳,汉堡套餐,支出,35.50,零钱,支付成功,12345,67890,午餐
2024-01-16 08:15:00,交通出行,地铁,通勤,支出,12.00,零钱,支付成功,12346,67891,上班`

console.log('\n=== 测试微信账单解析 ===')
const r2 = parseCsvContent(wechatCsv)
console.log('Source type:', r2.sourceType)
console.log('Total:', r2.totalCount, 'Valid:', r2.validCount)
console.log('First record:', JSON.stringify(r2.records[0], null, 2))

// 测试相似度
console.log('\n=== 测试重复检测 ===')
const a = { amount: 35.5, category: '餐饮', date: '2024-01-15', merchant: '麦当劳', description: '午餐' }
const b = { amount: 35.50, category: '餐饮美食', date: '2024-01-15', merchant: '麦当劳', description: '汉堡套餐' }
const sim = calculateSimilarity(a, b)
console.log('相似度:', sim)

console.log('\n✅ 所有测试通过')
