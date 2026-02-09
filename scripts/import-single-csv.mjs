#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import Papa from 'papaparse'
import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'

for (const p of ['.env.scripts', '.env', '.env.local']) {
  const full = path.resolve(process.cwd(), p)
  if (fs.existsSync(full)) dotenv.config({ path: full })
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Set SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY before running.')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const args = process.argv.slice(2)
const getArg = (flag) => {
  const idx = args.indexOf(flag)
  if (idx === -1) return null
  return args[idx + 1] ?? null
}

const filePath = getArg('--file') || getArg('-f')
const setNameArg = getArg('--set-name')
const setCodeArg = getArg('--set-code')
const categoryNameArg = getArg('--category-name')
const replaceCards = args.includes('--replace-cards')

  if (!filePath) {
  console.error('Usage: node scripts/import-single-csv.mjs --file <path> [--set-name <name>] [--set-code <code>] [--category-name <name>] [--replace-cards]')
  process.exit(1)
}

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

async function upsert(table, rows, onConflict) {
  const chunks = chunk(rows, 400)
  for (const group of chunks) {
    const { error } = await supabase.from(table).upsert(group, { onConflict })
    if (error) throw error
  }
}

async function upsertIndividually(table, rows, onConflict, label) {
  let processed = 0
  for (const row of rows) {
    processed += 1
    if (processed % 250 === 0 || processed === rows.length) {
      console.log(`${label}: ${processed}/${rows.length}`)
    }
    const { error } = await supabase.from(table).upsert(row, { onConflict })
    if (error) throw error
  }
}

async function resolveSetInfo(rows) {
  const first = rows[0]
  const tcgCategoryId = first?.categoryId ?? null
  const tcgGroupId = first?.groupId ?? null

  if (!tcgCategoryId || !tcgGroupId) {
    throw new Error('CSV missing categoryId or groupId. Cannot resolve set info.')
  }

  let setName = setNameArg
  let setCode = setCodeArg

  if (!setName || !setCode) {
    const groupsJson = await fetchJson(`https://tcgcsv.com/tcgplayer/${tcgCategoryId}/groups`)
    const group = (groupsJson.results || []).find((g) => g.groupId === tcgGroupId)
    if (group) {
      setName = setName || group.name
      setCode = setCode || group.abbreviation || String(group.groupId)
    }
  }

  if (!setName || !setCode) {
    throw new Error('Missing set name or code. Provide --set-name and --set-code.')
  }

  let categoryName = categoryNameArg
  if (!categoryName) {
    categoryName = tcgCategoryId === 3 ? 'Pokémon TCG' : `TCG Category ${tcgCategoryId}`
  }

  return { tcgCategoryId, tcgGroupId, setName, setCode, categoryName }
}

async function run() {
  const resolvedPath = path.resolve(process.cwd(), filePath)
  if (!fs.existsSync(resolvedPath)) throw new Error(`File not found: ${resolvedPath}`)

  const csv = fs.readFileSync(resolvedPath, 'utf8')
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true, dynamicTyping: true })
  const rows = (parsed.data || []).filter((r) => r && r.productId)
  if (!rows.length) throw new Error('No rows found in CSV.')

  const { tcgCategoryId, tcgGroupId, setName, setCode, categoryName } = await resolveSetInfo(rows)
  console.log(`Importing ${rows.length} rows for set "${setName}" (${setCode}).`)

  // Upsert category
  const { data: catData, error: catError } = await supabase
    .from('categories')
    .upsert({ name: categoryName }, { onConflict: 'name' })
    .select('id')
    .single()
  if (catError) throw catError
  const categoryId = catData.id

  // Upsert set
  const { data: setData, error: setError } = await supabase
    .from('card_sets')
    .upsert(
      {
        name: setName,
        code: setCode || null,
        category_id: categoryId,
        tcg_group_id: tcgGroupId,
        tcg_category_id: tcgCategoryId,
      },
      { onConflict: 'code' },
    )
    .select('id')
    .single()
  if (setError) throw setError
  const setId = setData.id

  // Products
  const productMap = new Map()
  rows.forEach((row) => {
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
  if (replaceCards) {
    const { error: deleteErr } = await supabase.from('cards').delete().eq('set_id', setId)
    if (deleteErr) throw deleteErr
    console.log('Cleared existing cards for set before insert.')
  }
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
  await upsertIndividually('product_prices', priceRows, 'product_id,source,captured_at', 'Prices')

  // Card price history
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
  await upsertIndividually('price_history', cardPrices, 'card_id,source,captured_at', 'Card prices')

  console.log(
    `Done. Imported ${products.length} products, ${cards.length} cards, ${priceRows.length} product prices, ${cardPrices.length} card price rows.`,
  )
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
