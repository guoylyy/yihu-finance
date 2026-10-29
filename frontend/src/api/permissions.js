// 前端权限：与后端 lib/auth.js 的 PERMISSIONS 矩阵保持一致
// 登录后由 /api/auth/me 下发生效权限点，这里只做缓存与判断
// finance.view：录入助手入口（v1.1 新增，后端 PERMISSIONS 同步加了这一项）
import { ref } from 'vue'

const perms = ref([])

export function setPermissions(list) {
  perms.value = Array.isArray(list) ? list : []
}

export function can(perm) {
  return perms.value.includes(perm)
}

export function canAny(...list) {
  return list.some((p) => perms.value.includes(p))
}

export const ROLE_LABELS = {
  ADMIN: '管理者',
  FINANCE: '财务',
  MANAGER: '经理',
  STAFF: '业务',
  VIEWER: '只读'
}
