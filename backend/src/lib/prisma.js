import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient({
  log: process.env.PRISMA_LOG === '1' ? ['query', 'warn', 'error'] : ['warn', 'error']
})

export default prisma
