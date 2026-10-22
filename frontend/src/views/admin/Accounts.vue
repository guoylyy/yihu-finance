<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="page-title">账户管理</div>
        <div class="page-sub">余额 = 期初余额 + 收入 − 支出，随流水自动重算</div>
      </div>
      <div>
        <el-button v-if="can('transaction.manage')" @click="transferVisible = true">
          <el-icon><Sort /></el-icon>内部转账
        </el-button>
        <el-button v-if="can('account.manage')" type="primary" @click="openForm()">
          <el-icon><Plus /></el-icon>新增账户
        </el-button>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-card is-accent">
        <div class="label">集团总余额（CNY）</div>
        <div class="value">¥{{ money(summary.groupTotal?.CNY) }}</div>
      </div>
      <div v-if="summary.groupTotal?.USD" class="stat-card">
        <div class="label">美元账户合计</div>
        <div class="value">${{ money(summary.groupTotal.USD) }}</div>
      </div>
    </div>

    <div v-for="c in summary.companies" :key="c.companyId" class="company-block">
      <div class="block-head">
        <span class="name">{{ c.code }}</span>
        <span class="sum money">
          <template v-for="(v, cur) in c.currencies" :key="cur">
            {{ cur === 'CNY' ? '¥' : '$' }}{{ money(v) }}&nbsp;&nbsp;
          </template>
        </span>
      </div>
      <el-table :data="c.accounts" size="small">
        <el-table-column prop="name" label="账户名称" min-width="150">
          <template #default="{ row }">
            {{ row.name }}
            <el-tag v-if="row.isPrimary" size="small" effect="plain" type="warning">主账户</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="110">
          <template #default="{ row }">{{ ACCOUNT_TYPE_LABEL[row.type] || row.type }}</template>
        </el-table-column>
        <el-table-column prop="accountNo" label="账号" width="170">
          <template #default="{ row }"><span class="num">{{ row.accountNo || '—' }}</span></template>
        </el-table-column>
        <el-table-column prop="currency" label="币种" width="70" />
        <el-table-column label="当前余额" width="150" align="right">
          <template #default="{ row }"><span class="money" style="font-weight: 600">{{ money(row.balance) }}</span></template>
        </el-table-column>
        <el-table-column label="期初 / 基准日" width="170">
          <template #default="{ row }">
            <span class="money">{{ money(row.initialBalance) }}</span>
            <span class="muted" style="font-size: 12px"> · {{ date(row.initialDate) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="reconcile(row)">对账</el-button>
            <el-button link type="primary" @click="$router.push({ path: '/transactions', query: { account_id: row.id } })">流水</el-button>
            <el-button v-if="can('account.manage')" link type="primary" @click="openForm(row, c)">编辑</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 账户表单 -->
    <el-dialog v-model="formVisible" :title="form.id ? '编辑账户' : '新增账户'" width="520px">
      <el-form :model="form" label-width="100px">
        <el-form-item label="所属公司" required>
          <el-select v-model="form.companyId" style="width: 100%">
            <el-option v-for="c in companies" :key="c.id" :label="c.code" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="账户名称" required><el-input v-model="form.name" placeholder="如：基本户 / 备用户" /></el-form-item>
        <el-form-item label="账户类型">
          <el-select v-model="form.type" style="width: 100%">
            <el-option v-for="t in ACCOUNT_TYPES" :key="t.value" :label="t.label" :value="t.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="开户机构"><el-input v-model="form.bankName" /></el-form-item>
        <el-form-item label="账号"><el-input v-model="form.accountNo" placeholder="完整账号，列表对非授权角色脱敏" /></el-form-item>
        <el-form-item label="币种">
          <el-select v-model="form.currency" style="width: 100%">
            <el-option label="人民币 CNY" value="CNY" /><el-option label="美元 USD" value="USD" />
            <el-option label="港币 HKD" value="HKD" /><el-option label="欧元 EUR" value="EUR" />
          </el-select>
        </el-form-item>
        <el-form-item label="期初余额">
          <el-input-number v-model="form.initialBalance" :precision="2" :step="1000" style="width: 100%" />
          <div class="muted" style="font-size: 12px">当前余额 = 期初余额 + 收入 − 支出，自动算出，不用手填</div>
        </el-form-item>
        <el-form-item label="期初基准日">
          <el-date-picker v-model="form.initialDate" type="date" value-format="YYYY-MM-DD" style="width: 100%"
                          placeholder="期初余额是哪一天的数" />
          <div class="muted" style="font-size: 12px">
            这一天之前的收支都已含在期初里；导入更早的流水会重复计算，导入向导会据此提醒
          </div>
        </el-form-item>
        <el-form-item label="主账户"><el-switch v-model="form.isPrimary" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="form.remark" type="textarea" :rows="2" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <!-- 内部转账 -->
    <el-dialog v-model="transferVisible" title="内部转账" width="480px">
      <el-alert type="info" :closable="false" style="margin-bottom: 14px"
                title="一次生成两条互相关联的流水（转出账户支出、转入账户收入），两边余额同时更新" />
      <el-form :model="transfer" label-width="100px">
        <el-form-item label="转出账户" required>
          <el-select v-model="transfer.fromAccountId" style="width: 100%">
            <el-option v-for="a in accounts" :key="a.id" :label="`${a.company?.code} ${a.name}（${money(a.balance)}）`" :value="a.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="转入账户" required>
          <el-select v-model="transfer.toAccountId" style="width: 100%">
            <el-option v-for="a in accounts" :key="a.id" :label="`${a.company?.code} ${a.name}`" :value="a.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="金额" required>
          <el-input-number v-model="transfer.amount" :precision="2" :min="0" :step="1000" style="width: 100%" />
        </el-form-item>
        <el-form-item label="日期">
          <el-date-picker v-model="transfer.txnDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="transfer.remark" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="transferVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="doTransfer">确认转账</el-button>
      </template>
    </el-dialog>

    <!-- 对账 -->
    <el-dialog v-model="reconcileVisible" title="账户对账" width="460px">
      <el-descriptions :column="1" border v-if="rec.account">
        <el-descriptions-item label="账户">{{ rec.account.name }}</el-descriptions-item>
        <el-descriptions-item label="期初余额"><span class="money">{{ money(rec.initialBalance) }}</span></el-descriptions-item>
        <el-descriptions-item label="流水收入合计"><span class="money money-in">+{{ money(rec.incomeTotal) }}</span></el-descriptions-item>
        <el-descriptions-item label="流水支出合计"><span class="money money-out">−{{ money(rec.expenseTotal) }}</span></el-descriptions-item>
        <el-descriptions-item label="流水推算余额"><span class="money">{{ money(rec.computedBalance) }}</span></el-descriptions-item>
        <el-descriptions-item label="账面余额"><span class="money">{{ money(rec.recordedBalance) }}</span></el-descriptions-item>
        <el-descriptions-item label="差异">
          <span class="money" :class="Math.abs(rec.diff) > 0.01 ? 'money-out' : 'money-in'">{{ money(rec.diff) }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="流水笔数">{{ rec.txnCount }}（待核对 {{ rec.unreconciledCount }}）</el-descriptions-item>
      </el-descriptions>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted, onActivated } from 'vue'
import { ElMessage } from 'element-plus'
import api from '@/api'
import { can } from '@/api/permissions'
import { companies, accounts, loadMeta } from '@/composables/useMeta'
import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABEL } from '@/constants'
import { money, date } from '@/utils/format'

const summary = ref({})
const saving = ref(false)
const formVisible = ref(false)
const transferVisible = ref(false)
const reconcileVisible = ref(false)
const form = ref({})
const rec = ref({})
const transfer = ref({ txnDate: new Date().toISOString().slice(0, 10), amount: 0 })

async function load() {
  try {
    summary.value = await api.accounts.summary()
    await loadMeta(true)
  } catch (e) {
    ElMessage.error(e.message)
  }
}

function openForm(row, company) {
  form.value = row
    ? { ...row, companyId: company?.companyId, initialBalance: Number(row.initialBalance || 0),
        initialDate: row.initialDate ? String(row.initialDate).slice(0, 10) : null }
    : { type: 'BANK', currency: 'CNY', initialBalance: 0, isPrimary: false, companyId: companies.value[0]?.id }
  formVisible.value = true
}

async function save() {
  saving.value = true
  try {
    if (form.value.id) await api.accounts.update(form.value.id, form.value)
    else await api.accounts.create(form.value)
    ElMessage.success('已保存')
    formVisible.value = false
    load()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

async function doTransfer() {
  saving.value = true
  try {
    await api.accounts.transfer(transfer.value)
    ElMessage.success('转账已登记')
    transferVisible.value = false
    load()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

async function reconcile(row) {
  try {
    rec.value = await api.accounts.reconcile(row.id)
    reconcileVisible.value = true
  } catch (e) {
    ElMessage.error(e.message)
  }
}

onActivated(() => load())
onMounted(load)
</script>

<style scoped>
.company-block {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--card-radius); margin-bottom: 14px; overflow: hidden;
}
.block-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid var(--border); background: #fcfbfa;
}
.block-head .name { font-weight: 600; }
.block-head .sum { font-size: 15px; font-weight: 600; color: var(--accent); }
</style>
