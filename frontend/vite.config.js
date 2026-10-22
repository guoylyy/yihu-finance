import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  // 相对路径：挂在以虎 One 的 /apps/<code>/ 下也能加载资源（配合后端注入的 <base href>）
  base: './',
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
  },
  server: {
    port: 5183,
    proxy: {
      '/api': { target: 'http://localhost:3010', changeOrigin: true }
    }
  }
})
