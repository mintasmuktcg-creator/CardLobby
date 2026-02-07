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

const CATEGORY_ID = 3 // Pokémon
const CATEGORY_NAME = 'Pokémon TCG'

const chunk = (arr, size) => {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

const dedupe = (rows, keyFn) => {
  const m = new Map()
  rows.forEach((r) => {
    const k = keyFn(r)
    if (!m.has(k)) m.set(k, r)
  })
  return Array.from(m.values())
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

  // Ensure category exists
  await upsert('categories', [{ name: CATEGORY_NAME }], 'name')
  const { data: catRow, error: catErr } = await supabase
    .from('categories')
    .select('id')
    .eq('name', CATEGORY_NAME)
    .single()
  if (catErr) throw catErr
  const categoryId = catRow.id

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
            category_id: categoryId,
            tcg_group_id: groupId,
            tcg_category_id: CATEGORY_ID,
          },
          { onConflict: 'code' },
        )
        .select('id')
        .single()
      if (setErr) throw setErr
      const setId = setData.id

      // Build product rows
      const productMap = new Map()
      rows.forEach((row) => {
        if (!row.productId) return
        productMap.set(row.productId, {
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
          category_id: categoryId,
          set_id: setId,
        })
      })
      const products = Array.from(productMap.values())
      await upsert('products', products, 'tcg_product_id')

      // Map product ids
      const { data: idRows, error: idErr } = await supabase
        .from('products')
        .select('id, tcg_product_id')
        .in('tcg_product_id', products.map((p) => p.tcg_product_id))
      if (idErr) throw idErr
      const productIdMap = new Map(idRows.map((r) => [r.tcg_product_id, r.id]))

      // Cards (singles only)
      const cardMap = new Map()
      rows.forEach((row) => {
        const num = row.extNumber
        if (!num) return
        if (parseCardNumber(num) === null) return
        const key = `${setId}-${num}`
        if (!cardMap.has(key)) {
          cardMap.set(key, {
            set_id: setId,
            name: row.name,
            number: row.extNumber,
            rarity: row.extRarity,
            supertype: row.extCardType,
            subtype: row.subTypeName,
            image_url: row.imageUrl,
          })
        }
      })
      const cards = Array.from(cardMap.values())
      await upsert('cards', cards, 'set_id,number')

      // Map card ids
      const { data: cardRows, error: cardErr } = await supabase
        .from('cards')
        .select('id, number')
        .eq('set_id', setId)
      if (cardErr) throw cardErr
      const cardIdMap = new Map(cardRows.map((r) => [r.number, r.id]))

      // Product prices
    let priceRows = []
    rows.forEach((row) => {
      const pid = productIdMap.get(row.productId)
      if (!pid) return
      const captured = row.modifiedOn || new Date().toISOString()
      priceRows.push({
        product_id: pid,
        source: 'csv',
        currency: 'USD',
        low_price: row.lowPrice ?? null,
        mid_price: row.midPrice ?? null,
        high_price: row.highPrice ?? null,
        market_price: row.marketPrice ?? null,
        direct_low_price: row.directLowPrice ?? null,
        captured_at: captured,
      })
    })
    priceRows = dedupe(priceRows, (r) => `${r.product_id}|${r.source}|${r.captured_at}`)
    await upsert('product_prices', priceRows, 'product_id,source,captured_at')

    // Card price history (simple mapping from market/mid/low to cents)
    let cardPrices = []
    rows.forEach((row) => {
      const cid = row.extNumber ? cardIdMap.get(row.extNumber) : null
      if (!cid) return
      const cents = Math.round((row.marketPrice ?? row.midPrice ?? row.lowPrice ?? 0) * 100)
      const captured = row.modifiedOn || new Date().toISOString()
      cardPrices.push({
        card_id: cid,
        source: 'csv',
        currency: 'USD',
        price_cents: cents,
        captured_at: captured,
      })
    })
    cardPrices = dedupe(cardPrices, (r) => `${r.card_id}|${r.source}|${r.captured_at}`)
    await upsert('price_history', cardPrices, 'card_id,source,captured_at')

      console.log(
        `  Imported ${products.length} products, ${cards.length} cards, ${priceRows.length} product prices`,
      )
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

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
