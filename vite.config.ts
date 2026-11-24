/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

const rawBase = process.env.VITE_BASE_PATH?.trim() || '/'
const basePath = rawBase.endsWith('/') ? rawBase : `${rawBase}/`

export default defineConfig({
  base: basePath,
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'ClearBill 清帳',
        short_name: 'ClearBill',
        description: 'Local-First 旅遊分帳與極簡日常記帳工具',
        theme_color: '#0f172a',
        background_color: '#f8fafc',
        display: 'standalone',
        scope: basePath,
        start_url: basePath,
        icons: [
          {
            src: 'favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
        // Web Share Target：接收系統分享的刷卡通知、訂單連結或文字
        share_target: {
          action: `${basePath}#/quick-add`,
          method: 'GET',
          params: {
            title: 'merchant',
            text: 'rawText',
            url: 'sourceUrl',
          },
        },
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json}'],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
