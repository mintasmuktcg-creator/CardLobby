#!/usr/bin/env node
import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import { runCollectrImport } from './collectr-importer-core.mjs'

for (const p of ['.env.scripts', '.env', '.env.local']) {
  const full = path.resolve(process.cwd(), p)
  if (fs.existsSync(full)) dotenv.config({ path: full })
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    'Set SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY (or VITE_SUPABASE_ANON_KEY).',
  )
  process.exit(1)
}

const args = process.argv.slice(2)
const getArg = (flag) => {
  const idx = args.indexOf(flag)
  if (idx === -1) return null
  return args[idx + 1] ?? null
}

const url = getArg('--url') || getArg('-u')
const includeNonEnglish = args.includes('--include-non-english')

if (!url) {
  console.error(
    'Usage: node scripts/collectr-importer.mjs --url <app.getcollectr.com/showcase/profile/...> [--include-non-english]',
  )
  process.exit(1)
}

const run = async () => {
  const { summary, results } = await runCollectrImport({
    url,
    includeNonEnglish,
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_KEY,
  })

  console.log('Collectr Importer')
  console.log(JSON.stringify(summary, null, 2))
  console.log('')
  console.table(results.slice(0, 50))
  if (results.length > 50) {
    console.log(
      `Showing 50/${results.length} rows. Add --include-non-english to disable filtering.`,
    )
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
