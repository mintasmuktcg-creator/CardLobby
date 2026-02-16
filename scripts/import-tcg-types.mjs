#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'

for (const p of ['.env.scripts', '.env', '.env.local']) {
  const full = path.resolve(process.cwd(), p)
  if (fs.existsSync(full)) dotenv.config({ path: full, override: true })
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Set SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY before running.')
  process.exit(1)
}

const args = process.argv.slice(2)
const getArg = (flag) => {
  const idx = args.indexOf(flag)
  if (idx === -1) return null
  return args[idx + 1] ?? null
}

const limitArg = getArg('--limit')
const limit = limitArg ? Number(limitArg) : null
const dryRun = args.includes('--dry-run')

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
const CATEGORIES_URL = 'https://tcgcsv.com/tcgplayer/categories'

const chunk = (arr, size) => {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed ${url}: ${res.status}`)
  return res.json()
}

function normalizeName(value) {
  if (!value) return ''
  let out = String(value)
  out = out.replace(/Ã©/g, 'e')
  out = out.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  out = out.toLowerCase()
  out = out.replace(/[^a-z0-9]/g, '')
  return out
}

function slugify(value) {
  if (!value) return null
  const slug = String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || null
}

function extractAbbreviation(value) {
  if (!value) return null
  const match = String(value).match(/\(([A-Za-z0-9+&.-]{2,})\)\s*$/)
  return match ? match[1].trim() : null
}

function pickCategoryName(category) {
  if (category?.categoryId === 3) return 'Pokemon TCG'
  return category?.displayName || category?.name || `TCG Category ${category?.categoryId ?? 'Unknown'}`
}

async function upsert(table, rows, onConflict) {
  const chunks = chunk(rows, 200)
  for (const group of chunks) {
    const { error } = await supabase.from(table).upsert(group, { onConflict })
    if (error) throw error
  }
}

async function run() {
  console.log('Fetching TCG categories...')
  const json = await fetchJson(CATEGORIES_URL)
  const categories = Array.isArray(json?.results) ? json.results : []

  if (!categories.length) {
    console.error('No categories returned from tcgcsv.')
    process.exit(1)
  }

  const { data: existingTypes, error: existingError } = await supabase
    .from('tcg_types')
    .select('id, name')
  if (existingError) throw existingError

  const existingByNormalized = new Map()
  for (const row of existingTypes || []) {
    const key = normalizeName(row.name)
    if (key) existingByNormalized.set(key, row)
  }

  const findExisting = (normalized) => {
    if (!normalized) return null
    const direct = existingByNormalized.get(normalized)
    if (direct) return direct
    for (const [key, row] of existingByNormalized) {
      if (key.includes(normalized) || normalized.includes(key)) return row
    }
    return null
  }

  const list = Number.isFinite(limit) ? categories.slice(0, limit) : categories
  const rows = list.map((category) => {
    const baseName = pickCategoryName(category)
    const normalized = normalizeName(baseName)
    const existing = findExisting(normalized)
    const name = existing?.name ?? baseName
    const slugSource = category?.seoCategoryName || baseName
    const abbreviation = extractAbbreviation(category?.seoCategoryName)

    return {
      name,
      slug: slugify(slugSource),
      abbreviation,
      publisher: null,
      description: category?.categoryDescription || null,
      official_url: category?.conditionGuideUrl || null,
      icon_url: null,
      logo_url: null,
    }
  })

  if (dryRun) {
    console.log(`Dry run: ${rows.length} categories ready to upsert.`)
    console.log(rows.slice(0, 5))
    return
  }

  console.log(`Upserting ${rows.length} categories into tcg_types...`)
  await upsert('tcg_types', rows, 'name')
  console.log('Done.')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
