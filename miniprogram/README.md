# Smart Finance 微信小程序

## 快速开始

### 1. 安装微信开发者工具

下载并安装 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)

### 2. 导入项目

1. 打开微信开发者工具，选择「导入项目」
2. 目录选择本 `miniprogram/` 文件夹
3. AppID 填入你的小程序 AppID（开发阶段可点「测试号」）
4. 点击「确定」

### 3. 配置后端地址

编辑 `utils/request.js`，修改 `BASE` 为你的后端地址：

```js
const BASE = 'http://192.168.x.x:3000'  // 改为你电脑的局域网 IP
```

### 4. 不校验域名

在微信开发者工具中：
- 右上角「详情」→「本地设置」→ 勾选「不校验合法域名」

### 5. 启动后端

确保后端服务已启动：
```bash
docker compose up -d mysql redis qdrant
cd server && npm run dev
```

### 6. ECharts 图表（可选）

如需图表功能，下载 `echarts-for-weixin`：
```bash
cd miniprogram/utils
# 下载 echarts.min.js 放到 utils/ 目录
# https://github.com/ecomfe/echarts-for-weixin
```

未安装时图表区域显示为空，其他功能不受影响。

## 页面结构

| 页面 | 功能 |
|---|---|
| 登录页 | wx.login 一键登录 |
| 记账页 | 文本聊天记账 + 拍照 OCR |
| 消费分析 | 收支概览、分类饼图、风险提醒、消费趋势、最近记录 |
| 目标规划 | 月度预算设置、储蓄目标管理 |
| 汇率看板 | 8种货币实时汇率、异常告警 |
| 我的 | 用户信息、退出登录 |

## 技术栈

- 原生微信小程序
- wx.request + JWT 鉴权
- ec-canvas (ECharts)
- wx.chooseImage + wx.uploadFile (OCR)
