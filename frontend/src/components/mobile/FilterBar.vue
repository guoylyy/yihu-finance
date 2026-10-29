<!--
  筛选条：桌面就是原来的 <div class="filter-bar">；手机端收成「筛选」按钮 + 底部 sheet，不占首屏
  #bar 插槽的内容在手机端常驻按钮左侧（比如关键字搜索），#default 进 sheet
-->
<template>
  <div v-if="!isMobile" class="filter-bar">
    <slot name="bar" />
    <slot />
  </div>
  <template v-else>
    <div class="m-filter-row">
      <div class="m-filter-bar-slot"><slot name="bar" /></div>
      <el-badge :value="active || ''" :hidden="!active" class="m-filter-badge">
        <el-button class="m-filter-btn" @click="open = true">
          <el-icon><Filter /></el-icon><span>筛选</span>
        </el-button>
      </el-badge>
    </div>
    <el-drawer v-model="open" direction="btt" :with-header="false" class="m-sheet" append-to-body>
      <div class="m-sheet-handle" />
      <div class="m-sheet-title">
        <span>{{ title }}</span>
        <el-button text circle aria-label="关闭" @click="open = false"><el-icon><Close /></el-icon></el-button>
      </div>
      <div class="m-sheet-body"><slot /></div>
      <div class="m-sheet-foot">
        <el-button type="primary" @click="done">完成</el-button>
      </div>
    </el-drawer>
  </template>
</template>

<script setup>
import { ref } from 'vue'
import { useViewport } from '@/composables/useViewport'

defineProps({
  title: { type: String, default: '筛选条件' },
  // 已生效的筛选项数量，显示在按钮角标上
  active: { type: Number, default: 0 }
})
const emit = defineEmits(['done'])
const { isMobile } = useViewport()
const open = ref(false)
function done() { open.value = false; emit('done') }
</script>
