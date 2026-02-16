#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'

const WIKI_RAW_URL =
  'https://en.wikipedia.org/w/index.php?title=List_of_Pok%C3%A9mon_Trading_Card_Game_sets&action=raw'

// TCGCSV's Pokemon category id.
const POKEMON_TCG_CATEGORY_ID = 3

for (const p of ['.env.scripts', '.env', '.env.local']) {
  const full = path.resolve(process.cwd(), p)
  if (fs.existsSync(full)) dotenv.config({ path: full, override: true })
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    'Missing env. Set SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.',
  )
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function fetchText(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed ${url}: ${res.status}`)
  return res.text()
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replaceAll('pokémon', 'pokemon')
    .replaceAll('&', 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function keyVariants(name) {
  const norm = normalizeName(name)
  const out = new Set()
  if (norm) out.add(norm)
  if (norm.startsWith('pokemon ')) out.add(norm.replace(/^pokemon\s+/, ''))
  return Array.from(out)
}

function generationFromHeading(text) {
  const t = text.toLowerCase()
  if (t.includes('first generation')) return 1
  if (t.includes('second generation')) return 2
  if (t.includes('third generation')) return 3
  if (t.includes('fourth generation')) return 4
  if (t.includes('fifth generation')) return 5
  if (t.includes('sixth generation')) return 6
  if (t.includes('seventh generation')) return 7
  if (t.includes('eighth generation')) return 8
  if (t.includes('ninth generation')) return 9
  return null
}

function parseWikiGenerationMap(wikitext) {
  // The page uses sections like:
  //   == First generation sets ==
  // and set headings like:
  //   === Jungle ===
  // Later generations use wikitables; we also parse those.
  // We'll map setName -> generation.
  const map = new Map()
  let currentGen = null

  const cleanWikiText = (value) => {
    if (value === null || value === undefined) return ''
    let s = String(value)
    // Strip references.
    s = s.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    s = s.replace(/<ref[^\/]*\/>/gi, '')
    // Strip templates (simple, non-nested).
    s = s.replace(/\{\{[^{}]*\}\}/g, '')
    // Convert wiki links to display text.
    s = s.replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, '$2')
    s = s.replace(/\[\[([^\]]+)\]\]/g, '$1')
    // Strip formatting.
    s = s.replace(/''+/g, '')
    // Collapse whitespace.
    s = s.replace(/\s+/g, ' ').trim()
    return s
  }

  const lines = wikitext.split(/\r?\n/)

  let inTable = false
  let tableNameColIndex = null
  let rowCells = []

  const finalizeRow = () => {
    if (!currentGen || tableNameColIndex === null) return
    if (rowCells.length <= tableNameColIndex) return
    const rawName = cleanWikiText(rowCells[tableNameColIndex])
    if (!rawName) return
    for (const key of keyVariants(rawName)) {
      if (!key) continue
      if (!map.has(key)) map.set(key, currentGen)
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()

    const genMatch = line.match(/^==\s*(.+?)\s*==$/)
    if (genMatch) {
      currentGen = generationFromHeading(genMatch[1])
      // Reset table parsing state when we change major sections.
      inTable = false
      tableNameColIndex = null
      rowCells = []
      continue
    }

    // Only collect set headings when we know which generation we're in.
    if (!currentGen) continue

    // Table parsing for later generations.
    if (line.startsWith('{|')) {
      inTable = true
      tableNameColIndex = null
      rowCells = []
      continue
    }
    if (inTable && line.startsWith('|}')) {
      finalizeRow()
      inTable = false
      tableNameColIndex = null
      rowCells = []
      continue
    }
    if (inTable) {
      if (line.startsWith('!')) {
        // Header row, find the "Name" column index.
        // Example: ! Generation Set No. !! Name !! Release date !! Details
        const headerLine = line.replace(/^!+/, '').trim()
        const headers = headerLine.split('!!').map((h) => cleanWikiText(h).toLowerCase())
        const idx = headers.findIndex((h) => h === 'name' || h.endsWith(' name') || h.includes('english name'))
        if (idx !== -1) tableNameColIndex = idx
        continue
      }
      if (line.startsWith('|-')) {
        // Row separator. Finalize the previous row and start a new one.
        finalizeRow()
        rowCells = []
        continue
      }
      if (line.startsWith('|')) {
        // Cell(s). Could be a single cell, or multiple separated by '||'.
        const cellLine = line.replace(/^\|+/, '').trim()
        const parts = cellLine.split('||').map((p) => p.trim())
        rowCells.push(...parts)
        continue
      }
    }

    const setMatch = line.match(/^===\s*(.+?)\s*===$/)
    if (!setMatch) continue

    const setName = setMatch[1]
      .replace(/\s+/g, ' ')
      .replace(/''+/g, '') // strip italics markup
      .trim()

    for (const key of keyVariants(setName)) {
      if (!key) continue
      if (!map.has(key)) map.set(key, currentGen)
    }
  }

  // Final row if file ended mid-table.
  if (inTable) finalizeRow()

  return map
}

const chunk = (arr, size) => {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function run() {
  console.log('Downloading Wikipedia list of Pokemon TCG sets (wikitext)...')
  const wikitext = await fetchText(WIKI_RAW_URL)
  const genMap = parseWikiGenerationMap(wikitext)
  console.log(`Parsed ${genMap.size} set headings from Wikipedia.`)

  console.log('Loading pokemon_sets from Supabase...')
  const { data: sets, error: setsErr } = await supabase
    .from('pokemon_sets')
    .select('id, name, tcg_category_id')
    .eq('tcg_category_id', POKEMON_TCG_CATEGORY_ID)
  if (setsErr) throw setsErr

  if (!sets || sets.length === 0) {
    console.log('No Pokemon sets found in pokemon_sets (tcg_category_id = 3).')
    return
  }

  const idByGen = new Map()
  const unmatched = []

  for (const s of sets) {
    const key = normalizeName(s.name)
    const gen = genMap.get(key) ?? null
    if (!gen) {
      unmatched.push(s.name)
      continue
    }
    if (!idByGen.has(gen)) idByGen.set(gen, [])
    idByGen.get(gen).push(s.id)
  }

  let updated = 0
  for (const [gen, ids] of Array.from(idByGen.entries()).sort((a, b) => a[0] - b[0])) {
    for (const idsChunk of chunk(ids, 200)) {
      const { data, error } = await supabase
        .from('pokemon_sets')
        .update({ generation: gen })
        .in('id', idsChunk)
        .select('id')
      if (error) throw error
      updated += data?.length ?? 0
    }
    console.log(`Set generation=${gen} for ${ids.length} sets`)
  }

  console.log(`Done. Updated generation on ${updated}/${sets.length} Pokemon sets.`)
  if (unmatched.length) {
    console.log(`Unmatched set names (${unmatched.length}). Sample:`)
    unmatched.slice(0, 25).forEach((n) => console.log(`  - ${n}`))
    if (unmatched.length > 25) console.log('  ...')
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
