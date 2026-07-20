智能个人财务记账助手

项目简介

智能个人财务记账助手是一款面向大学生和职场新人的 AI-Native 记账工具。通过自然语言交互完成记账、消费分析与理财规划，帮助用户轻松掌握财务状况，建立良好的理财习惯。

核心功能

智能记账：支持语音/文字输入，自动识别消费类别、金额、时间，支持批量记账与定时记账。

消费分析：自动生成日报、周报、月报，提供饼图、柱状图、趋势图等可视化分析，支持趋势预测与对比分析。

理财规划：设定储蓄目标与预算，提供个性化理财建议与投资组合推荐，实时跟踪目标进度。

长期记忆：记住用户消费习惯与财务目标，提供个性化服务。

主动服务：定时提醒、异常消费预警、月度报告推送、储蓄进度提醒。

用户画像

大学生小王：希望了解每月消费结构，控制不必要开支。

职场新人小李：需要储蓄规划与理财指导，工作忙碌，希望快速记账。

理财新手小张：希望建立理财习惯，学习投资知识，避免冲动消费。

## 本地一键运行 (Phase 10)

### 前置条件
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows)
- [LM Studio](https://lmstudio.ai/) 已安装以下模型：
  - `qwen3.6-35b-a3b` (对话模型)
  - `text-embedding-nomic-embed-text-v1.5` (Embedding 模型)
- PowerShell 7

### 启动
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-local.ps1
```

启动后访问：
- 前端: http://localhost
- 后端: http://localhost:3000
- 健康检查: http://localhost:3000/api/health/ready

### 停止
```powershell
# 停止容器（保留数据）
.\scripts\stop-local.ps1

# 停止并清理数据卷
.\scripts\stop-local.ps1 -Clean
```

### 架构
- **SQL 优先**: 精确统计查询走 MySQL
- **RAG 建议**: 语义建议类问题通过 Qdrant 检索 + Qwen 生成回答
- **降级安全**: LM Studio 或 Qdrant 不可用时精确查询继续可用

### 重建向量索引
```bash
docker compose exec backend npm run reindex:rag
```

### 排错
- **LM Studio 模型缺失**: 在 LM Studio 中搜索安装 `qwen3.6-35b-a3b` 和 `text-embedding-nomic-embed-text-v1.5`
- **端口 1234 被占用**: 确保 LM Studio 已通过脚本启动（不要单独启动 LM Studio Server）
- **维度不匹配**: 删除 Qdrant 数据卷后重新启动 (`.\scripts\stop-local.ps1 -Clean`)
- **Docker 服务不健康**: `docker compose --env-file .env.local ps`

## 项目特色

AI-Native设计：对话即操作

长期记忆机制：系统记住用户习惯，提供个性化服务。

主动服务：像真人顾问一样推送提醒与分析。

跨学科融合：结合会计与软件工程，提供专业理财建议。
