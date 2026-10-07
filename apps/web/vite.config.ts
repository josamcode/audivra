import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ mode }) => {
  // Ports come from the repository-level .env so web, server and worker agree.
  const env = { ...loadEnv(mode, path.resolve(root, '../..'), ''), ...process.env }
  const webPort = Number(env.WEB_PORT ?? 4300)
  const serverPort = Number(env.SERVER_PORT ?? 4310)

  return {
    plugins: [
      tanstackRouter({ target: 'react', autoCodeSplitting: true, quoteStyle: 'single', semicolons: false }),
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: { '@': path.resolve(root, 'src') },
    },
    server: {
      host: '127.0.0.1',
      port: webPort,
      strictPort: true,
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${serverPort}`,
          changeOrigin: false,
          // Keep SSE responses streaming instead of buffered.
          configure: (proxy) => {
            proxy.on('proxyRes', (proxyRes) => {
              if (String(proxyRes.headers['content-type'] ?? '').includes('text/event-stream')) {
                proxyRes.headers['cache-control'] = 'no-cache, no-transform'
              }
            })
          },
        },
      },
    },
    preview: {
      host: '127.0.0.1',
      port: webPort,
      strictPort: true,
      proxy: { '/api': { target: `http://127.0.0.1:${serverPort}` } },
    },
    build: {
      chunkSizeWarningLimit: 900,
    },
  }
})
