#!/usr/bin/env python3
"""为 Smart Finance demo 账号造展示样本数据（幂等：已有数据则跳过）"""
import json, random, time, datetime, urllib.request, urllib.error

BASE = "https://lisheng666.xyz"
EMAIL, PWD = "demo@lisheng666.xyz", "demo123456"

def call(method, path, payload=None, token=None, timeout=90):
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json", "User-Agent": "hermes-seed"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"{BASE}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:300]
        print(f"  !! {method} {path} -> HTTP {e.code}: {body}")
        return None

def get(path, token):
    req = urllib.request.Request(f"{BASE}{path}", headers={"Authorization": f"Bearer {token}", "User-Agent": "hermes-seed"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except Exception as e:
        print(f"  !! GET {path} -> {e}")
        return None

# 1. 登录
login = call("POST", "/api/auth/email/login", {"email": EMAIL, "password": PWD})
token = (login or {}).get("token") or (login or {}).get("data", {}).get("token")
if not token:
    print("登录失败，终止"); raise SystemExit(1)
print("✅ 登录成功")

# 2. 幂等检查
records = get("/api/records", token) or {}
recs = records.get("data", records) if isinstance(records, dict) else records
if isinstance(recs, list) and len(recs) > 0:
    print(f"⏭️  已有 {len(recs)} 条记录，跳过造数"); raise SystemExit(0)
ledgers = get("/api/ledgers", token) or {}
ledger_id = ledgers[0]["id"] if isinstance(ledgers, list) and ledgers else (ledgers.get("data", [{}])[0].get("id") if isinstance(ledgers, dict) else None)
print(f"✅ 账本 id={ledger_id}")

rnd = random.Random(42)
def dt(d, m, y=2026):
    return datetime.date(y, m, d).isoformat()

def rand_date(start_m, start_d, end_m, end_d):
    s = datetime.date(2026, start_m, start_d); e = datetime.date(2026, end_m, end_d)
    return (s + datetime.timedelta(days=rnd.randint(0, (e - s).days))).isoformat()

# 3. 记账记录
records_plan = []
# 收入
for m, day, amt, note in [(6, 15, 11000, "6月工资"), (7, 15, 11000, "7月工资"), (8, 15, 11500, "8月工资"), (6, 30, 2000, "季度奖金"), (7, 20, 350, "理财收益")]:
    records_plan.append(("income", "工资" if "工资" in note else ("奖金" if "奖金" in note else "理财收益"), amt, dt(day, m), note))

# 日常消费
foods = [("早餐", 6, 12), ("早餐", 5, 10), ("午餐", 18, 35), ("午餐", 15, 28), ("晚餐", 22, 45), ("晚餐", 18, 38), ("咖啡", 12, 25), ("聚餐", 88, 220), ("奶茶", 10, 18)]
trans = [("地铁", 3, 8), ("打车", 12, 35), ("公交", 2, 4), ("打车", 18, 42)]
shops = [("超市采购", 40, 150), ("网购", 60, 400), ("衣服", 129, 399), ("日用品", 20, 90), ("数码配件", 49, 199)]
homes = [("房租", 1800, 1800), ("水电燃气", 60, 120), ("物业费", 80, 80), ("话费", 50, 100)]
funs = [("电影", 45, 60), ("游戏充值", 30, 68), ("KTV", 99, 199), ("视频会员", 25, 35)]
meds = [("药店", 28, 65), ("挂号", 30, 30)]
edus = [("买书", 45, 89), ("课程", 199, 399), ("学习资料", 30, 80)]
others = [("转账-家人", 500, 500), ("红包", 200, 200), ("理发", 35, 60)]

def spread(plan, count, m0, d0, m1, d1):
    for _ in range(count):
        cat, lo, hi = plan[rnd.randrange(len(plan))]
        records_plan.append(("expense", cat, rnd.randint(lo, hi), rand_date(m0, d0, m1, d1), cat))

spread(foods, 32, 6, 1, 8, 24)
spread(trans, 16, 6, 1, 8, 24)
spread(shops, 12, 6, 1, 8, 24)
spread(homes, 8, 6, 1, 8, 24)
spread(funs, 7, 6, 1, 8, 24)
spread(meds, 3, 6, 1, 8, 24)
spread(edus, 4, 6, 1, 8, 24)
spread(others, 4, 6, 1, 8, 24)

print(f"📝 计划插入 {len(records_plan)} 条记录...")
ok = 0
for typ, cat, amt, occurred, note in records_plan:
    r = call("POST", "/api/records", {
        "type": typ, "category": cat, "amount": str(amt),
        "currency": "CNY", "ledger_id": ledger_id, "note": note,
        "occurred_at": occurred,
    }, token)
    if r is not None:
        ok += 1
    time.sleep(0.15)
print(f"✅ 记录插入 {ok}/{len(records_plan)}")

# 4. 资产
assets = [("cash", "现金钱包", 3000), ("bank_deposit", "活期存款", 35000), ("bank_deposit", "定期存款", 50000), ("investment", "基金持仓", 18000), ("other", "公积金", 42000)]
for typ, name, amt in assets:
    call("POST", "/api/assets", {"type": typ, "name": name, "amount": str(amt), "currency": "CNY", "notes": "样本数据"}, token)
    time.sleep(0.15)
print("✅ 资产 5 项")

# 5. 负债
call("POST", "/api/assets/liabilities", {"type": "other", "name": "花呗分期", "amount": "2600", "interest_rate": "0", "monthly_payment": "433", "due_date": "2026-12-01", "notes": "样本数据"}, token)
time.sleep(0.15)
call("POST", "/api/assets/liabilities", {"type": "other", "name": "手机分期", "amount": "3499", "interest_rate": "0", "monthly_payment": "583", "due_date": "2027-01-01", "notes": "样本数据"}, token)
time.sleep(0.15)
print("✅ 负债 2 项")

# 6. 目标
goals = [("应急储备金", 30000, 18000, "2026-12-31"), ("旅行基金", 12000, 6500, "2026-10-01"), ("新电脑计划", 15000, 3000, "2026-11-30")]
for name, tgt, cur, tdate in goals:
    call("POST", "/api/goals", {"name": name, "target_amount": str(tgt), "current_amount": str(cur), "target_date": tdate}, token)
    time.sleep(0.15)
print("✅ 目标 3 个")

# 7. 预算
for cat, amt in [("餐饮", 1500), ("购物", 800), ("娱乐", 300)]:
    call("POST", "/api/budgets", {"category": cat, "amount": str(amt), "period": "monthly", "ledger_id": ledger_id}, token)
    time.sleep(0.15)
print("✅ 预算 3 个")

# 8. 验证
recs = (get("/api/records", token) or {}).get("data", [])
ov = get("/api/assets/overview", token) or {}
print(f"\n🎉 完成！records={len(recs)} 净资产={ov.get('net_worth')} 资产数={ov.get('asset_count')} 负债数={ov.get('liability_count')}")
