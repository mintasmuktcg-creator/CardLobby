#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import Papa from 'papaparse'
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

const CATEGORY_ID = 85 // TCGplayer Pokemon Japan category id
const GROUPS_CSV_URL = `https://tcgcsv.com/tcgplayer/${CATEGORY_ID}/Groups.csv`
const DEFAULT_TCG_TYPE_NAME = 'Pokemon Japan'

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const chunk = (arr, size) => {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function fetchCsv(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`Failed ${url}: ${res.status}`)
  const text = await res.text()
  return Papa.parse(text, { header: true, skipEmptyLines: true, dynamicTyping: true }).data
}

function toIso(value) {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString()
}

function toBool(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return null
}

function isPokemonJapan(row) {
  const name = String(row?.name || '')
  const slug = String(row?.slug || '')
  return /pokemon/i.test(name) && /japan/i.test(name || slug)
}

async function resolveTcgTypeId() {
  const { data, error } = await supabase.from('tcg_types').select('id,name,slug')
  if (error) throw error
  const match = (data || []).find((row) => isPokemonJapan(row))
  if (match?.id) return match.id

  const { data: created, error: createError } = await supabase
    .from('tcg_types')
    .upsert({ name: DEFAULT_TCG_TYPE_NAME }, { onConflict: 'name' })
    .select('id')
    .single()
  if (createError) throw createError
  return created.id
}

async function upsert(table, rows, onConflict) {
  const chunks = chunk(rows, 250)
  for (const group of chunks) {
    const { error } = await supabase.from(table).upsert(group, { onConflict })
    if (error) throw error
  }
}

async function run() {
  console.log('Fetching Pokemon Japan group CSV...')
  const rows = await fetchCsv(GROUPS_CSV_URL)
  const groups = (rows || []).filter((row) => row && row.groupId)
  if (!groups.length) {
    console.error('No groups found in CSV.')
    process.exit(1)
  }

  const tcgTypeId = await resolveTcgTypeId()

  const { data: existingSets, error: existingError } = await supabase
    .from('pokemon_japan_sets')
    .select('id, name, code, tcg_group_id')
    .eq('tcg_type_id', tcgTypeId)
  if (existingError) throw existingError

  const existingByName = new Map()
  const usedCodes = new Set()
  for (const row of existingSets || []) {
    if (row?.name) existingByName.set(row.name, row)
    if (row?.code) usedCodes.add(String(row.code).trim().toUpperCase())
  }

  const abbreviationCounts = new Map()
  for (const row of groups) {
    const abbr = typeof row.abbreviation === 'string' ? row.abbreviation.trim() : row.abbreviation
    if (!abbr) continue
    const key = String(abbr).trim().toUpperCase()
    if (!key) continue
    abbreviationCounts.set(key, (abbreviationCounts.get(key) ?? 0) + 1)
  }

  const list = Number.isFinite(limit) ? groups.slice(0, limit) : groups
  const setRows = list.map((row) => {
    const abbreviation = typeof row.abbreviation === 'string' ? row.abbreviation.trim() : row.abbreviation
    const existing = existingByName.get(row.name)
    let code = existing?.code ? String(existing.code).trim() : ''
    const abbrKey = abbreviation ? String(abbreviation).trim().toUpperCase() : ''
    const hasDuplicateAbbr = abbrKey ? (abbreviationCounts.get(abbrKey) ?? 0) > 1 : false
    const shouldUseAbbr = Boolean(abbreviation && abbreviation.length > 0 && !hasDuplicateAbbr)

    if (!code) {
      const candidate = shouldUseAbbr ? abbreviation : String(row.groupId)
      let next = String(candidate).trim()
      let nextKey = next.toUpperCase()
      if (!next) {
        next = String(row.groupId)
        nextKey = next.toUpperCase()
      }
      if (usedCodes.has(nextKey)) {
        next = String(row.groupId)
        nextKey = next.toUpperCase()
      }
      if (usedCodes.has(nextKey)) {
        next = `${row.groupId}-${row.categoryId ?? CATEGORY_ID}`
        nextKey = next.toUpperCase()
      }
      code = next
    }

    if (code) usedCodes.add(String(code).trim().toUpperCase())

    return {
      name: row.name,
      code,
      abbreviation: abbreviation || null,
      is_supplemental: toBool(row.isSupplemental),
      published_on: toIso(row.publishedOn),
      modified_on: toIso(row.modifiedOn),
      tcg_type_id: tcgTypeId,
      tcg_group_id: row.groupId,
      tcg_category_id: row.categoryId ?? CATEGORY_ID,
    }
  })

  if (dryRun) {
    console.log(`Dry run: ${setRows.length} groups ready to upsert.`)
    console.log(setRows.slice(0, 5))
    return
  }

  console.log(`Upserting ${setRows.length} sets into pokemon_japan_sets...`)
  await upsert('pokemon_japan_sets', setRows, 'tcg_type_id,name')
  console.log('Done.')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
