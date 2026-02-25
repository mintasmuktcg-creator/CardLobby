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

const url = getArg('--url') || getArg('-u')
const region = (getArg('--region') || 'EN').toUpperCase()
const source = getArg('--source') || 'priceguide'
const dryRun = args.includes('--dry-run')

if (!url) {
  console.error('Usage: node scripts/import-priceguide.mjs --url <priceguide_url> [--region EN|JP] [--source name] [--dry-run]')
  process.exit(1)
}

if (region !== 'EN' && region !== 'JP') {
  console.error('Invalid region. Use EN or JP.')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const chunk = (arr, size) => {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

const toNumber = (value) => {
  if (value === null || value === undefined || value === '') return null
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}

const toInt = (value) => {
  if (value === null || value === undefined || value === '') return null
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return null
  return Math.trunc(num)
}

const normalizePrinting = (value) => {
  const raw = typeof value === 'string' ? value.trim() : value
  if (!raw) return 'Unknown'
  return String(raw).trim() || 'Unknown'
}

const getRowField = (row, keys) => {
  for (const key of keys) {
    if (row && Object.prototype.hasOwnProperty.call(row, key)) return row[key]
  }
  return undefined
}

const extractRows = (payload) => {
  if (!payload) return []
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload.results)) return payload.results
  if (Array.isArray(payload.result)) return payload.result
  if (Array.isArray(payload.data)) return payload.data
  if (Array.isArray(payload.items)) return payload.items
  if (Array.isArray(payload.results?.items)) return payload.results.items
  if (Array.isArray(payload.data?.results)) return payload.data.results
  return []
}

async function fetchJson(targetUrl) {
  const res = await fetch(targetUrl, {
    headers: {
      accept: 'application/json,text/plain,*/*',
      'user-agent': 'Mozilla/5.0 (CardLobby Import)',
      referer: 'https://www.tcgplayer.com/',
    },
  })
  if (!res.ok) throw new Error(`Failed ${targetUrl}: ${res.status}`)
  return res.json()
}

async function run() {
  console.log(`Fetching priceguide: ${url}`)
  const payload = await fetchJson(url)
  const rows = extractRows(payload).filter((row) => {
    const id = getRowField(row, ['productID', 'productId', 'product_id'])
    return !!id
  })

  if (!rows.length) {
    console.error('No rows found in priceguide payload.')
    process.exit(1)
  }

  const productIds = Array.from(
    new Set(
      rows
        .map((row) => toInt(getRowField(row, ['productID', 'productId', 'product_id'])))
        .filter((id) => Number.isFinite(id) && id > 0),
    ),
  )

  console.log(`Rows: ${rows.length}, unique product IDs: ${productIds.length}`)

  const productMap = new Map()
  for (const group of chunk(productIds, 400)) {
    let query = supabase
      .from('pokemon_products')
      .select('id, tcg_product_id')
      .in('tcg_product_id', group)
      .eq('region', region)
    const { data, error } = await query
    if (error) throw error
    for (const row of data || []) {
      if (!row?.tcg_product_id) continue
      productMap.set(row.tcg_product_id, row.id)
    }
  }

  const matchedRows = rows.filter((row) => {
    const pid = toInt(getRowField(row, ['productID', 'productId', 'product_id']))
    return pid && productMap.has(pid)
  })

  console.log(`Matched products: ${matchedRows.length}`)
  if (!matchedRows.length) {
    console.log('No matching products found. Nothing to import.')
    return
  }

  const conditionMap = new Map()
  for (const row of matchedRows) {
    const condId = toInt(
      getRowField(row, ['productConditionID', 'productConditionId', 'conditionId']),
    )
    if (condId === null || condId === undefined) continue
    const name =
      getRowField(row, ['condition', 'conditionName']) ||
      (condId === 0 ? 'Damaged' : `Condition ${condId}`)
    conditionMap.set(condId, String(name).trim())
  }

  const printingMap = new Map()
  for (const row of matchedRows) {
    const pid = toInt(getRowField(row, ['productID', 'productId', 'product_id']))
    const productId = pid ? productMap.get(pid) : null
    if (!productId) continue
    const printing = normalizePrinting(
      getRowField(row, ['printing', 'printingName', 'subtype', 'subTypeName']),
    )
    const key = `${productId}|${printing}`
    if (!printingMap.has(key)) {
      printingMap.set(key, { product_id: productId, printing })
    }
  }

  console.log(
    `Distinct conditions: ${conditionMap.size}, distinct printings: ${printingMap.size}`,
  )

  if (dryRun) {
    console.log('Dry run: skipping database writes.')
    return
  }

  if (conditionMap.size) {
    const conditionRows = Array.from(conditionMap.entries()).map(([id, name]) => ({
      id,
      name,
      sort_order: id ?? 0,
    }))
    for (const group of chunk(conditionRows, 300)) {
      const { error } = await supabase
        .from('tcg_conditions')
        .upsert(group, { onConflict: 'id', returning: 'minimal' })
      if (error) throw error
    }
  }

  const printings = Array.from(printingMap.values())
  for (const group of chunk(printings, 300)) {
    const { error } = await supabase
      .from('product_printings')
      .upsert(group, { onConflict: 'product_id,printing', returning: 'minimal' })
    if (error) throw error
  }

  const printingIdMap = new Map()
  const productIdsForPrintings = Array.from(
    new Set(printings.map((row) => row.product_id)),
  )
  for (const group of chunk(productIdsForPrintings, 400)) {
    const { data, error } = await supabase
      .from('product_printings')
      .select('id, product_id, printing')
      .in('product_id', group)
    if (error) throw error
    for (const row of data || []) {
      const key = `${row.product_id}|${row.printing}`
      printingIdMap.set(key, row.id)
    }
  }

  const capturedAt = new Date().toISOString()
  const priceMap = new Map()
  for (const row of matchedRows) {
    const pid = toInt(getRowField(row, ['productID', 'productId', 'product_id']))
    const productId = pid ? productMap.get(pid) : null
    if (!productId) continue
    const condId = toInt(
      getRowField(row, ['productConditionID', 'productConditionId', 'conditionId']),
    )
    if (condId === null || condId === undefined) continue
    const printing = normalizePrinting(
      getRowField(row, ['printing', 'printingName', 'subtype', 'subTypeName']),
    )
    const printingId = printingIdMap.get(`${productId}|${printing}`)
    if (!printingId) continue

    const key = `${printingId}|${condId}`
    priceMap.set(key, {
      printing_id: printingId,
      condition_id: condId,
      source,
      currency: 'USD',
      low_price: toNumber(getRowField(row, ['lowPrice', 'low_price'])),
      market_price: toNumber(getRowField(row, ['marketPrice', 'market_price'])),
      sales: toInt(getRowField(row, ['sales', 'salesCount'])),
      captured_at: capturedAt,
    })
  }

  const priceRows = Array.from(priceMap.values())
  console.log(`Price rows to insert: ${priceRows.length}`)

  for (const group of chunk(priceRows, 500)) {
    const { error } = await supabase
      .from('product_printing_condition_prices')
      .insert(group, { returning: 'minimal' })
    if (error) throw error
  }

  console.log('Done.')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
