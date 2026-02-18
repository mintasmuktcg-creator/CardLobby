import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import type { ServerResponse } from 'node:http'
import { runCollectrImport } from './scripts/collectr-importer-core.mjs'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'collectr-importer-dev',
      configureServer(server) {
        for (const p of ['.env.scripts', '.env', '.env.local']) {
          const full = path.resolve(process.cwd(), p)
          if (fs.existsSync(full)) dotenv.config({ path: full, override: true })
        }

        const sendJson = (res: ServerResponse, status: number, payload: unknown) => {
          res.statusCode = status
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.end(JSON.stringify(payload))
        }

        const formatError = (err: unknown) => {
          if (err === null || err === undefined) return 'Unknown error'
          if (typeof err === 'string') return err
          if (typeof err === 'object') {
            const maybeCause = (err as { cause?: unknown }).cause
            if (maybeCause) {
              if (typeof maybeCause === 'string') return maybeCause
              if (typeof maybeCause === 'object') {
                const causeMessage = (maybeCause as { message?: unknown }).message
                const causeCode = (maybeCause as { code?: unknown }).code
                if (typeof causeMessage === 'string' && causeMessage.trim().length > 0) {
                  return causeCode
                    ? `${causeMessage} (${String(causeCode)})`
                    : causeMessage
                }
                if (typeof causeCode === 'string' || typeof causeCode === 'number') {
                  return `Request failed (${String(causeCode)})`
                }
              }
            }
            if (err instanceof Error && err.message) return err.message
            const maybeMessage = (err as { message?: unknown }).message
            if (typeof maybeMessage === 'string' && maybeMessage.trim().length > 0) {
              return maybeMessage
            }
            const maybeError = (err as { error?: unknown }).error
            if (typeof maybeError === 'string' && maybeError.trim().length > 0) {
              return maybeError
            }
            try {
              return JSON.stringify(err, Object.getOwnPropertyNames(err))
            } catch {
              return String(err)
            }
          }
          return String(err)
        }

        server.middlewares.use('/api/collectr-importer', async (req, res) => {
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'Method not allowed' })
            return
          }

          const reqUrl = new URL(req.url || '', 'http://localhost')
          const rawUrl = reqUrl.searchParams.get('url')
          const urlParam = rawUrl?.trim().replace(/\\+$/, '') || ''
          if (!urlParam) {
            sendJson(res, 400, { error: 'Missing Collectr URL.' })
            return
          }

          const supabaseUrl =
            process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
          const supabaseKey =
            process.env.SUPABASE_SERVICE_ROLE_KEY ||
            process.env.SUPABASE_ANON_KEY ||
            process.env.VITE_SUPABASE_ANON_KEY

          if (!supabaseUrl || !supabaseKey) {
            sendJson(res, 500, { error: 'Supabase env vars are missing.' })
            return
          }

          try {
            const payload = await runCollectrImport({
              url: urlParam,
              supabaseUrl,
              supabaseKey,
            })
            sendJson(res, 200, payload)
          } catch (err) {
            const message = formatError(err)
            console.error('Collectr import error:', err)
            const isBadRequest =
              /invalid collectr url|missing collectr url|app.getcollectr.com/i.test(
                message,
              )
            sendJson(res, isBadRequest ? 400 : 500, { error: message })
          }
        })
      },
    },
  ],
})
