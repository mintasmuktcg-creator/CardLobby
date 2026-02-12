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
const replaceProducts = args.includes('--replace-products') || args.includes('--replace-cards')

  if (!filePath) {
  console.error('Usage: node scripts/import-single-csv.mjs --file <path> [--set-name <name>] [--set-code <code>] [--category-name <name>] [--replace-products]')
  process.exit(1)
}

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

async function upsert(table, rows, onConflict) {
  const chunks = chunk(rows, 400)
  for (const group of chunks) {
    const { error } = await supabase.from(table).upsert(group, { onConflict })
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

  // Upsert TCG type
  const { data: typeData, error: typeError } = await supabase
    .from('tcg_types')
    .upsert({ name: categoryName }, { onConflict: 'name' })
    .select('id')
    .single()
  if (typeError) throw typeError
  const categoryId = typeData.id

  // Upsert set
  const { data: setData, error: setError } = await supabase
    .from('card_sets')
    .upsert(
      {
        name: setName,
        code: setCode || null,
        tcg_type_id: categoryId,
        tcg_group_id: tcgGroupId,
        tcg_category_id: tcgCategoryId,
      },
      { onConflict: 'code' },
    )
    .select('id')
    .single()
  if (setError) throw setError
  const setId = setData.id

  if (replaceProducts) {
    const { error: deleteErr } = await supabase.from('products').delete().eq('set_id', setId)
    if (deleteErr) throw deleteErr
    console.log('Cleared existing products for set before insert.')
  }

  // Products with current price snapshot
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

  console.log(`Done. Imported ${products.length} products.`)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
