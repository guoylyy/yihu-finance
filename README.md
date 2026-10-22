# yihu-finance · 集团财务系统

> 面向小型集团的轻量财务运营系统：**多公司 · 账户与流水 · 收付款 · 工资报销 · 发票借贷 · 月结 · 资金预测**
> Vue 3 + Element Plus ｜ Node 20 + Express 4 + Prisma 6 ｜ MySQL 8 ｜ 可作为 [以虎 One](#部署到以虎-one) 平台的应用一键安装
>
> Yihu Work Tools 套件组件之一 —— 以虎开源工具集，服务财务日常工作。

它回答三个问题：**钱在哪里？钱从哪来到哪去？未来三个月够不够用？**

> 🌱 本仓库中的所有公司、人员、银行账号与金额均为**虚构演示数据**（见 `backend/prisma/seed.js`），可放心运行与二次开发。

---

## 功能地图

### 📊 管理驾驶舱
集团总余额、各公司余额、本月收入/支出/净现金流、待收待付、逾期提醒、近 12 个月收支趋势、未来 30/60/90 天资金预测。

### 💰 资金
| 模块 | 能力 |
|---|---|
| 账户管理 | 银行/支付宝/现金/备用金/往来户；期初余额、**余额随流水自动重算**、账户对账、内部转账（自动生成互指的两条流水）、账号按角色脱敏 |
| 资金流水 | 多维筛选与合计、批量改分类/状态、导出 Excel、修改留痕、锁定月份禁改 |
| 导入银行流水 | CSV/XLS/XLSX **自动识别表头**（工行/农行/建行/招行/支付宝口径）、UTF-8 与 GBK 自动切换、**按账户查重**、规则猜业务类型、预览确认后再落库 |

### 💸 收付款
| 模块 | 能力 |
|---|---|
| 应收与收款 | 应收台账、登记回款自动生成收入流水、逾期应收、把握度（影响预测口径） |
| 应付台账 | 供应商欠款与待付事项 |
| 付款管理 | 草稿 → 待审批 → 待付款 → 已付款 → 已核对；批量审批、付款清单导出、付款后自动生成流水并回写来源单据、与已导入流水手工关联 |
| 工资管理 | 导入工资表（工资表/劳务费表两种格式）、按姓名匹配员工补银行账号、**缺账号校验**、**按单文件 5 万拆批生成银行代发模板**、一键生成付款单（按批次 / 一人一单） |
| 报销管理 | 提交 → 审批 → 生成付款单（同一人多笔自动合并）→ 付款回写 |

### 🧾 票据与往来
- **发票台账**：销项/进项/费用/红字，Excel 批量导入、发票号查重、与流水关联、价税合计自动补齐
- **借贷与往来**：公司借给个人 / 个人借给公司 / 公司间拆借 / 代付；还款冲账可同时记流水

### 📈 分析与月结
- **经营分析**：收支趋势、各公司净现金流、人力成本（工资/劳务费/报销堆叠）、支出分类排名、对手方 TOP15、项目收支
- **资金预测**：`预计期末余额 = 当前可用余额 + 预计收款 − 已审批待付款 − 固定周期支出`，30/60/90 天窗口 + 逐日余额曲线 + 事项明细（已确认/高概率/预估三档）
- **月结工作台**：八项检查 → 锁定月份 → **生成 Markdown 月结摘要**
- **异常清单**：缺银行账号、重复发票、待核对流水、逾期收付款、余额未更新、万元以上支出未关联发票

### 📖 使用手册（`/guide`）
系统内置教程页：快速上手、**每月固定动作 SOP**（可勾选）、模块操作手册、踩过的坑、更新日志。
内容即 `frontend/src/docs/*.md`，改 Markdown 即可，文件名前缀控制顺序。

---

## 快速启动

```bash
# 1. 数据库（本地 MySQL，默认 root/root）
mysql -uroot -proot -e "CREATE DATABASE IF NOT EXISTS yihu_finance DEFAULT CHARACTER SET utf8mb4"

# 2. 后端
cd backend && npm install
cp .env.example .env          # 按需改 DATABASE_URL / JWT_SECRET
npx prisma db push            # 建表
npm run seed                  # 写入虚构演示数据（4 家公司、账户、员工、示例流水、系统账号）
npm run dev                   # http://localhost:3010

# 3. 前端
cd ../frontend && npm install
npm run dev                   # http://localhost:5183
```

或一键启动：`./start.sh`

默认演示账号（**仅本地演示用，部署到公网前务必修改或改用统一登录**）：

| 账号 | 密码 | 角色 | 能做什么 |
|---|---|---|---|
| admin | admin123 | 管理者 ADMIN | 全部数据 + **付款审批** + 月结锁定 + 用户管理 |
| finance | finance123 | 财务 FINANCE | 流水/收付款/工资/报销/发票/月结，**不能审批付款** |
| staff | staff123 | 业务 STAFF | 提交报销、查看基础资料 |

> 审批与付款是两个独立权限点：财务能付款不能审批，管理者能审批不替财务记账，AI 助手只读。

---

## 部署到以虎 One

本系统可以作为应用插到 [以虎 One](https://github.com/guoylyy) 平台（自托管的小团队工作台，统一登录 + 应用市场 + AI 助手）：用平台的统一登录，挂在 `<平台地址>/apps/finance/` 下，平台 AI 助手可直接查询资金、预测、逾期和异常。本地开发不受影响——不配平台注入的 `YH_*` 环境变量时，一切照旧（账号密码登录、根路径访问）。

**安装**：平台控制台「管理 → 应用 → 从 Git 安装应用」填本仓库地址和 code `finance`；或在平台服务器上：

```bash
./yh add finance --git <本仓库地址>     # 本机目录用 --path
./yh up finance
```

**发布**：在 `main` 上开发，要上线时 `./release.sh`（检查 → 构建 → 推到 `release` 分支），平台两分钟内自动发布，失败自动回滚。

**迁移已有数据**：容器启动只会建表、补科目/分类，不会写入演示数据。把已有库导进平台：

```bash
mysqldump -uroot -proot --single-transaction --routines yihu_finance | gzip > /tmp/yihu_finance.sql.gz
# 拷到平台服务器后，在平台目录：
./yh restore finance /tmp/yihu_finance.sql.gz && ./yh restart finance
```

| 接入点 | 说明 |
| --- | --- |
| 清单 | `yh-app.json`（端口 3010、健康检查 `/api/health`、需要数据库、MCP `/mcp`） |
| 镜像 | `Dockerfile`：构建前端，后端托管页面；启动时 `prisma db push`（会丢数据的改动直接失败，平台回滚），`prisma/bootstrap.js` 只补收支分类（`seed.js` 会重置默认账号密码，只能手动跑） |
| 统一登录 | `backend/src/lib/platform.js` + `platform-users.js`：平台用户按 `platformUserId` → 同名账号对上本系统用户；都没有就新建（平台管理员建成 ADMIN，其他人 STAFF 只能报销），角色和数据范围仍在本系统「用户管理」里调 |
| 本地密码登录 | 在平台上默认关闭（种子里的默认密码不能暴露在公网上），确需时 `apps/finance/.env` 里设 `ALLOW_LOCAL_LOGIN=true` |
| 页面路径 | 后端给 `index.html` 注入 `<base href="/apps/finance/">`，前端接口、路由都从 `frontend/src/api/base.js` 的 `BASE` 拼 |
| AI 工具（只读） | `get_cash_overview` 资金概况、`get_cash_forecast` 资金预测、`list_overdue` 逾期收付款、`list_anomalies` 异常清单、`get_monthly_report` 公司月报。以当前用户的角色和数据范围调用本系统接口，AI 不能付款、不能改账 |
| JWT 密钥 | 没配 `JWT_SECRET` 时从平台注入的应用密钥派生 |
| 附件 | `UPLOAD_DIR=/data/uploads`（平台数据目录，每晚备份会带上） |

**One 接入的环境变量**（外部应用在平台「管理 → 应用 → 登记外部应用」获得）：

| 变量 | 说明 |
|---|---|
| `YH_CLIENT_ID` / `YH_CLIENT_SECRET` | 应用凭证；平台托管的应用由 `yh` 自动注入 |
| `YH_WEB_URL` | 平台访问地址（浏览器跳授权页） |
| `YH_API_URL` | 平台接口地址（服务端换 token、上报数据） |
| `YH_APP_URL` | 本应用对外地址，回调地址 = `YH_APP_URL` + `/sso/callback` |
| `YH_BASE_PATH` | 平台挂载路径前缀（平台自动注入，本地开发不用配） |

---

## 仓库结构

```
yihu-finance/
├── backend/                      # Node 20 + Express 4 + Prisma 6
│   ├── prisma/
│   │   ├── schema.prisma         # 20 张表：公司/账户/流水/收付/工资/发票/借贷/月结…
│   │   └── seed.js               # 虚构演示数据（生产请替换）
│   └── src/
│       ├── index.js              # 路由挂载
│       ├── lib/
│       │   ├── auth.js           # JWT + 权限矩阵 PERMISSIONS + 公司数据范围
│       │   ├── crud.js           # 通用台账 CRUD 工厂（筛选/分页/软删/审计）
│       │   ├── excel.js          # 银行流水与工资表解析、Excel 导出
│       │   ├── bankTemplate.js   # 5 万拆批 + 银行代发模板
│       │   ├── balance.js        # 账户余额重算
│       │   ├── forecast.js       # 资金预测
│       │   ├── close.js          # 月结检查清单 + Markdown 摘要
│       │   ├── yh-one.mjs        # 以虎 One 平台接入 SDK（零依赖）
│       │   └── audit.js          # 操作留痕
│       └── routes/fin/           # 19 个业务路由模块
└── frontend/                     # Vue 3 + Vite + Element Plus + ECharts
    └── src/
        ├── api/index.js          # REST 封装（统一 { code, message, data }）
        ├── api/permissions.js    # 前端权限 can()，与后端矩阵对齐
        ├── components/CrudTable.vue  # 通用台账页（列 + 表单描述式配置）
        ├── constants/            # 业务枚举与中文标签
        ├── composables/useMeta.js    # 公司/账户/分类/员工缓存
        └── views/admin/          # 22 个页面
```

---

## 几条硬约定（二次开发前必读）

1. **金额一律 `Decimal(18,2)`**，精确到分，禁止用 Float 存钱。
2. **账户余额 = 期初余额 + 收入 − 支出**，任何流水增删改后自动重算，永远和流水对得上。
3. **删除一律软删**（`deletedAt`），不做物理删除。
4. **月结锁定后该月流水/付款不可改**，需管理员填原因解锁，解锁记审计日志。
5. **日期按 UTC 零点存取**（`@db.Date`）——用本地零点会在东八区被 MySQL 存成前一天。
6. **付款审批与执行分离**：`payment.approve` 与 `payment.pay` 是两个权限点，AI 助手无付款权限。
7. **后端权限矩阵 `backend/src/lib/auth.js` 与前端 `frontend/src/api/permissions.js` 必须同步改。**

---

## Roadmap

- [ ] 附件上传接到对象存储（当前落本地 `backend/uploads/`）
- [ ] 每日自动备份数据库与附件
- [ ] 银行流水 API 直连 / 定时导入
- [ ] 集团合并报表与抵销
- [ ] 英文界面

## License

[Apache-2.0](LICENSE)
