# v1.4.0「发票 — 应收 — 流水」三单关联 · 实施方案

> 基线：v1.3.2（`8f5bb91`）。本文只做分析，未改业务代码。
> 本地验证环境：`mysql-dev`（127.0.0.1:3307）新建库 `yihu_finance_dev`，`backend/.env.local`（PORT=3019，因 3011 被占用），
> `db push` + `npm run seed` 后起后端实测；方案中的 schema 用临时副本 `/tmp/fin-probe/schema.prisma` 推到了 dev 库，
> 回填 SQL 与疑似重复 SQL 都在 dev 库上跑过（结果见 §2.4、§2.5）。平台库 `app_finance` 没有碰。

已拍板（不再讨论）：① 发票↔应收以 1:1 为主，允许多张发票挂一笔应收；② 一笔流水可拆分核销多笔应收；③ 历史重复记账先不动数据，只提示「疑似重复」。

---

## 1. 现状复核

根因三条复核成立，另外补充了**四个实测确认的现存缺陷**（§1.1 末尾），它们直接影响 `receivedAmount` 能不能和 Receipt 汇总对上，必须在 v1.4 一起处理。

### 1.1 回款链路

**路由**：`backend/src/routes/fin/receivables.js:55-97`

```js
// :57  只收 accountId / amount / receiptDate / remark，没有 transactionId
const { accountId, amount, receiptDate, remark } = req.body || {}
// :73-75  读-改-写累加，状态在内存里算
const amt = new Prisma.Decimal(amount)
const received = new Prisma.Decimal(ar.receivedAmount).plus(amt)
const status = received.gte(ar.amount) ? 'RECEIVED' : 'PARTIAL'
// :78-88  无条件新建流水，直接标 RECONCILED
const txn = await createWithCode('transaction', 'TXN', { date }, { data: {
  ..., direction: 'IN', amount: amt, bizType: 'SALES_RECEIPT',
  refType: 'RECEIVABLE', refId: ar.id, status: 'RECONCILED', ... } })
// :89-93  回写应收
await prisma.receivable.update({ where: { id }, data: { receivedAmount: received, status, actualDate: date } })
// :94-95  recalcAccountBalance + logAudit
```

已有的校验：应收在范围内（:61-62）、账户在范围内且属于应收所在公司（:64-67）、收款日期所在月未关账（:69-71）。
**缺的**：金额格式/正负、剩余应收上限、应收状态（CANCELLED / WRITTEN_OFF 也能回款）、流水与应收更新不在同一个数据库事务里、并发两次回款会丢更新（读-改-写）。

**谁会写 `receivedAmount`**：全仓库只有 `receivables.js:91` 这一处（`grep receivedAmount` 全部结果见下）。crud 的 `fields`（`receivables.js:39`）里没有它，PUT 改不了。

| 位置 | 读/写 | 用途 |
|---|---|---|
| `routes/fin/receivables.js:74,91` | 写 | 登记回款 |
| `routes/fin/receivables.js:32` | 读 | 逾期合计 |
| `routes/fin/dashboard.js:23,72` | 读 | 首页「待收应收」 |
| `routes/fin/companies.js:44,68` | 读 | 公司卡片待收 |
| `routes/fin/ai.js:99` | 读 | 异常清单「逾期应收合计」 |
| `lib/forecast.js:34` | 读 | 资金预测剩余应收 |
| `lib/assistant-drafts.js:130-132,199,215` | 读 | 助手按「剩余=发票价税合计」自动匹配应收 |
| `routes/fin/assistant.js:81` | 读 | 助手页面上下文摘要 |
| `frontend/.../Receivables.vue:71,82,185,191` | 读 | 列表「已收」、弹窗、未收合计、默认回款金额 |

**间接改动入口**：

- 新增应收勾「已收到款」：`Receivables.vue:170-180` 的 `afterSave` 在建完应收后**再调一次** `/receipt`（全额）。
- 录入助手回款草稿：`lib/assistant-submit.js:93-103` `submitReceipt()` → 同一个 `/receipt` 接口，再可选调 `/invoices/:id/link-transaction`（:101，失败不回滚）。
- 应收 PUT（crud，`receivables.js:39`）可以直接改 `amount` 和 `status`，不重算。

**实测确认的现存缺陷**（dev 库，`/tmp/fin-probe/probe.sh`）：

| # | 现象 | 实测结果 |
|---|---|---|
| D1 | 先手工录一笔 IN 10000，再对应收点回款（即使 body 带 `transactionId`） | 生成第二笔 `TXN-202611-0002`，账户余额从 3571900 → 3581900，**重复入账**（老板的问题） |
| D2 | 作废回款生成的流水 | `DELETE /transactions/9` 成功，应收 `received_amount` 仍是原值、状态仍 RECEIVED（`transactions.js:178-189` 不碰应收） |
| D3 | 回款金额 99999 > 应收 5000 | 成功，无上限 |
| D4 | 回款金额 `-500` | 成功，生成 `direction=IN, amount=-500.00` 的流水，余额被减 500（流水「恒为正数」的约定被破坏，`schema.prisma:257`） |
| D5 | PUT 应收 `{amount:5000,status:"PENDING"}`（已收 10000） | 成功，`amount 5000 / received 10000 / status PENDING` |

> D2 意味着**线上可能已经存在 `receivedAmount` 比真实流水多的应收**，回填时必须出差异表（§2.4）。

### 1.2 发票台账

**模型**：`schema.prisma:512-546`。关联字段只有 `customerId / supplierId / reimbursementId`，**没有指向应收的字段**；`Receivable`（`:328-354`）也没有指向发票的字段。反向 `transactions Transaction[]`（`:541`）对应 `Transaction.invoiceId`（`:270`）。

**路由**：`routes/fin/invoices.js`

- crud（`:56-79`）：`fields` 无 `receivableId`；`filters` 只有 `status / type`；`beforeCreate` 查重 + `fillAmounts`。**只有 PUT，没有 PATCH**（`lib/crud.js:137`）。
- `POST /:id/link-transaction`（`:145-160`）：把 `transaction.invoiceId` 设为本发票，发票 `status → BOOKED`。不校验同公司（只校验各自在范围内）、不校验方向/金额。
- 导入（`:92-142`）：前端写死 `type='PURCHASE'`、`companyId = companies[0]`（`Invoices.vue:125-126`）——**销项发票走导入会被记成进项**，后面按 `type=SALES` 过滤候选发票会漏，见 §6。

**`Invoice.transactions[]` 谁在用**：

- 写：`invoices.js:156`（link-transaction）、`transactions.js:106-107,131-134`（新增/编辑流水可带 `invoiceId`，POST 校验同公司，PUT 没把 `invoiceId` 传给 `checkTxn`，`:165-168`）、助手回款草稿（`assistant-submit.js:101`）。
- 读：**没有任何接口 include 它**（`invoices.js:18-23` 的 INCLUDE 没有 transactions，`transactions.js:19-24` 的 INCLUDE 没有 invoice）。前端 `api.invoices.linkTransaction`（`frontend/src/api/index.js:161`）**在页面里没有调用方**，只有助手和测试 `scripts/tests/c-scope.mjs:157-163` 在用。
- 结论：「发票↔流水」现在是一条只写不读的弱关联。v1.4 发票↔钱的关系改为走「发票→应收→Receipt→流水」，`Transaction.invoiceId` 保留不动、不再新增用法。

### 1.3 流水页 / refType

`schema.prisma:272-274,301`：`refType String? / refId BigInt?`，索引 `[refType, refId]`。实际取值：

| refType | 写入点 | 状态 |
|---|---|---|
| `RECEIVABLE` | `receivables.js:84` 回款新建；助手草稿 `assistant-drafts.js:218`（只作提交路由标记） | RECONCILED |
| `PAYMENT` | `lib/payment.js:38` 付款执行；`payments.js:168` 付款单关联已有流水 | RECONCILED |
| `LOAN` | `loans.js:74` | RECONCILED |
| 任意值 | `transactions.js:106-107` POST/PUT 的 `WRITE_FIELDS` 含 `refType/refId/status`，前端编辑表单整行回传（`Transactions.vue:256`） | — |

**一个 refType + refId 只能指一笔单据**，表达不了「一笔流水拆给两笔应收」——这是必须引入 Receipt 的直接原因。

**状态语义**：`TXN_STATUS`（`frontend/src/constants/index.js:31-35`）是 待核对 / 已核对 / 异常，含义是「对过银行」，不是「核销了应收」。月结检查清单把 `UNRECONCILED` 计为未通过项（`lib/close.js:40,58`）。

**银行导入怎么进来**：`POST /transactions/import/preview`（`:227-342`）查重（`dedupHash`）+「同账户同日同额」相似提示（`:258-268`）+ 付款单金额匹配（`:280-315`，**只匹配 OUT，没有对应收做匹配**）；`/import/commit`（`:344-404`）逐行 `createWithCode`，`status: 'UNRECONCILED'`、`importBatchId: batch.id`、`refType` 不写（`:371-388`）。所以**银行导入的回款天然是「无 ref、UNRECONCILED、有 import_batch_id」**，这正是新流程里最主要的「候选流水」。

**付款侧的先例**：`payments.js:151-172` `POST /payments/:id/link-transaction` 就是「选已有流水」，但它**没有 inScope 校验、没有关账校验、没有方向/金额校验**，也不防止一笔流水被两张付款单关联——**不要照抄**，Receipt 的校验以 §3 为准（这个漏洞顺带记一笔，建议另开 issue）。

### 1.4 前端三个页面

**`Receivables.vue`**（CrudTable 包装，无详情页/抽屉）

- 行操作：`:74-77`，仅 PENDING/PARTIAL 显示「登记回款」。
- 回款弹窗 `:80-101`：

```
el-dialog「登记回款」 width=460
├─ el-alert  {标题}｜应收 ¥x｜已收 ¥y
├─ 收款账户  el-select（accountsOf(companyId)）  必填
├─ 本次收款  el-input-number（默认 应收−已收，:191）  必填
├─ 收款日期  el-date-picker（默认今天）
├─ 备注
└─ footer：取消 / 确认收款 → api.receivables.receipt(id, form)（:217-230）
```

- 新增表单 `#form-extra`（`:23-46`）：「已收到款」开关 + 收款账户 + 收款日期，`afterSave` 再调 `/receipt`（`:170-180`）。
- 助手回款草稿「填入表单」打开这个弹窗并预填（`:199-215`）。
- 表单没有发票字段（`:149-158`）。

**`Invoices.vue`**：纯 CrudTable，列 `:83-94`，表单 `:103-116`，只有「Excel 导入」和「查重」两个额外动作；**没有任何关联流水/应收的 UI**。

**`Transactions.vue`**：自写表格。

- 行操作 `:115-121`：Pin / 编辑 / 作废。没有「关联单据」入口，也不显示 refType。
- 新增/编辑弹窗 `:130-181`：公司、账户、日期、方向、金额、对方、业务类型、分类、状态、备注；新增默认 `status: 'RECONCILED'`（`:257`，注意：接口默认是 UNRECONCILED）。
- 批量栏 `:61-74` 可批量改状态（`transactions.js:192-224`）。

**移动端**：`frontend/src/assets/mobile.css:156-175` 在手机上把所有 `el-dialog` 改成全屏、body 纵向滚动、footer 按钮等分；列表用 `components/mobile/ResponsiveTable`（列上 `mobile="title|amount|badge|full"`）。新弹窗只要沿用这两样就不会横向溢出。

### 1.5 其他相关

- 权限点：`lib/auth.js:49-51,54-55,67-68`，`transaction.manage / receivable.manage / invoice.manage` 都只给 ADMIN、FINANCE。前端 `api/permissions.js` 由 `/api/auth/me` 下发，不维护矩阵副本，v1.4 不新增权限点就不用改它。
- 数据范围：`lib/auth.js:106-117` `scopeWhere / inScope`；`companyScope` 为空=全部。平台登录用户由 `lib/platform-users.js:42` 带上同样的 `companyScope`。
- 关账：`lib/close.js:11-25` `assertPeriodOpen(companyId, date)`，按 `YYYY-MM` 查 `close_periods.status='CLOSED'`。
- `npm test` 指向 `test/**/*.test.js`，**目录不存在，实际跑 0 个用例**（本地执行：`fail 0 … duration_ms 1.8`）。真正的回归是 `backend/scripts/assistant-e2e.mjs` + `scripts/tests/*.mjs`。
- 顺带发现：`lib/code.js:18-24` 用本地时区取年月，`toDate('2026-11-01')`（UTC 零点）在 PST 机器上编出 `TXN-202610-0001`（dev 库实测）。平台容器若是 UTC/东八区不受影响，**待确认**容器 TZ。

---

## 2. 数据模型

### 2.1 新增 `Receipt`（收款核销单）

```prisma
/// 收款核销单：一行 = 「某一笔收入流水」中的「一部分金额」核销到「某一笔应收」
/// - 一笔流水拆给多笔应收 → 同一 transactionId 多行
/// - 一笔应收收多次款     → 同一 receivableId 多行
/// - 应收已收 = SUM(未撤销行.amount)；流水已核销 = SUM(未撤销行.amount) ≤ 流水金额
model Receipt {
  id            BigInt   @id @default(autoincrement())
  companyId     BigInt   @map("company_id")      // 冗余：= 应收.companyId = 流水.companyId，便于按范围查
  receivableId  BigInt   @map("receivable_id")
  transactionId BigInt   @map("transaction_id")
  amount        Decimal  @db.Decimal(18, 2)      // 本次核销金额，> 0
  receiptDate   DateTime @map("receipt_date") @db.Date // 恒等于流水 txnDate（应收.actualDate 取各行最大值）

  // LINK 选已有流水核销 / AUTO 登记回款时系统新建的流水 / BACKFILL v1.4 历史回填
  source          String  @default("LINK") @db.VarChar(20)
  // 核销前流水的 status；该流水最后一行核销被撤销时恢复它（AUTO/BACKFILL 为空 → 撤销按 §3.3 处理）
  txnStatusBefore String? @map("txn_status_before") @db.VarChar(20)
  // 有效标记：有效=true，撤销=NULL。配合下面的唯一索引实现「同一流水×同一应收只能有一条有效核销」
  //（MySQL 没有部分唯一索引，唯一键里含 NULL 时不冲突，撤销的历史行可以有多条）
  activeFlag Boolean? @default(true) @map("active_flag")

  remark    String?   @db.VarChar(500)
  createdBy String?   @map("created_by") @db.VarChar(50)
  revokedBy String?   @map("revoked_by") @db.VarChar(50)
  createdAt DateTime  @default(now()) @map("created_at")
  updatedAt DateTime  @updatedAt @map("updated_at")
  deletedAt DateTime? @map("deleted_at")          // 撤销 = 软删（硬约定 3），同时 activeFlag 置 NULL

  company     Company     @relation(fields: [companyId], references: [id])
  receivable  Receivable  @relation(fields: [receivableId], references: [id])
  transaction Transaction @relation(fields: [transactionId], references: [id])

  @@unique([receivableId, transactionId, activeFlag], map: "receipts_active_pair")
  @@index([transactionId, deletedAt])
  @@index([companyId, receiptDate])
  @@map("receipts")
}
```

同时要加的反向关系：`Company.receipts Receipt[]`、`Receivable.receipts Receipt[]`、`Transaction.receipts Receipt[]`。

**为什么这样设计**

- **N:M 必须要中间表**。应收↔流水本质是多对多带金额（拆分 + 多次），`Transaction.refId` 只有一个槽位、`Receivable` 加 `transactionId` 也只有一个槽位，两边都放不下，只能独立成表。付款侧的 `Payment.transactionId` 是 1:1，不适用。
- **金额落在行上**：流水「已核销/剩余」与应收「已收/剩余」都由同一张表 SUM 出来，两侧天然对平。
- **不加业务编号**：Receipt 是关联行，界面展示用「流水编号 + 应收编号」即可；不加 `code` 就不用改 `lib/code.js` 的前缀表，回填 SQL 也不用发号。（若老板要求打印「收款单」再加，**待确认**。）
- **`receiptDate` 跟流水走**：钱哪天到账由银行决定，核销操作日期记在 `createdAt`；关账判断用流水日期（§6.2）。
- **唯一键 `receipts_active_pair`** 同时是回填幂等键和并发重复提交的兜底：同一流水对同一应收重复点两次，第二次撞唯一键（P2002），翻译成「这笔流水已核销到该应收，如需调整金额请先撤销」。
- 本地验证：`prisma validate` 通过；`db push`（**不带 `--accept-data-loss`**）在 dev 库直接成功，说明全部是加表/加可空列，平台启动不会失败。

### 2.2 `Invoice` 加 `receivableId`（可空）

```prisma
model Invoice {
  // ...现有字段
  receivableId BigInt? @map("receivable_id") // 对应的应收（销项发票）；多张发票可挂同一笔应收（部分开票）
  receivable   Receivable? @relation(fields: [receivableId], references: [id])
  @@index([receivableId])
}

model Receivable {
  // ...现有字段
  invoices Invoice[]   // 本应收开出的发票
  receipts Receipt[]   // 本应收的收款构成
}
```

**为什么放在 Invoice 上**：已定「多张发票可挂一笔应收」，即 Receivable 1 : N Invoice。外键放在「多」的一侧（Invoice）是唯一不需要中间表的放法；若放在 Receivable 上（`invoiceId`）就只能挂一张。反过来「一张发票拆给多笔应收」业务没有提，**不支持**；若以后要支持再升级为中间表。

### 2.3 `Receivable.receivedAmount` 保留为冗余字段

同意保留：dashboard / companies / forecast / ai / 助手 / 前端共 9 处读它（§1.1 表），保留后**统计口径与这些代码全都不用改**。

**维护规则：只有一个函数能写它，且永远「全量重算」不做加减。**

```js
// backend/src/lib/receipt.js（新增）
// 必须在调用方的 prisma.$transaction(tx) 里执行，且调用方已对该应收行 SELECT ... FOR UPDATE
export async function recalcReceivable(tx, receivableId) {
  const ar = await tx.receivable.findUnique({ where: { id: receivableId } })
  const agg = await tx.receipt.aggregate({ where: { receivableId, deletedAt: null }, _sum: { amount: true }, _max: { receiptDate: true } })
  const received = agg._sum.amount ?? new Prisma.Decimal(0)
  // CANCELLED / WRITTEN_OFF 是人工终态，不被收款自动改写
  const status = ['CANCELLED', 'WRITTEN_OFF'].includes(ar.status) ? ar.status
    : received.lte(0) ? 'PENDING' : received.gte(ar.amount) ? 'RECEIVED' : 'PARTIAL'
  return tx.receivable.update({ where: { id: receivableId },
    data: { receivedAmount: received, status, actualDate: agg._max.receiptDate ?? null } })
}
```

| 动作 | 规则 |
|---|---|
| 新增 Receipt | 事务内：锁流水行 → 锁应收行 → 校验剩余 → 插行 → `recalcReceivable` → `recalcTxnLink`（§3.3） |
| 撤销 Receipt | 事务内：锁同上 → `deletedAt=now, activeFlag=NULL` → `recalcReceivable` → `recalcTxnLink` |
| 修改 Receipt 金额 | **不提供**。改金额 = 撤销 + 重新核销（两条审计，账目清晰） |
| 应收 PUT 改 `amount` | 新 amount < 已收 → 拒绝；否则 `recalcReceivable` 刷新状态 |
| 应收 PUT 改 `status` | 只允许改成 `CANCELLED / WRITTEN_OFF`（且已收=0 才能 CANCELLED），或从这两者改回（改回时 `recalcReceivable`）；PENDING/PARTIAL/RECEIVED 一律由系统算 |
| 应收作废（DELETE） | 有有效 Receipt → 拒绝「请先撤销收款」 |
| 流水作废 / 改金额 / 改方向 / 改公司或账户 | 有有效 Receipt → 拒绝（改金额允许，但新金额 ≥ 已核销）；修复 D2 |
| 流水 POST/PUT 带 `refType/refId` | `RECEIVABLE / RECEIVABLE_MULTI` 只能由 Receipt 维护，接口直接忽略这两个值（或拒绝），防止手工伪造「已关联」 |
| 流水批量改状态 | 不影响 Receipt，允许（状态语义 = 已核对，见 §6.3） |

> 为什么不在应用层 `+= amount`：D2/D5 说明「加减」模式只要有一条路径漏掉就永久失真；全量重算对任何遗漏都自愈。

### 2.4 历史数据回填

**范围**：`transactions.ref_type='RECEIVABLE'` 的记录都是 `/receipt` 生成的（`refType` 只在 `receivables.js:84` 写这个值；`transactions.js` PUT 理论上也能写，但前端没有入口）。

**回填 SQL（幂等，已在 dev 库跑两遍，第二遍插入 0 行）**：`/tmp/fin-probe/backfill.sql`，建议落到 `backend/scripts/backfill-v140-receipts.sql`（或 `.mjs` 包一层带 `--dry-run`）。

```sql
-- ① 回填：未作废、正金额、方向 IN、指向未删除且同公司的应收 → 一行 Receipt
INSERT INTO receipts (company_id, receivable_id, transaction_id, amount, receipt_date, source,
                      txn_status_before, active_flag, remark, created_by, created_at, updated_at)
SELECT t.company_id, t.ref_id, t.id, t.amount, t.txn_date, 'BACKFILL',
       NULL, 1, CONCAT('v1.4 回填自流水 ', t.code), 'system:v1.4-backfill', NOW(3), NOW(3)
FROM transactions t
JOIN receivables r ON r.id = t.ref_id AND r.deleted_at IS NULL AND r.company_id = t.company_id
WHERE t.ref_type = 'RECEIVABLE' AND t.deleted_at IS NULL AND t.direction = 'IN' AND t.amount > 0
  AND NOT EXISTS (SELECT 1 FROM receipts x WHERE x.transaction_id = t.id AND x.receivable_id = t.ref_id);

-- ② 回填不了的流水（逐条人工看）
SELECT t.id, t.code, t.amount, t.ref_id,
       CASE WHEN t.amount <= 0 THEN '金额≤0' WHEN t.direction <> 'IN' THEN '方向不是 IN'
            WHEN r.id IS NULL THEN '应收不存在' WHEN r.deleted_at IS NOT NULL THEN '应收已作废'
            WHEN r.company_id <> t.company_id THEN '跨公司' END AS reason
FROM transactions t LEFT JOIN receivables r ON r.id = t.ref_id
WHERE t.ref_type = 'RECEIVABLE' AND t.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM receipts x WHERE x.transaction_id = t.id AND x.deleted_at IS NULL);

-- ③ 差异表：received_amount 与 Receipt 汇总不一致的应收
SELECT r.id, r.code, r.amount, r.received_amount, IFNULL(s.total,0) AS receipt_total,
       r.received_amount - IFNULL(s.total,0) AS diff, r.status
FROM receivables r
LEFT JOIN (SELECT receivable_id, SUM(amount) total FROM receipts WHERE deleted_at IS NULL GROUP BY receivable_id) s
       ON s.receivable_id = r.id
WHERE r.deleted_at IS NULL AND r.received_amount <> IFNULL(s.total,0);
```

dev 库实测（故意造了 D2 作废、D4 负数两种脏数据）：

```
② 11  TXN-202611-0004  -500.00  ref 1  金额≤0
③ 1   AR-2026-0001  amount 5000.00  received 109499.00  receipt_total 99999.00  diff 9500.00
   （= 作废流水的 10000 没回退 − 负数流水 500）
```

**不一致时以谁为准**：**以 Receipt 汇总（=还活着的流水）为准**——流水是事实表、和银行余额对得上；`receivedAmount` 只是从这些流水累加来的，偏差只可能来自 D2（作废未回退）、D4（负数）、D5 之类的漏洞。
但**回填脚本本身只出差异表、不改 `received_amount`**：差异表交老板确认后，再执行一次 `recalcReceivable` 全量（脚本 `--apply`），并对每笔变化写 `logAudit`。
**硬性顺序**：差异表清零（或逐条确认）必须在切片 2 上线**之前**完成——切片 2 之后任何一次核销都会触发全量重算，未确认的差异会被「悄悄」改掉，首页待收金额随之跳变。

线上规模：平台实例 `app_finance` 只有 7 条流水，按要求未查询；**待确认**生产（如有其他实例）的数据量与差异条数。

### 2.5 「疑似重复」识别（拍板第 3 条）

不改数据，只读识别。规则：系统回款自动建的流水 a（`ref_type='RECEIVABLE'`、`import_batch_id IS NULL`）与另一笔**未关联任何单据、未被核销**的收入流水 b，同公司、同金额、日期相差 ≤ 3 天。

```sql
SELECT a.id auto_txn, a.code auto_code, a.txn_date a_date, a.amount, a.ref_id receivable_id,
       b.id other_txn, b.code other_code, b.txn_date b_date,
       b.account_id = a.account_id same_account, b.import_batch_id IS NOT NULL from_bank_import
FROM transactions a
JOIN transactions b ON b.company_id = a.company_id AND b.id <> a.id
  AND b.direction = 'IN' AND b.amount = a.amount AND ABS(DATEDIFF(b.txn_date, a.txn_date)) <= 3
  AND b.deleted_at IS NULL AND (b.ref_type IS NULL OR b.ref_type = '')
  AND NOT EXISTS (SELECT 1 FROM receipts x WHERE x.transaction_id = b.id AND x.deleted_at IS NULL)
WHERE a.ref_type = 'RECEIVABLE' AND a.deleted_at IS NULL AND a.direction = 'IN' AND a.import_batch_id IS NULL;
```

dev 库复现老板场景（先录 IN 10000，再对 AR-3 点回款 10000）命中：`auto TXN-202611-0006 ↔ other TXN-202611-0001，same_account=1`。
展示：应收行与流水行各挂一个「疑似重复」橙色标签 + tooltip 指向对方编号。**合并动作不在 v1.4 范围**（将来 = 把 Receipt 从 a 改挂到 b + 作废 a + 重算余额）。
3 天窗口、是否要求同账户，**待确认**（见 §8）。

---

## 3. 接口契约

公共约定：金额字符串/数字，正则 `^\d+(\.\d{1,2})?$` 且 > 0（复用 `transactions.js:125-126` 的校验，修 D4）；id 一律 BigInt 字符串；错误走 `badRequest / forbidden / notFound`；所有写操作 `logAudit`。新代码放 `lib/receipt.js`（核销核心：`allocate / revoke / recalcReceivable / recalcTxnLink`）+ `routes/fin/receipts.js`（挂 `/api/fin/receipts`），应收/流水路由只做参数解析后调用 lib，保证应收页和流水页两个入口走同一套校验。

### 3.1 `GET /api/fin/receivables/:id/receipt-candidates`

权限：`receivable.manage`（只为核销服务；ADMIN/FINANCE 同时都有 `transaction.view`）。

| 参数 | 默认 | 说明 |
|---|---|---|
| `amount` | — | 精确金额；不传则不按金额筛，但排序时「流水剩余 = 应收剩余」排最前 |
| `amount_min / amount_max` | — | 金额区间 |
| `date_from / date_to` | 应收创建日 −90 天 ～ 今天 | 流水日期 |
| `account_id` | — | |
| `keyword` | — | 匹配 `code / counterparty / remark` |
| `include_allocated` | `0` | `0` = 只返回剩余可核销 > 0 的；`1` = 已核销满的也返回（置灰） |
| `page / page_size` | 1 / 20 | |

固定过滤：`companyId = 应收.companyId` **且** `AND: [scopeWhere(req.user)]`（双保险，见 §6.4）、`direction='IN'`、`deletedAt IS NULL`、`amount > 0`、`refType IS NULL OR refType IN ('RECEIVABLE','RECEIVABLE_MULTI')`（排除 PAYMENT/LOAN 等已属于别的单据的）、`currency='CNY'`（应收没有币种字段，**待确认**）。
「剩余 > 0」需要和分页一起做，Prisma 的 groupBy 不好分页，建议 `$queryRaw`：`LEFT JOIN (SELECT transaction_id, SUM(amount) allocated FROM receipts WHERE deleted_at IS NULL GROUP BY transaction_id)`。

返回：

```json
{ "list": [{
    "id": "8", "code": "TXN-202611-0001", "txnDate": "2026-11-02",
    "account": { "id": "1", "name": "招行基本户" },
    "amount": "10000.00", "counterparty": "客户甲", "remark": null,
    "status": "UNRECONCILED", "fromImport": false,
    "allocatedAmount": "0.00", "remainingAmount": "10000.00",
    "allocations": [{ "receiptId": "…", "receivableId": "…", "receivableCode": "AR-2026-0003", "amount": "…" }],
    "match": { "amountEqualsRemaining": true, "counterpartyHit": true, "suspectedDuplicateOf": null }
  }],
  "total": 1, "page": 1, "pageSize": 20,
  "receivable": { "remainingAmount": "10000.00" } }
```

排序：`amountEqualsRemaining` → `counterpartyHit`（对方名称包含客户名或反之）→ `txnDate desc`。

### 3.2 `POST /api/fin/receivables/:id/receipt`（扩展，向后兼容）

权限：`receivable.manage`；带 `transactionId` 时额外要求 `can(user,'transaction.manage')`（会改流水的 ref/status）。

```json
// 方式 A：核销已有流水（新）
{ "transactionId": "8", "amount": "6000.00", "remark": "…" }
// 方式 B：新建流水（现有行为，字段不变）
{ "accountId": "1", "amount": "10000", "receiptDate": "2026-11-02", "remark": "…" }
```

校验（按顺序，全部在 `prisma.$transaction` 内，先 `SELECT … FROM transactions WHERE id=? FOR UPDATE`，再 `SELECT … FROM receivables WHERE id=? FOR UPDATE`，**固定先流水后应收**防死锁）：

| # | 规则 | 错误 |
|---|---|---|
| 1 | 金额格式、> 0 | 400 |
| 2 | 应收存在、未删、`inScope` | 404 |
| 3 | 应收状态 ∈ PENDING / PARTIAL | 400「已收清 / 已取消 / 已核销的应收不能再登记回款」 |
| 4 | `amount ≤ 应收剩余`（超收是否允许 **待老板拍板**，默认拒绝） | 400 |
| A5 | 流水存在、未删、`inScope` | 404 |
| A6 | `流水.companyId = 应收.companyId` | 400「流水不属于该应收所在公司」 |
| A7 | `direction='IN'`、`refType ∈ (NULL, RECEIVABLE, RECEIVABLE_MULTI)` | 400「这笔流水已关联付款单/借款，不能再核销应收」 |
| A8 | `amount ≤ 流水剩余`（流水金额 − 有效 Receipt 合计） | 400「这笔流水只剩 ¥x 可核销」 |
| A9 | 流水日期所在月未关账（`assertPeriodOpen(txn.companyId, txn.txnDate)`），**待老板拍板**，见 §6.2 | 400 |
| A10 | 同流水×同应收已有有效核销 → 唯一键冲突 | 400「已核销过，如需调整请先撤销」 |
| B5-B7 | 现有：账户范围、账户属于该公司、收款日期未关账（`receivables.js:64-71`） | 不变 |

动作：A → 插 Receipt（`source='LINK'`，`txnStatusBefore=流水原 status`）；B → `createWithCode` 新建流水（字段同现在）+ 插 Receipt（`source='AUTO'`）。然后 `recalcReceivable`、`recalcTxnLink`；事务提交后 B 才 `recalcAccountBalance(account.id)`（A 不涉及余额变化，不用调）。
返回 `{ receivable, transaction, receipt }`——**保持 `data.transaction` 字段**，`assistant-submit.js:99` 依赖它。

`recalcTxnLink(tx, txnId)`：根据该流水有效 Receipt 指向的应收个数，0 → `refType/refId = NULL`、`status = 最早一行的 txnStatusBefore ?? 原值`；1 → `RECEIVABLE / 该应收 id`；≥2 → `RECEIVABLE_MULTI / NULL`。有 ≥1 行时 `status='RECONCILED'`（与付款关联、现有回款一致；语义冲突见 §6.3）。

### 3.3 `DELETE /api/fin/receipts/:id`（撤销核销）

权限：`receivable.manage`（+ `transaction.manage`，同 3.2）。

- 404：不存在 / 已撤销 / 不在范围。
- 关账：流水日期所在月已关账 → 拒绝（与 3.2-A9 同口径）。
- 事务内：锁流水 → 锁应收 → `deletedAt=now, activeFlag=NULL, revokedBy` → `recalcReceivable` → `recalcTxnLink`。
- `source='AUTO'` 的（这笔流水当初就是为这次回款建的）：撤销时**同时作废该流水**（若该流水没有其他有效 Receipt），事务后 `recalcAccountBalance`。可选参数 `keepTransaction=1` 保留流水（比如发现它其实就是银行那笔，只是想改挂）。
- `source='BACKFILL'`：按 AUTO 处理（历史上就是 `/receipt` 自动建的）。
- `source='LINK'`：只解除关联，流水保留，`status` 恢复为 `txnStatusBefore`。
- 审计：`entity='receipt'`，summary `撤销 AR-xxx ← TXN-xxx ¥amount`，before 带整行。

另配两个只读接口（`receivable.view` / `transaction.view`）：

- `GET /api/fin/receivables/:id/receipts` → `[{ receipt, transaction{code,txnDate,account,amount,counterparty} }]`
- `GET /api/fin/transactions/:id/receipts` → `[{ receipt, receivable{code,title,amount,receivedAmount} }]`

### 3.4 发票 ↔ 应收

- `GET /api/fin/invoices?receivable_id=` ：crud `filters` 加 `receivable_id: 'receivableId'`（`invoices.js:63`），`INCLUDE` 加 `receivable: { select: { id, code, title, amount } }`。权限 `invoice.view`。
- **现有没有 PATCH**（`lib/crud.js:137` 只有 PUT）。不新造 PATCH，用 crud 的 **`PUT /api/fin/invoices/:id { receivableId | null }`**：`fields` 加 `receivableId`，`beforeUpdate`（及 `beforeCreate`）校验：应收存在、未删、`inScope`、**同公司**；发票类型 ∈ SALES / RED（**待确认** RED 是否挂应收、是否冲减开票额）；客户不一致给 warning 不拦。权限 `invoice.manage`。
- `GET /api/fin/receivables/:id/invoice-candidates?keyword=&include_linked=0`：同公司 + 同客户（`customerId` 或 `buyerName` 含客户名）+ `type='SALES'` + `receivableId IS NULL`（`include_linked=1` 时也返回已挂别的应收的，置灰）。crud 的 filter 没法表达 `IS NULL`，所以单开。权限 `receivable.manage`。
- `PUT /api/fin/receivables/:id/invoices { invoiceIds: [] }`：应收表单多选用，**整组覆盖**（不在列表里的本应收发票摘掉）。权限 `receivable.manage` + `invoice.manage`。返回 `{ invoices, invoicedTotal, diff: 应收金额 − 发票价税合计合计 }`。
- 应收详情 GET 的 include 加 `invoices`（crud 的 `include` 配置，`receivables.js:16-20`）。

### 3.5 流水页反方向核销：`POST /api/fin/transactions/:id/reconcile`

权限：`transaction.manage` + `receivable.manage`。

```json
{ "allocations": [ { "receivableId": "2", "amount": "12000" }, { "receivableId": "3", "amount": "8000" } ] }
```

一次请求可拆多笔（拆分场景主要从这里进）。整组在**一个事务**里：先锁流水，再按 `receivableId` 升序逐个锁应收，逐条走 §3.2 的 1-4、A5-A10；任一失败整组回滚。`Σamount ≤ 流水剩余`。
配套候选：`GET /api/fin/transactions/:id/receivable-candidates?keyword=&customer_id=`——同公司、PENDING/PARTIAL、按「剩余 = 流水剩余」与客户名匹配排序（复用 `assistant-drafts.js:183-222` 的匹配思路）。

### 3.6 疑似重复：`GET /api/fin/receipts/suspected-duplicates?company_id=`

权限：`receivable.view`。返回 §2.5 SQL 的结果（附 `scopeWhere` 过滤）。列表页为避免 N+1，前端一次拉当前页涉及的 id 集合即可。

### 3.7 权限汇总

| 接口 | 权限 |
|---|---|
| `GET receivables/:id/receipt-candidates` | receivable.manage |
| `POST receivables/:id/receipt`（无 transactionId） | receivable.manage |
| `POST receivables/:id/receipt`（有 transactionId） | receivable.manage + transaction.manage |
| `DELETE receipts/:id` | receivable.manage + transaction.manage |
| `GET receivables/:id/receipts` | receivable.view |
| `GET transactions/:id/receipts` | transaction.view |
| `GET invoices?receivable_id=` | invoice.view |
| `PUT invoices/:id {receivableId}` | invoice.manage |
| `GET receivables/:id/invoice-candidates` | receivable.manage |
| `PUT receivables/:id/invoices` | receivable.manage + invoice.manage |
| `POST transactions/:id/reconcile`、`GET transactions/:id/receivable-candidates` | transaction.manage + receivable.manage |
| `GET receipts/suspected-duplicates` | receivable.view |

`requirePermission` 只收一个点，「+」的第二个点在 handler 里 `can(req.user, …)` 再判。目前两个点的角色集合完全相同（ADMIN、FINANCE），**不新增权限点，`auth.js` 与 `permissions.js` 都不用改**。

---

## 4. 界面

所有新弹窗：桌面 `width` 用 `min(720px, 96vw)` 风格的固定宽；手机由 `mobile.css:156-175` 自动全屏；表格一律 `ResponsiveTable` + 列上标 `mobile=`，不出现横向滚动。接口前缀走 `api/index.js` 的 `${B}`（CLAUDE.md 约定）。

### 4.1 应收页「登记回款」弹窗改两步（`Receivables.vue:80-101` 重写为组件 `components/ReceiptDialog.vue`）

```
el-dialog「登记回款」
├─ el-alert：{标题}｜应收 ¥x｜已收 ¥y｜剩余 ¥z    [疑似重复] 标签（若有）
├─ el-steps ① 选流水  ② 确认金额
│
├─ 步骤①（默认）
│   ├─ 筛选行：关键词 | 日期区间 | 账户 | [✓只看未核销]  | 金额=剩余 快捷 chip
│   ├─ ResponsiveTable（单选）
│   │    日期(mobile=badge) | 账户 | 对方(mobile=title) | 金额(mobile=amount) | 已核销 | 剩余 | 来源(导入/手工)
│   │    已核销满的行置灰不可选；命中「金额=剩余」「对方含客户名」显示小标签
│   └─ 底部链接：「找不到这笔钱？新建一条流水 →」 切到现有表单（账户/金额/日期/备注，即旧弹窗，走方式 B）
│
├─ 步骤②（选中后）
│   ├─ 选中流水摘要：TXN-xxx  2026-11-02  招行基本户  +¥10,000  剩余 ¥10,000
│   ├─ 本次核销金额：默认 min(应收剩余, 流水剩余)，上限同此
│   ├─ 备注
│   └─ 提示：差额 ¥d 将留在应收（部分收款）/ 留在流水（可再核销到其他应收）
│
└─ footer：取消 | 上一步 | 确认核销
```

- 新增应收勾「已收到款」（`:23-46`）：保留现在的「新建流水」路径，另加一个选项「从已有流水里选」→ 保存后打开上面的弹窗并直接进步骤①。
- 助手回款草稿预填（`:199-215`）：继续进「新建流水」那一页（行为不变）；步骤①顶部提示「草稿金额 ¥x，下方是金额相同的已有流水，若是同一笔请直接选」。

### 4.2 应收表单加「发票」（`formFields` 之后放在 `#form-extra`）

- `el-select multiple filterable remote`，数据源 `invoice-candidates`（按应收的公司 + 客户；金额接近的排前），选项文案 `发票号｜开票日｜¥价税合计`。
- 下方一行：`已选 n 张，发票合计 ¥a，应收 ¥b，差额 ¥(b−a)`；差额 ≠ 0 时橙字，不阻止保存（部分开票是常态）。
- 保存：crud 先存应收，`afterSave` 再调 `PUT receivables/:id/invoices`（与现在 `afterSave` 调 `/receipt` 同一模式）。
- 列表 `col-amount`（`:69-72`）下加一行小字「已开票 ¥a」。

### 4.3 应收详情（新增抽屉 `ReceivableDrawer.vue`；CrudTable 没有详情插槽，用行操作「详情」打开）

```
el-drawer（手机 size=100%）
├─ 头部：AR 编号 / 客户 / 应收 / 已收 / 剩余 / 状态
├─ 关联发票：表格 发票号 | 开票日 | 价税合计 | 状态 | [摘除]   + [挂发票]
│           合计行：发票合计 ¥a，差额 ¥(应收−a)
└─ 收款构成：表格 流水编号 | 日期 | 账户 | 本次核销 | 流水总额 | 来源(核销/自动/回填) | [撤销]
            合计行 = 已收（应与 receivedAmount 一致，不一致标红——防御性展示）
```

### 4.4 发票台账（`Invoices.vue`）

- 列表 `columns` 加「关联应收」：`AR 编号`（可点开应收抽屉），未挂显示「—」；销项未挂的加筛选「未关联应收」。
- 表单加「关联应收」select（远程搜索本公司 PENDING/PARTIAL/RECEIVED 应收），可清空 = 摘除；走 crud PUT。
- 顺手修导入写死 `PURCHASE`（`:125-126`）：导入前弹选择「公司 + 发票类型」——否则销项发票进不了应收候选。**是否纳入 v1.4 待确认**，不纳入就在候选里放宽 type。

### 4.5 流水页（`Transactions.vue`）

- 行操作 `:115-121`：`direction==='IN' && 剩余可核销>0 && refType∈(null,RECEIVABLE,RECEIVABLE_MULTI)` 时显示「核销到应收」。
- 弹窗：上半区候选应收表（编号 | 客户 | 标题 | 剩余），可勾多行；下半区每行填金额，默认按顺序吃满；底部实时显示「流水 ¥x，已分配 ¥y，剩余 ¥z」，`y>x` 时禁用提交。
- 金额列下加小字：`已核销 ¥a / 剩余 ¥b` 或「→ AR-xxx」；有疑似重复挂橙色标签。
- 列表接口需要返回每行已核销金额：`transactions.js:63-67` 的 list 之后补一次 `receipt.groupBy({ by:['transactionId'], where:{ transactionId:{in:ids}, deletedAt:null } })`。
- 编辑弹窗：有有效核销的流水，金额/方向/公司/账户置灰并提示「已核销到 AR-xxx，先撤销才能改」；后端同样拦（§2.3）。
- 作废确认文案：有核销时直接提示不能作废。

### 4.6 移动端 375 检查点

- 两步弹窗在手机全屏，`el-steps` 用 `simple` 样式；候选表 ResponsiveTable 卡片化（对方=title，金额=amount，日期/已核销=badge）。
- 流水页拆分弹窗在手机上改成「一行一张卡片 + 金额输入框」，不出现两列表格。
- 375 宽截图验收：`.gitignore` 里提到 `npm run mobile:shots`，但当前各 `package.json` 里**没有这个脚本**（待确认是否遗失），先用 DevTools 375×812 手工截图。

---

## 5. 切片与验收

| 切片 | 内容 | 预计轮次 |
|---|---|---|
| S1 | 模型 + 回填 + 统一维护函数 + 堵漏（无新界面） | 2 |
| S2 | 核销/撤销/候选接口（后端）+ 四场景接口级验收 | 2–3 |
| S3 | 应收两步弹窗、应收详情、流水页核销、疑似重复提示 + 四场景页面验收 | 3 |
| S4 | 发票↔应收（字段、接口、表单、台账列） | 2 |

### S1 模型、回填、统一维护（上线后用户无感）

改：`backend/prisma/schema.prisma`（Receipt、Invoice.receivableId、反向关系）；新增 `backend/src/lib/receipt.js`（`recalcReceivable / recalcTxnLink`）；`routes/fin/receivables.js`（`/receipt` 改为「事务 + 锁 + 写 AUTO Receipt + 全量重算」，入参不变；加金额正数与剩余上限校验；crud hooks 拦 amount/status/DELETE）；`routes/fin/transactions.js`（PUT/DELETE 有核销时拦，忽略 refType=RECEIVABLE*）；新增 `backend/scripts/backfill-v140-receipts.mjs`（`--dry-run` 出 ②③ 表，`--apply` 回填 + 确认后重算）。
文档：`05-更新日志.md`（修 D2/D4/D5）、`04-踩过的坑.md`（D2「作废流水不回退已收」）、`docs/接口说明.md`（receipts 表）。

验：

- `db push` 不带 `--accept-data-loss` 成功（已在 dev 库验证）。
- 回填跑两遍，第二遍 0 插入；② ③ 表与人工预期一致。
- 接口：负数 / 超收 / 已取消应收回款 → 400；作废有核销的流水 → 400；PUT 应收 amount 低于已收 → 400。
- 回归：`node scripts/assistant-e2e.mjs`（stub 模式）全绿，特别是 `k-cross-page.mjs:92-102`（助手回款 + 重复提交不二次冲减）、`c-scope.mjs:147`。
- SQL：`SELECT … WHERE received_amount <> receipt 汇总` 为空（③）。

### S2 核销接口 + 四场景接口验收

改：`lib/receipt.js`（`allocate / revoke`）；`routes/fin/receivables.js`（`receipt-candidates`、`receipts`、`/receipt` 支持 `transactionId`）；新增 `routes/fin/receipts.js`（DELETE、suspected-duplicates）并在 `src/index.js` 挂 `/api/fin/receipts`；`routes/fin/transactions.js`（`/:id/reconcile`、`/:id/receivable-candidates`、`/:id/receipts`、列表带已核销金额）；`frontend/src/api/index.js` 加方法。
新增测试 `backend/scripts/tests/l-receipts.mjs`（沿用 `fixtures.mjs` / `lib.mjs`，在 E2E 测试公司里建数据，跑完硬删）。

**专门验四个场景**（接口 + SQL 双断言）：

| 场景 | 步骤 | 断言 |
|---|---|---|
| ① 先有流水 → 选它核销 | 建 AR 10000；POST 流水 IN 10000（得 T）；`POST /receipt {transactionId:T, amount:10000}` | 流水总数不变；账户余额不变；AR `received=10000 RECEIVED`；T `refType=RECEIVABLE refId=AR status=RECONCILED`；receipts 1 行 `source=LINK` |
| ② 没有流水 → 新建（不回归） | `POST /receipt {accountId, amount:10000, receiptDate}` | 新增 1 笔流水，字段与 v1.3.2 相同（bizType/refType/status/remark）；余额 +10000；receipts 1 行 `source=AUTO` |
| ③ 一笔流水拆两笔应收 | AR1 12000、AR2 8000；流水 T 20000；`POST /transactions/T/reconcile` 两条 | AR1 RECEIVED、AR2 RECEIVED；T `refType=RECEIVABLE_MULTI`；T 剩余 0；再核销 0.01 → 400 |
| ④ 一笔应收收两次 | AR 20000；T1 12000、T2 8000 先后核销 | 第一次后 PARTIAL/12000，第二次后 RECEIVED/20000；`actualDate = T2 日期` |

加验：撤销（LINK 撤销后流水保留且 status 恢复 UNRECONCILED；AUTO 撤销后流水作废、余额回退）、越权（financeA 拿 B 公司流水核销 → 403/404，照 `c-scope.mjs:157-163` 写法）、关账月份流水核销 → 400、并发（同一流水两个请求各核 15000/20000 → 只成功一个，用 `h-concurrency.mjs` 的 `Promise.all` 写法）、`PUT /transactions/T` 改金额低于已核销 → 400。

### S3 界面

改：新增 `frontend/src/components/ReceiptDialog.vue`、`ReceivableDrawer.vue`；`views/admin/Receivables.vue`（换弹窗、详情入口、已收到款的「从已有流水选」、疑似重复标签）；`views/admin/Transactions.vue`（核销按钮与拆分弹窗、已核销列、编辑置灰）；`frontend/src/docs/02-每月SOP.md`（回款步骤改为「先导银行流水 → 应收点登记回款选流水」）、`05-更新日志.md`。

验（页面，桌面 + 375 各走一遍，四场景同 S2 但全从界面点）：

- ① 应收「登记回款」第一屏就能看到金额相同的那笔流水并标「金额一致」，选中→确认，流水页那笔变「→ AR-xxx」，不新增流水。
- ② 点「找不到这笔钱？新建一条流水」，表单与旧弹窗一致，提交后流水页多一笔。
- ③ 流水页对 20000 那笔点「核销到应收」，勾两笔各填金额，提交后两笔应收都已收。
- ④ 应收详情「收款构成」显示两行，合计=已收。
- 疑似重复：用 §2.5 的复现数据，应收和流水两边都有橙色标签。
- 手机：弹窗无横向滚动条（DevTools 375×812）。

### S4 发票 ↔ 应收

改：`routes/fin/invoices.js`（fields/filters/include/hooks 校验）、`routes/fin/receivables.js`（`invoice-candidates`、`PUT /:id/invoices`、详情 include invoices）；`views/admin/Invoices.vue`（关联应收列 + 表单字段 + 未关联筛选，可选：导入选类型）；`Receivables.vue` 表单发票多选、列表「已开票」；`ReceivableDrawer.vue` 关联发票区；`lib/assistant-drafts.js:195-212`（发票已挂应收时直接用 `invoice.receivableId`，不再按金额猜——**可选**，改了要补 `k-cross-page` 用例）。

验：一笔应收挂两张发票（部分开票）→ 差额显示正确；同一发票改挂到另一应收 → 原应收发票列表少一张；跨公司挂 → 400；`GET invoices?receivable_id=` 只返回本应收的；VIEWER 看得到列、看不到编辑。

---

## 6. 风险

### 6.1 `receivedAmount` 与 Receipt 汇总不一致

风险点与防法：

| 风险点 | 防法 |
|---|---|
| 历史 D2/D4 已造成偏差 | 回填出差异表 → 老板确认 → 一次性重算；**S2 上线前清零**（§2.4） |
| 任一写路径漏调重算 | 只有 `lib/receipt.js` 能写 `receivedAmount`；全量重算而非加减；代码评审时 `grep receivedAmount` 写入点必须只有这一处 |
| 并发（两人同时核销同一流水/应收） | 交互式事务 + `FOR UPDATE`，固定「先流水、后应收（id 升序）」加锁顺序；`receipts_active_pair` 唯一键兜底 |
| 流水被改金额/作废/改公司 | `transactions.js` PUT/DELETE 拦截（§2.3）；批量接口不改金额，不受影响 |
| 应收被改金额/状态/作废 | crud hooks 拦截（§2.3） |
| 助手绕过 | 助手只通过 `selfRequest` 调 `/receipt`（`assistant-submit.js:95`），自然走同一套 |
| 将来有人直接写库/新路由 | 建议加一个只读巡检：月结检查清单加第 9 项「应收已收与收款明细一致」（`lib/close.js:55-64`），**待确认**是否要加 |

### 6.2 关账（ClosePeriod）与核销

- 现状：关账只锁「流水/付款」（README 硬约定 4、`lib/close.js:11-25`），应收本身不受锁；回款接口按**收款日期**校验（`receivables.js:69-71`）。
- 选已有流水核销时，**会改那笔流水的 `refType/refId/status`**，而流水在已关账月份是「不可改」的。方案默认：**按流水日期校验，关账月份的流水不能核销/撤销**，要么先解锁、要么老板拍板允许「只写 Receipt、不动流水字段」（那样月结快照 `incomeTotal` 等不受影响，因为没有新的钱）。列入 §8 问题 2。
- 新建流水路径（方式 B）关账校验不变。

### 6.3 流水 `status` 与银行对账冲突

- `RECONCILED` 在本系统的含义是「已核对（对过银行）」（`constants/index.js:31-35`），月结检查清单按它判断（`close.js:40,58`）。现有回款、付款关联、借款都在建/关联时直接置 RECONCILED，所以**核销置 RECONCILED 与现有做法一致**，但也意味着「核销 = 视为已核对」。
- 冲突场景：银行导入的流水（UNRECONCILED）被核销 → 变 RECONCILED，月结「流水已全部核对」随之通过；撤销核销要能恢复，所以 Receipt 存 `txnStatusBefore`。用户手工把 RECONCILED 改回 UNRECONCILED 不影响 Receipt。
- 另一层冲突：**应收状态 `WRITTEN_OFF` 在界面上叫「已核销」**（`constants/index.js:62`，含义是坏账核销）。新功能若也叫「核销」，用户会把两者混淆。建议界面动词用「**认领流水 / 关联流水**」，或把 `WRITTEN_OFF` 显示改为「坏账核销」。列入 §8 问题 3。
- `refType` 只有一个槽：拆分时用 `RECEIVABLE_MULTI`（refId=NULL），所有判断「是否回款流水」的地方要同时认这两个值（目前只有 `assistant-submit.js:201`、`stores/assistant.js:19` 判断 `RECEIVABLE`，它们判断的是草稿 payload 不是库里的流水，不受影响）。

### 6.4 平台登录 / `companyScope` 在候选查询里的过滤

- 候选流水：应收先 `inScope` 校验，再查 `companyId = 应收.companyId`；**仍然把 `scopeWhere(req.user)` 放进 `AND`**——与 `transactions.js:28`、`crud.js:77` 同一写法（直接展开会被 `companyId` 覆盖，v1.3.0 修过的坑）。
- 写接口：流水、应收、Receipt 三者都各自 `inScope`，并要求流水.companyId = 应收.companyId（不能「A 公司的钱核销 B 公司的应收」，即使用户两个公司都能看）。是否允许集团内代收（A 账户收了 B 的款）——**待确认**，默认不允许，与 `receivables.js:67` 现有口径一致。
- 平台用户：`platform-users.js:42` 把 `companyScope` 带进 `req.user`，与本地账号同口径，无需特殊处理；`suspected-duplicates`、`receipts` 列表同样要 `scopeWhere`。
- 付款侧 `payments.js:151-172` 的 link-transaction 没有范围校验（§1.3），不在 v1.4 范围，建议另开修复。

---

## 7. 十个最关键的文件 / 表 / 接口

1. `backend/src/routes/fin/receivables.js:55-97` —— `/receipt`，要从「必建流水」改成「可选流水 + 写 Receipt」
2. `backend/prisma/schema.prisma:250-354,512-546` —— Transaction / Receivable / Invoice 模型，新增 `receipts` 表与 `invoices.receivable_id`
3. 新增 `backend/src/lib/receipt.js` —— `allocate / revoke / recalcReceivable / recalcTxnLink`，唯一可写 `receivedAmount` 的地方
4. `backend/src/routes/fin/transactions.js:106-189` —— WRITE_FIELDS 与 PUT/DELETE，必须加「有核销不可改/不可删」（修 D2）
5. 表 `transactions.ref_type / ref_id / status`（`schema.prisma:272-280`）—— 回填来源、单槽限制、已核对语义
6. `GET /api/fin/receivables/:id/receipt-candidates` —— 候选流水查询（范围、剩余可核销、分页）
7. `POST /api/fin/transactions/:id/reconcile` —— 拆分核销的主入口
8. `backend/src/lib/assistant-submit.js:93-103` —— 助手回款依赖 `/receipt` 返回 `data.transaction`，必须兼容
9. `frontend/src/views/admin/Receivables.vue:80-101,170-230` —— 回款弹窗与「已收到款」联动
10. `backend/src/lib/close.js:11-25,40,58` —— 关账校验与「已核对」检查项

## 8. 需要老板拍板的新问题

1. **超收怎么办？** 客户多打了钱（回款 > 应收剩余），是**禁止**（必须先改应收金额），还是允许并把多出的部分记为「预收款」？现在系统不拦（实测 5000 的应收收了 99999）。方案默认禁止。
2. **已月结月份的银行流水，还能不能拿来认领应收？** 例：10 月已关账，10 月 30 日到账的那笔钱 11 月才对上应收。方案默认「不能，先解锁 10 月」；另一种做法是允许认领但不改那笔流水的任何字段。
3. **叫法**：现在应收状态里的「已核销」指坏账核销。这次「拿流水冲应收」界面上叫什么？建议叫「认领流水」，并把旧的「已核销」改显示为「坏账核销」。
4. **历史差异以谁为准**：回填会出一张「已收金额 ≠ 实际流水」的清单（典型原因是以前作废了回款流水但应收没退回）。方案建议**以流水为准**统一改正，请老板逐条确认后再执行。
5. **应收金额对发票的哪个数**：应收金额应对齐发票的**价税合计**还是**不含税金额**？决定「发票合计与应收差额」怎么算。红字发票挂在应收上时，是否冲减「已开票」？
6. **集团内代收**：A 公司账户收到本该付给 B 公司的款，能否核销 B 公司的应收？方案默认不允许（与现在「收款账户必须属于应收所在公司」一致）。
7. **疑似重复的判定口径**：同公司、同金额、日期相差 3 天以内，是否还要求同一个账户？窗口 3 天是否合适？

（另有两项技术待确认，不需要老板：平台容器时区（`lib/code.js` 编号月份）、发票导入写死「进项」是否纳入 v1.4 一起修。）
