<!-- 行内「@」：把这条记录推进录入助手的上下文（按 type:id 去重） -->
<template>
  <el-tooltip :content="pinned ? '已引用到录入助手' : '@ 引用到录入助手'" placement="top" :show-after="400">
    <el-button link :type="pinned ? 'warning' : 'info'" class="pin-btn" @click.stop="store.pin(type, id, label)">@</el-button>
  </el-tooltip>
</template>

<script setup>
import { computed } from 'vue'
import { useAssistantStore } from '@/stores/assistant'

const props = defineProps({ type: { type: String, required: true }, id: { type: [String, Number], required: true }, label: String })
const store = useAssistantStore()
const pinned = computed(() => store.isPinned(props.type, props.id))
</script>

<style scoped>
.pin-btn { font-weight: 700; font-family: var(--font-num); }
</style>
