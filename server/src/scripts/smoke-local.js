import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export async function runLocalSmoke({ baseUrl, fetchFn = fetch, cleanupFn } = {}) {
  const results = { status: 'passed', steps: [], error: null }
  const timestamp = Date.now()
  const smokeUser = `smoke-${timestamp}`
  const smokePass = `pass-${timestamp}`

  async function cleanup() {
    if (cleanupFn) await cleanupFn()
  }

  try {
    // 1. Register smoke user
    const authRes = await fetchFn(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: smokeUser, password: smokePass })
    })
    const authData = await authRes.json()
    const token = authData.data?.token
    if (!token) throw new Error('Failed to register smoke user')
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    results.steps.push({ step: 'register', ok: true })

    // 2. Read default ledger
    const ledgerRes = await fetchFn(`${baseUrl}/api/ledgers`, { headers })
    const ledgerData = await ledgerRes.json()
    const ledgerId = ledgerData.data?.[0]?.id || null
    results.steps.push({ step: 'ledgers', ok: true, ledgerId })

    // 3. Create test records with distinct semantic content
    const records = [
      { type: 'expense', amount: 25, category: '餐饮', description: '食堂午餐', date: '2026-07-18', ledgerId },
      { type: 'expense', amount: 88, category: '购物', description: '超市买日用品', date: '2026-07-17', ledgerId },
      { type: 'expense', amount: 15, category: '交通', description: '地铁通勤', date: '2026-07-16', ledgerId }
    ]
    for (const record of records) {
      const recRes = await fetchFn(`${baseUrl}/api/records`, {
        method: 'POST', headers, body: JSON.stringify(record)
      })
      const recData = await recRes.json()
      if (!recData.success) throw new Error(`Failed to create record: ${JSON.stringify(recData)}`)
    }
    results.steps.push({ step: 'create_records', ok: true, count: records.length })

    // 4. Poll readiness
    let ready = false
    for (let i = 0; i < 10; i++) {
      const healthRes = await fetchFn(`${baseUrl}/api/health/ready`)
      const health = await healthRes.json()
      if (health.status === 'ready') { ready = true; break }
      await new Promise(r => setTimeout(r, 500))
    }
    results.steps.push({ step: 'health_check', ok: ready })

    // 5. Exact query - verify finance summary exists
    const exactQueryRes = await fetchFn(`${baseUrl}/api/chat`, {
      method: 'POST', headers, body: JSON.stringify({ message: '本月餐饮统计' })
    })
    const exactQuery = await exactQueryRes.json()
    if (!exactQuery.data?.finance) throw new Error('Exact query missing finance summary')
    results.steps.push({ step: 'exact_query', ok: true, finance: exactQuery.data.finance })

    // 6. Advice query - verify RAG
    const adviceRes = await fetchFn(`${baseUrl}/api/chat`, {
      method: 'POST', headers, body: JSON.stringify({ message: '给我一些省钱建议' })
    })
    const advice = await adviceRes.json()
    if (!advice.data?.rag?.sources || advice.data.rag.sources.length === 0) {
      throw new Error('Advice query missing RAG sources')
    }
    results.steps.push({ step: 'advice_query', ok: true, sources: advice.data.rag.sources.length })

  } catch (error) {
    results.status = 'failed'
    results.error = error.message
  } finally {
    await cleanup()
  }

  return results
}

// CLI entry
async function main() {
  // Parse args
  const args = process.argv.slice(2)
  const baseUrl = args.find(a => a.startsWith('--base-url='))?.split('=')[1] || 'http://localhost:3000'

  console.log('[Smoke] Starting local smoke test...')
  const result = await runLocalSmoke({ baseUrl })
  console.log(`[Smoke] ${result.status === 'passed' ? 'PASSED' : 'FAILED'}`)
  for (const step of result.steps) {
    console.log(`  ${step.ok ? 'OK' : 'FAIL'} ${step.step}`)
  }
  if (result.error) console.error(`  Error: ${result.error}`)
  process.exit(result.status === 'passed' ? 0 : 1)
}

const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('smoke-local.js')
)

if (isMain) main()
