# 给 Claude 的项目须知

集团财务系统。Vue 3 + Element Plus 前端，Express 4 + Prisma 6 + MySQL 后端，架构对齐 yihu-fde 平台。

## 动手前
- 读 `README.md` 的「四、几条硬约定」，那几条是踩过坑总结的，不要绕开。
- 金额永远 `Decimal(18,2)`；日期字段用 `lib/period.js` 的 `toDate()`，别直接 `new Date()`。
- 加/改权限点：`backend/src/lib/auth.js` 的 `PERMISSIONS` 与前端 `frontend/src/api/permissions.js` 必须一起改。
- 新增台账模块：后端优先用 `lib/crud.js` 的 `crudRouter()`，前端优先用 `components/CrudTable.vue`，只有确实特殊的业务动作才手写。
- 任何写入流水的地方，写完必须调 `recalcAccountBalance(accountId)`，否则余额会和流水对不上。
- 改动付款/月结相关逻辑，记得走 `logAudit()` 留痕。
- **任何用户可感知的改动（新功能、行为变化、修 bug），都要在 `frontend/src/docs/05-更新日志.md` 顶部补一条**；
  影响操作流程的，同时改 `02-每月SOP.md`；踩坑修复写进 `04-踩过的坑.md`。

## 本地环境
- MySQL：`mysql://root:root@localhost:3306/yihu_finance`
- 后端 3010，前端 5183（vite 代理 `/api` 到后端）
- 改 schema 后：`npx prisma db push && npx prisma generate`

## 以虎 One 接入
- 可部署到以虎 One（见 README「部署到以虎 One」）。接入代码集中在 `backend/src/lib/platform.js`、`platform-users.js` 和 `frontend/src/api/base.js`
- 前端的接口、跳转、路由一律从 `BASE` 拼前缀，不要再写 `'/api/...'`、`location.href = '/xxx'` 这种根路径
- `backend/src/lib/yh-one.mjs` 是平台 SDK 的拷贝，不要改；要升级从平台 `/sdk/yh-one.mjs` 重新下载
- 改 schema 时新增的字段要可空或有默认值（平台上启动时 `db push` 不带 `--accept-data-loss`，会丢数据的改动直接失败）
- 新增给 AI 助手的工具：在 `backend/src/index.js` 的 `mountPlatform({ tools })` 里加，只读、用 `callSelf` 走本系统接口（权限自然一致）

