#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import Papa from 'papaparse'
import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'

// Load env from common files if present so you can run:
//   node scripts/import-pokemon.mjs
for (const p of ['.env.scripts', '.env', '.env.local']) {
  const full = path.resolve(process.cwd(), p)
  if (fs.existsSync(full)) dotenv.config({ path: full })
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your env before running.')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const CATEGORY_ID = 3 // TCGplayer Pokemon category id
const TCG_TYPE_NAME = 'Pokémon TCG'

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

async function run() {
  console.log('Fetching groups for Pokémon...')
  const groupsJson = await fetchJson(`https://tcgcsv.com/tcgplayer/${CATEGORY_ID}/groups`)
  const groups = groupsJson.results || []
  console.log(`Found ${groups.length} groups`)

  // Ensure TCG type exists
  await upsert('tcg_types', [{ name: TCG_TYPE_NAME }], 'name')
  const { data: typeRow, error: typeErr } = await supabase
    .from('tcg_types')
    .select('id')
    .eq('name', TCG_TYPE_NAME)
    .single()
  if (typeErr) throw typeErr
  const tcgTypeId = typeRow.id

  for (const group of groups) {
    try {
      const setName = group.name
      const groupId = group.groupId
      const setCode = group.abbreviation || String(groupId)
      console.log(`\nProcessing set ${setName} (${groupId})`)

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

      // Upsert set
      const { data: setData, error: setErr } = await supabase
        .from('card_sets')
        .upsert(
          {
            name: setName,
            code: setCode,
            tcg_type_id: tcgTypeId,
            tcg_group_id: groupId,
            tcg_category_id: CATEGORY_ID,
          },
          { onConflict: 'code' },
        )
        .select('id')
        .single()
      if (setErr) throw setErr
      const setId = setData.id

      // Build product rows with current price snapshot
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

        const existing = productMap.get(row.productId)
        if (!existing) {
          productMap.set(row.productId, {
            row: { ...baseRow, ...priceRow },
            priceUpdatedAt: Number.isFinite(capturedTime) ? capturedTime : 0,
          })
          return
        }

        const nextRow = { ...existing.row, ...baseRow }
        const nextTime = Number.isFinite(capturedTime) ? capturedTime : existing.priceUpdatedAt
        if (nextTime >= existing.priceUpdatedAt) {
          Object.assign(nextRow, priceRow)
          existing.priceUpdatedAt = nextTime
        }
        existing.row = nextRow
      })

      const products = Array.from(productMap.values()).map((entry) => entry.row)
      await upsert('products', products, 'tcg_product_id')

      console.log(`  Imported ${products.length} products`)
    } catch (err) {
      console.error(`  Error processing group ${group.groupId}: ${err.message} — skipping`)
      continue
    }
  }

  console.log('\nDone.')
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

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
