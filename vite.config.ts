import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5173,
    host: true
  },
  build: {
    outDir: '../dist/public',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        client: 'public/client.html',
        server: 'public/server.html'
      }
    }
  },
  publicDir: false
})