import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'MyKrew Spend',
        short_name: 'Spend',
        description: 'Gestion des notes de frais',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#7c3aed',
        icons: [
          { src: '/icons/icon-192-v2.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512-v2.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512-v2.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        skipWaiting: true,
        clientsClaim: true,
      },
    }),
  ],
})