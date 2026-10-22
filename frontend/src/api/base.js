// 部署在以虎 One 上时页面挂在 /apps/<code>/ 下：后端给 index.html 注入了 <base href="/apps/<code>/">
// 接口、路由、跳转都从这里拼前缀；本地开发（vite）没有 <base>，前缀为空串
export const BASE = (document.querySelector('base')?.getAttribute('href') || '/').replace(/\/$/, '')

// 平台工作台地址：统一登录进来时记下，退出后回到这里
const HOME_KEY = 'fin_platform_home'
export const getPlatformHome = () => localStorage.getItem(HOME_KEY) || ''
export const setPlatformHome = (url) => (url ? localStorage.setItem(HOME_KEY, url) : localStorage.removeItem(HOME_KEY))
