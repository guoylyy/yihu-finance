// 全局基础数据缓存：公司 / 账户 / 分类 / 员工，多个页面共用，避免每次进页面都拉一遍
import { ref } from 'vue'
import api from '@/api'

export const companies = ref([])
export const accounts = ref([])
export const categories = ref([])
export const persons = ref([])

let loaded = false

export async function loadMeta(force = false) {
  if (loaded && !force) return
  const [c, a, cat] = await Promise.all([
    api.companies.list({ page_size: 100, status: 'ACTIVE' }),
    api.accounts.list({ page_size: 200 }),
    api.categories.list({ page_size: 200 })
  ])
  companies.value = c.list
  accounts.value = a.list
  categories.value = cat.list
  loaded = true
}

export async function loadPersons(force = false) {
  if (persons.value.length && !force) return
  const p = await api.persons.list({ page_size: 300 })
  persons.value = p.list
}

export function companyName(id) {
  return companies.value.find((c) => String(c.id) === String(id))?.code || '—'
}

export function accountsOf(companyId) {
  if (!companyId) return accounts.value
  return accounts.value.filter((a) => String(a.companyId) === String(companyId))
}

export function resetMeta() {
  loaded = false
  companies.value = []
  accounts.value = []
  categories.value = []
  persons.value = []
}
