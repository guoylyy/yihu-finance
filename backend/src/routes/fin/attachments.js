// 附件：发票 PDF / 图片、报销凭证、银行回单
import express from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import prisma from '../../lib/prisma.js'
import { auth } from '../../lib/auth.js'
import { ok, badRequest, notFound, wrap } from '../../lib/response.js'
import { logAudit } from '../../lib/audit.js'
import dayjs from 'dayjs'
import { decodeFileName } from '../../lib/file.js'

const router = express.Router()
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads')

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(UPLOAD_DIR, dayjs().format('YYYYMM'))
    fs.mkdirSync(dir, { recursive: true })
    cb(null, dir)
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname)
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
  }
})
const upload = multer({ storage, limits: { fileSize: 30 * 1024 * 1024 } })

router.post('/', upload.single('file'), wrap(async (req, res) => {
  const { bizType, bizId, companyId, remark } = req.body || {}
  if (!req.file) return badRequest(res, '请选择文件')
  if (!bizType) return badRequest(res, '缺少附件所属业务类型')

  const originalName = decodeFileName(req.file.originalname)
  const row = await prisma.attachment.create({
    data: {
      companyId: companyId ? BigInt(companyId) : null,
      bizType, bizId: bizId ? BigInt(bizId) : null,
      fileName: originalName,
      filePath: path.relative(UPLOAD_DIR, req.file.path),
      fileSize: req.file.size, mimeType: req.file.mimetype,
      uploaderId: req.user?.id ? BigInt(req.user.id) : null,
      remark
    }
  })
  await logAudit(req, { action: 'CREATE', entity: 'attachment', entityId: row.id, summary: `上传附件 ${originalName}` })
  return ok(res, row)
}))

router.get('/', wrap(async (req, res) => {
  const { bizType, bizId } = req.query
  const where = {}
  if (bizType) where.bizType = bizType
  if (bizId) where.bizId = BigInt(bizId)
  const list = await prisma.attachment.findMany({ where, orderBy: { id: 'desc' }, take: 200 })
  return ok(res, { list })
}))

router.get('/:id/download', wrap(async (req, res) => {
  const row = await prisma.attachment.findUnique({ where: { id: BigInt(req.params.id) } })
  if (!row) return notFound(res)
  const full = path.join(UPLOAD_DIR, row.filePath)
  if (!fs.existsSync(full)) return notFound(res, '文件已丢失')
  return res.download(full, row.fileName)
}))

router.delete('/:id', wrap(async (req, res) => {
  const row = await prisma.attachment.findUnique({ where: { id: BigInt(req.params.id) } })
  if (!row) return notFound(res)
  await prisma.attachment.delete({ where: { id: row.id } })
  await logAudit(req, { action: 'DELETE', entity: 'attachment', entityId: row.id, summary: `删除附件 ${row.fileName}` })
  return ok(res, { id: String(row.id) })
}))

export default router
