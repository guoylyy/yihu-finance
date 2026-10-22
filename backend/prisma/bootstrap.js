// 容器每次启动时执行（见 Dockerfile）：只补齐收支分类这类结构性数据，可重复执行
// 公司、账户、员工、账号这些真实数据不在这里：新部署从原来的库迁移（mysqldump → yh restore），或登录后在页面里建
import 'dotenv/config'
import prisma from '../src/lib/prisma.js'
import { CATEGORIES } from './seed.js'

for (const [kind, name] of CATEGORIES) {
  await prisma.category.upsert({ where: { kind_name: { kind, name } }, create: { kind, name }, update: {} })
}
console.log(`✔ 收支分类 ${CATEGORIES.length} 个`)
await prisma.$disconnect()
