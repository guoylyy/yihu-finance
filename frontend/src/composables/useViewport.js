// 断点：手机 ≤768 / 平板 769–1024 / 桌面 >1024，与 assets/mobile.css 的 @media 保持一致
// 全局单例：matchMedia 只建一次，任何组件里 const { isMobile } = useViewport() 都是同一份响应式状态
import { ref, readonly } from 'vue'

export const MOBILE_MAX = 768
export const TABLET_MAX = 1024

const mqMobile = window.matchMedia(`(max-width: ${MOBILE_MAX}px)`)
const mqTablet = window.matchMedia(`(min-width: ${MOBILE_MAX + 1}px) and (max-width: ${TABLET_MAX}px)`)

const isMobile = ref(mqMobile.matches)
const isTablet = ref(mqTablet.matches)
const isDesktop = ref(!mqMobile.matches && !mqTablet.matches)

function sync() {
  isMobile.value = mqMobile.matches
  isTablet.value = mqTablet.matches
  isDesktop.value = !mqMobile.matches && !mqTablet.matches
}
mqMobile.addEventListener('change', sync)
mqTablet.addEventListener('change', sync)

const state = { isMobile: readonly(isMobile), isTablet: readonly(isTablet), isDesktop: readonly(isDesktop) }

export function useViewport() {
  return state
}
