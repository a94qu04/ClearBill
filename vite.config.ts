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
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'ClearBill 清帳',
        short_name: 'ClearBill',
        description: 'Local-First 旅遊分帳與多人即時協作清帳工具',
        theme_color: '#0f172a',
        background_color: '#f8fafc',
        display: 'standalone',
        scope: basePath,
        start_url: basePath,
        icons: [
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: 'favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
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
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/firebase') || id.includes('node_modules/@firebase')) {
            return 'firebase-vendor'
          }
          if (id.includes('node_modules/lucide-vue-next')) {
            return 'icons-vendor'
          }
          if (id.includes('node_modules/dexie')) {
            return 'dexie-vendor'
          }
          if (
            id.includes('node_modules/vue') ||
            id.includes('node_modules/@vue') ||
            id.includes('node_modules/pinia') ||
            id.includes('node_modules/vue-i18n') ||
            id.includes('node_modules/@intlify')
          ) {
            return 'vue-vendor'
          }
          if (id.includes('node_modules/zod')) {
            return 'zod-vendor'
          }
          return undefined
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
