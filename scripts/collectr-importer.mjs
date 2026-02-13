#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'

for (const p of ['.env.scripts', '.env', '.env.local']) {
  const full = path.resolve(process.cwd(), p)
  if (fs.existsSync(full)) dotenv.config({ path: full })
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Set SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY (or VITE_SUPABASE_ANON_KEY).')
  process.exit(1)
}

const args = process.argv.slice(2)
const getArg = (flag) => {
  const idx = args.indexOf(flag)
  if (idx === -1) return null
  return args[idx + 1] ?? null
}

const url = getArg('--url') || getArg('-u')
const includeNonEnglish = args.includes('--include-non-english')

if (!url) {
  console.error('Usage: node scripts/collectr-importer.mjs --url <app.getcollectr.com/showcase/profile/...> [--include-non-english]')
  process.exit(1)
}

let parsedUrl
try {
  parsedUrl = new URL(url)
} catch {
  console.error('Invalid URL provided.')
  process.exit(1)
}

if (parsedUrl.hostname !== 'app.getcollectr.com') {
  console.error('URL must be a app.getcollectr.com link.')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const decodeEscapes = (value) => {
  if (!value) return value
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

const normalizeName = (value) => {
  return decodeEscapes(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const extractString = (block, key) => {
  const reEscaped = new RegExp(`\\\\\"${key}\\\\\":\\\\\"(.*?)\\\\\"`)
  const rePlain = new RegExp(`\"${key}\":\"(.*?)\"`)
  const escaped = block.match(reEscaped)
  if (escaped) return decodeEscapes(escaped[1])
  const plain = block.match(rePlain)
  return plain ? decodeEscapes(plain[1]) : null
}

const extractNullable = (block, key) => {
  const str = extractString(block, key)
  if (str !== null) return str
  const reEscaped = new RegExp(`\\\\\"${key}\\\\\":null`)
  const rePlain = new RegExp(`\"${key}\":null`)
  if (reEscaped.test(block) || rePlain.test(block)) return null
  return null
}

const getEnglishStatus = (setName, setNames) => {
  if (!setName) return { allowed: false, match: false }
  const normalized = normalizeName(setName)
  if (!normalized) return { allowed: false, match: false }
  const nonEnglish =
    /(\bjp\b|\bjpn\b|japanese|korean|chinese|thai)/i.test(setName)
  return {
    allowed: !nonEnglish,
    match: setNames.has(normalized),
  }
}

const stripSetPrefix = (name) => {
  if (!name) return name
  const colonMatch = name.match(/^([A-Z0-9]{2,6})\s*:\s*(.+)$/i)
  if (colonMatch) return colonMatch[2]
  const dashMatch = name.match(/^([A-Z0-9]{2,6})\s*-\s*(.+)$/i)
  if (dashMatch) return dashMatch[2]
  return name
}

const fetchHtml = async () => {
  const res = await fetch(parsedUrl.toString(), {
    headers: {
      'user-agent': 'CardLobby Collectr Importer',
    },
  })
  if (!res.ok) throw new Error(`Failed to fetch ${res.status}`)
  return res.text()
}

const chunk = (arr, size) => {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

const run = async () => {
  const { data: setRows, error: setErr } = await supabase
    .from('card_sets')
    .select('id, name')
  if (setErr) throw setErr
  const setNameSet = new Set()
  const addSetName = (name) => {
    const normalized = normalizeName(name)
    if (normalized) setNameSet.add(normalized)
  }
  for (const row of setRows || []) {
    addSetName(row.name)
    const colonMatch = row.name.match(/^([A-Z0-9]{2,6})\\s*:\\s*(.+)$/i)
    if (colonMatch) addSetName(colonMatch[2])
    const dashMatch = row.name.match(/^([A-Z0-9]{2,6})\\s*-\\s*(.+)$/i)
    if (dashMatch) addSetName(dashMatch[2])
  }

  const html = await fetchHtml()
  const productBlocks = []
  const idMatches = Array.from(html.matchAll(/\\\"product_id\\\":\\\"(\d+)\\\"/g))
  for (const match of idMatches) {
    const start = html.lastIndexOf('{', match.index ?? 0)
    const end = html.indexOf('}', match.index ?? 0)
    if (start === -1 || end === -1) continue
    productBlocks.push(html.slice(start, end + 1))
  }

  const productMap = new Map()
  let skippedGraded = 0
  let skippedNonEnglish = 0

  for (const block of productBlocks) {
    const idStr = extractString(block, 'product_id')
    const imageUrl = extractString(block, 'image_url') || ''
    const quantityStr = extractString(block, 'quantity')
    const setName = extractString(block, 'catalog_group')
    const gradeCompany = extractNullable(block, 'grade_company')

    const idFromImage = imageUrl.match(/product_(\d+)/)?.[1] || null
    const productId = Number(idStr || idFromImage)
    if (!productId) continue

    const quantity = Number.parseInt(quantityStr || '1', 10) || 1

    if (gradeCompany) {
      skippedGraded += 1
      continue
    }

    const englishStatus = getEnglishStatus(setName, setNameSet)
    if (!englishStatus.allowed && !includeNonEnglish) {
      skippedNonEnglish += 1
      continue
    }

    const current = productMap.get(productId) || {
      productId,
      quantity: 0,
      setName,
      englishMatch: englishStatus.match,
    }
    current.quantity += quantity
    if (!current.setName && setName) current.setName = setName
    current.englishMatch = current.englishMatch || englishStatus.match
    productMap.set(productId, current)
  }

  const productIds = Array.from(productMap.keys())
  const productRows = []
  const chunks = chunk(productIds, 400)
  for (const group of chunks) {
    const { data, error } = await supabase
      .from('products')
      .select('id, tcg_product_id, name, product_type, card_number, rarity, set_id, card_sets(name, code)')
      .in('tcg_product_id', group)
    if (error) throw error
    if (data) productRows.push(...data)
  }

  const productLookup = new Map(
    productRows.map((row) => [row.tcg_product_id, row]),
  )

  const results = productIds.map((id) => {
    const collectr = productMap.get(id)
    const product = productLookup.get(id) || null
    const setEmbed = Array.isArray(product?.card_sets)
      ? product?.card_sets[0] ?? null
      : product?.card_sets ?? null
    const collectrSet = collectr.setName || null
    const productSet = setEmbed?.name ?? null
    const normalizedCollectr = collectrSet ? normalizeName(collectrSet) : null
    const normalizedProduct = productSet ? normalizeName(productSet) : null
    const normalizedProductStripped = productSet
      ? normalizeName(stripSetPrefix(productSet))
      : null
    const setMatch =
      normalizedCollectr &&
      (normalizedCollectr === normalizedProduct ||
        normalizedCollectr === normalizedProductStripped)
    return {
      tcg_product_id: id,
      quantity: collectr.quantity,
      collectr_set: collectrSet,
      matched: !!product,
      name: product?.name ?? null,
      set: setEmbed?.name ?? null,
      code: setEmbed?.code ?? null,
      product_type: product?.product_type ?? null,
      card_number: product?.card_number ?? null,
      rarity: product?.rarity ?? null,
      english_match: collectr.englishMatch || setMatch || false,
    }
  })

  const summary = {
    totalCollectr: productBlocks.length,
    parsedProducts: productIds.length,
    matchedProducts: results.filter((r) => r.matched).length,
    skippedGraded,
    skippedNonEnglish,
  }

  console.log('Collectr Importer')
  console.log(JSON.stringify(summary, null, 2))
  console.log('')
  console.table(results.slice(0, 50))
  if (results.length > 50) {
    console.log(`Showing 50/${results.length} rows. Add --include-non-english to disable filtering.`)
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
