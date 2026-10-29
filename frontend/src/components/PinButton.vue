<!-- 行内「@」：把这条记录推进录入助手的上下文（按 type:id 去重） -->
<template>
  <el-tooltip :content="pinned ? '已引用到录入助手' : '@ 引用到录入助手'" placement="top" :show-after="400" :disabled="isMobile">
    <el-button link :type="pinned ? 'warning' : 'info'" class="pin-btn" :aria-label="pinned ? '已引用到录入助手' : '引用到录入助手'"
               @click.stop="onPin">@</el-button>
  </el-tooltip>
</template>

<script setup>
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { useAssistantStore } from '@/stores/assistant'
import { useViewport } from '@/composables/useViewport'

const props = defineProps({ type: { type: String, required: true }, id: { type: [String, Number], required: true }, label: String })
const store = useAssistantStore()
const pinned = computed(() => store.isPinned(props.type, props.id))
const { isMobile } = useViewport()

// 手机上助手是收起的全屏 sheet，引用后给个提示，否则看不到发生了什么
function onPin() {
  const was = pinned.value
  store.pin(props.type, props.id, props.label)
  if (isMobile.value && !was) ElMessage.success({ message: '已引用到录入助手（头像菜单 → 录入助手）', grouping: true })
}
</script>

<style scoped>
.pin-btn { font-weight: 700; font-family: var(--font-num); }
/* 手机卡片的操作区里：≥44px 的独立按钮，已引用时高亮 */
@media (max-width: 768px) {
  .pin-btn { min-width: 44px; min-height: 44px; font-size: 16px; }
}
</style>
