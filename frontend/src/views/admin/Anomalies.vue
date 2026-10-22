<template>
  <div class="page" v-loading="loading">
    <div class="page-head">
      <div>
        <div class="page-title">异常清单</div>
        <div class="page-sub">系统自动扫出来的「需要人看一眼」的事情：缺账号、重复发票、未核对流水、逾期收付款…</div>
      </div>
      <div>
        <el-select v-model="companyId" placeholder="全部公司" clearable style="width: 140px" @change="load">
          <el-option v-for="c in companies" :key="c.id" :label="c.code" :value="c.id" />
        </el-select>
        <el-button style="margin-left: 8px" @click="load"><el-icon><Refresh /></el-icon>重新扫描</el-button>
      </div>
    </div>

    <el-empty v-if="!list.length && !loading" description="没有发现异常，账目很干净 🎉" />

    <div v-for="a in list" :key="a.key" class="anomaly-card" :class="a.level">
      <div class="head">
        <el-icon :size="18"><WarningFilled v-if="a.level !== 'info'" /><InfoFilled v-else /></el-icon>
        <span class="title">{{ a.title }}</span>
        <el-tag size="small" :type="a.level === 'danger' ? 'danger' : a.level === 'warn' ? 'warning' : 'info'">
          {{ a.count }} 项
        </el-tag>
      </div>
      <div class="detail">{{ a.detail }}</div>
      <div class="action">
        <el-icon><Right /></el-icon>{{ a.action }}
        <el-button v-if="LINKS[a.key]" link type="primary" @click="$router.push(LINKS[a.key])">立即处理</el-button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onActivated } from 'vue'
import { ElMessage } from 'element-plus'
import api from '@/api'
import { companies, loadMeta } from '@/composables/useMeta'

const loading = ref(false)
const list = ref([])
const companyId = ref('')

const LINKS = {
  missing_account: '/parties',
  unreconciled: { path: '/transactions', query: { status: 'UNRECONCILED' } },
  abnormal: { path: '/transactions', query: { status: 'ABNORMAL' } },
  dup_invoice: '/invoices',
  overdue_ar: '/receivables',
  overdue_pay: '/payments',
  stale_balance: '/accounts',
  no_invoice: '/invoices'
}

async function load() {
  loading.value = true
  try {
    const d = await api.ai.anomalies({ company_id: companyId.value })
    list.value = d.anomalies
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

onActivated(() => load())
onMounted(async () => { await loadMeta(); load() })
</script>

<style scoped>
.anomaly-card {
  background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--text-muted);
  border-radius: var(--card-radius); padding: 14px 16px; margin-bottom: 10px;
}
.anomaly-card.danger { border-left-color: var(--danger); }
.anomaly-card.warn { border-left-color: var(--warning); }
.anomaly-card.info { border-left-color: var(--text-muted); }
.head { display: flex; align-items: center; gap: 8px; }
.head .title { font-size: 15px; font-weight: 600; }
.detail { font-size: 13px; color: var(--text-secondary); margin: 6px 0 4px; }
.action { font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 4px; }
</style>
