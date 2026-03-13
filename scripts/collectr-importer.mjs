#!/usr/bin/env node
import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import { runCollectrImport } from './collectr-importer-core.mjs'

for (const p of ['.env.scripts', '.env', '.env.local']) {
  const full = path.resolve(process.cwd(), p)
  if (fs.existsSync(full)) dotenv.config({ path: full })
}

const CARDHQ_API_BASE_URL = String(
  process.env.CARDHQ_API_BASE_URL || 'https://api.cardlobby.app',
)
  .trim()
  .replace(/\/+$/, '')
const CARDHQ_API_KEY = String(
  process.env.CARDHQ_API_KEY || process.env.CARDHQ_ADMIN_API_KEY || '',
).trim()

if (!CARDHQ_API_KEY) {
  console.error('Set CARDHQ_API_KEY (or CARDHQ_ADMIN_API_KEY) before running importer.')
  process.exit(1)
}

const args = process.argv.slice(2)
const getArg = (flag) => {
  const idx = args.indexOf(flag)
  if (idx === -1) return null
  return args[idx + 1] ?? null
}

const url = getArg('--url') || getArg('-u')
if (!url) {
  console.error(
    'Usage: node scripts/collectr-importer.mjs --url <app.getcollectr.com/showcase/profile/...>',
  )
  process.exit(1)
}

const run = async () => {
  const { summary, results } = await runCollectrImport({
    url,
    cardhqBaseUrl: CARDHQ_API_BASE_URL,
    cardhqApiKey: CARDHQ_API_KEY,
  })

  console.log('Collectr Importer')
  console.log(JSON.stringify(summary, null, 2))
  console.log('')
  console.table(results.slice(0, 50))
  if (results.length > 50) {
    console.log(`Showing 50/${results.length} rows.`)
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
