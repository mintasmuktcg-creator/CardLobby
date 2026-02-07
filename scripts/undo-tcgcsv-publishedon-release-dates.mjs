#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'

const CATEGORY_ID = 3 // Pokemon

for (const p of ['.env.scripts', '.env', '.env.local']) {
  const full = path.resolve(process.cwd(), p)
  if (fs.existsSync(full)) dotenv.config({ path: full })
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing env. Set SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed ${url}: ${res.status}`)
  return res.json()
}

function toDateOnly(isoLike) {
  if (!isoLike || typeof isoLike !== 'string') return null
  const d = isoLike.split('T')[0]
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null
}

const chunk = (arr, size) => {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function run() {
  console.log('Fetching Pokemon groups...')
  const groupsJson = await fetchJson(`https://tcgcsv.com/tcgplayer/${CATEGORY_ID}/groups`)
  const groups = groupsJson.results || []
  console.log(`Found ${groups.length} groups`)

  const target = []
  for (const g of groups) {
    const groupId = g.groupId
    const publishedDate = toDateOnly(g.publishedOn)
    if (!groupId || !publishedDate) continue
    target.push({ groupId, publishedDate })
  }

  let cleared = 0
  for (const groupChunk of chunk(target, 75)) {
    // Clear only rows we previously set: (tcg_group_id matches AND release_date equals publishedOn date)
    for (const g of groupChunk) {
      const { data, error } = await supabase
        .from('card_sets')
        .update({ release_date: null })
        .eq('tcg_group_id', g.groupId)
        .eq('release_date', g.publishedDate)
        .select('id')
      if (error) throw error
      cleared += data?.length ?? 0
    }
  }

  console.log(`Done. Cleared release_date on ${cleared} set rows (where it matched TCGCSV publishedOn).`)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})

