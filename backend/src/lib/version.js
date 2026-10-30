// 应用版本号：发版只改 yh-app.json，启动时读一次，由 /api/health 带给前端（前端不许写死）
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const cwd = process.cwd()
// 优先按本文件定位（backend/src/lib → 仓库根、backend），工作目录只做兜底
const DIRS = [path.resolve(here, '../../..'), path.resolve(here, '../..'), cwd, path.resolve(cwd, '..')]

function versionIn(file, dirs) {
  for (const dir of dirs) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).version
      if (typeof v === 'string' && v.trim()) return v.trim()
    } catch { /* 文件不在或坏了：试下一处，不能影响启动和健康检查 */ }
  }
  return ''
}

export const readVersion = (dirs = DIRS) => versionIn('yh-app.json', dirs) || versionIn('package.json', dirs)

export const APP_VERSION = readVersion()
