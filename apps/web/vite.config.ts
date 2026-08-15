import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5173,
    // content/ lives at the repo root, OUTSIDE this Vite root, and
    // packages/content's static JSON imports reach it. Without this the dev
    // server refuses to serve them and every track fails to load.
    fs: { allow: ['../..'] },
  },
})
