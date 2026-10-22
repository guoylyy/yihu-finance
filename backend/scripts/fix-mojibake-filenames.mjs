// 修复历史数据里的乱码文件名（导入批次 + 操作日志）
// 成因见 src/lib/file.js：multer 按 latin1 解析 multipart 字段
import prisma from '../src/lib/prisma.js'
import { decodeFileName, repairMojibake } from '../src/lib/file.js'

let fixed = 0

const batches = await prisma.importBatch.findMany()
for (const b of batches) {
  const name = decodeFileName(b.fileName)
  if (name !== b.fileName) {
    await prisma.importBatch.update({ where: { id: b.id }, data: { fileName: name } })
    console.log(`  批次 #${b.id}  ${b.fileName}\n        → ${name}`)
    fixed++
  }
}

const logs = await prisma.auditLog.findMany()
for (const l of logs) {
  if (!l.summary) continue
  const summary = decodeFileName(l.summary)
  if (summary !== l.summary) {
    await prisma.auditLog.update({ where: { id: l.id }, data: { summary } })
    console.log(`  日志 #${l.id}  ${summary}`)
    fixed++
  }
}

const atts = await prisma.attachment.findMany()
for (const a of atts) {
  const name = decodeFileName(a.fileName)
  if (name !== a.fileName) {
    await prisma.attachment.update({ where: { id: a.id }, data: { fileName: name } })
    console.log(`  附件 #${a.id}  → ${name}`)
    fixed++
  }
}

console.log(`\n共修复 ${fixed} 条`)
await prisma.$disconnect()
