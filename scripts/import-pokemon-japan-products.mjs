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

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const CATEGORY_ID = 85 // TCGplayer Pokemon Japan category id
const TCG_TYPE_NAME = 'Pokemon Japan'

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

async function fetchCsv(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed ${url}: ${res.status}`)
  const text = await res.text()
  return Papa.parse(text, { header: true, skipEmptyLines: true, dynamicTyping: true }).data
}

async function upsert(table, rows, onConflict) {
  const chunks = chunk(rows, 300)
  for (let i = 0; i < chunks.length; i++) {
    const { error } = await supabase.from(table).upsert(chunks[i], { onConflict })
    if (error) throw error
  }
}

function parseCardNumber(extNumber) {
  if (extNumber === undefined || extNumber === null) return null
  if (typeof extNumber === 'number' && Number.isFinite(extNumber)) return extNumber
  if (typeof extNumber === 'string') {
    const m1 = extNumber.match(/(\d{1,4})\s*\/\s*(\d{1,4})/)
    if (m1) return Number(m1[1])
    const m2 = extNumber.match(/^\s*(\d{1,4})\s*$/)
    if (m2) return Number(m2[1])
    const m3 = extNumber.match(/(\d{1,4})/)
    if (m3) return Number(m3[1])
  }
  return null
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}

function toIso(value) {
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return new Date().toISOString()
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

async function run() {
  console.log('Fetching groups for Pokemon Japan...')
  const groupsJson = await fetchJson(`https://tcgcsv.com/tcgplayer/${CATEGORY_ID}/groups`)
  const groups = groupsJson.results || []
  console.log(`Found ${groups.length} groups`)

  await upsert('tcg_types', [{ name: TCG_TYPE_NAME }], 'name')
  const { data: typeRow, error: typeErr } = await supabase
    .from('tcg_types')
    .select('id')
    .eq('name', TCG_TYPE_NAME)
    .single()
  if (typeErr) throw typeErr
  const tcgTypeId = typeRow.id

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

  for (const group of groups) {
    try {
      const setName = group.name
      const groupId = group.groupId
      const abbreviation = typeof group.abbreviation === 'string' ? group.abbreviation.trim() : group.abbreviation
      const existing = existingByName.get(setName)
      let setCode = existing?.code ? String(existing.code).trim() : ''
      const abbrKey = abbreviation ? String(abbreviation).trim().toUpperCase() : ''
      const hasDuplicateAbbr = abbrKey ? (abbreviationCounts.get(abbrKey) ?? 0) > 1 : false
      const shouldUseAbbr = Boolean(abbreviation && abbreviation.length > 0 && !hasDuplicateAbbr)

      if (!setCode) {
        const candidate = shouldUseAbbr ? abbreviation : String(groupId)
        let next = String(candidate).trim()
        let nextKey = next.toUpperCase()
        if (!next) {
          next = String(groupId)
          nextKey = next.toUpperCase()
        }
        if (usedCodes.has(nextKey)) {
          next = String(groupId)
          nextKey = next.toUpperCase()
        }
        if (usedCodes.has(nextKey)) {
          next = `${groupId}-${group.categoryId ?? CATEGORY_ID}`
          nextKey = next.toUpperCase()
        }
        setCode = next
      }

      if (setCode) usedCodes.add(String(setCode).trim().toUpperCase())

      console.log(`\nProcessing set ${setName} (${groupId})`)

      const { data: setData, error: setErr } = await supabase
        .from('pokemon_japan_sets')
        .upsert(
          {
            name: setName,
            code: setCode,
            abbreviation: abbreviation || null,
            is_supplemental: toBool(group.isSupplemental),
            published_on: group.publishedOn || null,
            modified_on: group.modifiedOn || null,
            tcg_type_id: tcgTypeId,
            tcg_group_id: groupId,
            tcg_category_id: CATEGORY_ID,
          },
          { onConflict: 'tcg_type_id,name' },
        )
        .select('id')
        .single()
      if (setErr) throw setErr
      const setId = setData.id

      const csvUrl = `https://tcgcsv.com/tcgplayer/${CATEGORY_ID}/${groupId}/ProductsAndPrices.csv`
      let rows
      try {
        rows = await fetchCsv(csvUrl)
      } catch (err) {
        console.error(`  Skipping ${setName}: ${err.message}`)
        continue
      }
      if (!rows.length) {
        console.log('  No rows, skipping')
        continue
      }

      const productMap = new Map()
      rows.forEach((row) => {
        if (!row.productId) return
        const capturedAt = toIso(row.modifiedOn)
        const capturedTime = Date.parse(capturedAt)

        const baseRow = {
          tcg_product_id: row.productId,
          name: row.name,
          clean_name: row.cleanName,
          product_type: parseCardNumber(row.extNumber) === null ? 'sealed' : 'single',
          subtype: row.subTypeName,
          card_number: row.extNumber,
          rarity: row.extRarity,
          card_type: row.extCardType,
          hp: row.extHP,
          stage: row.extStage,
          attack1: row.extAttack1,
          attack2: row.extAttack2,
          weakness: row.extWeakness,
          resistance: row.extResistance,
          retreat_cost: row.extRetreatCost,
          image_url: row.imageUrl,
          image_count: row.imageCount,
          external_url: row.url,
          modified_on: row.modifiedOn || null,
          set_id: setId,
        }

        const priceRow = {
          low_price: toNumber(row.lowPrice),
          mid_price: toNumber(row.midPrice),
          high_price: toNumber(row.highPrice),
          market_price: toNumber(row.marketPrice),
          direct_low_price: toNumber(row.directLowPrice),
          currency: 'USD',
          price_updated_at: capturedAt,
          modified_on: capturedAt,
        }

        const existingProduct = productMap.get(row.productId)
        if (!existingProduct) {
          productMap.set(row.productId, {
            row: { ...baseRow, ...priceRow },
            priceUpdatedAt: Number.isFinite(capturedTime) ? capturedTime : 0,
          })
          return
        }

        const nextRow = { ...existingProduct.row, ...baseRow }
        const nextTime = Number.isFinite(capturedTime) ? capturedTime : existingProduct.priceUpdatedAt
        if (nextTime >= existingProduct.priceUpdatedAt) {
          Object.assign(nextRow, priceRow)
          existingProduct.priceUpdatedAt = nextTime
        }
        existingProduct.row = nextRow
      })

      const products = Array.from(productMap.values()).map((entry) => entry.row)
      await upsert('pokemon_japan_products', products, 'tcg_product_id')

      console.log(`  Imported ${products.length} products`)
    } catch (err) {
      console.error(`  Error processing group ${group.groupId}: ${err.message} — skipping`)
      continue
    }
  }

  console.log('\nDone.')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
