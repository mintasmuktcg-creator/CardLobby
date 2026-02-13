import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY

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
    /(\\bjp\\b|\\bjpn\\b|japanese|korean|chinese|thai)/i.test(setName)
  return {
    allowed: !nonEnglish,
    match: setNames.has(normalized),
  }
}

const stripSetPrefix = (name) => {
  if (!name) return name
  const colonMatch = name.match(/^([A-Z0-9]{2,6})\\s*:\\s*(.+)$/i)
  if (colonMatch) return colonMatch[2]
  const dashMatch = name.match(/^([A-Z0-9]{2,6})\\s*-\\s*(.+)$/i)
  if (dashMatch) return dashMatch[2]
  return name
}

const chunk = (arr, size) => {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    res.status(500).json({ error: 'Supabase env vars are missing.' })
    return
  }

  const urlParam = Array.isArray(req.query?.url) ? req.query.url[0] : req.query?.url
  if (!urlParam) {
    res.status(400).json({ error: 'Missing Collectr URL.' })
    return
  }

  let parsedUrl
  try {
    parsedUrl = new URL(urlParam)
  } catch {
    res.status(400).json({ error: 'Invalid Collectr URL.' })
    return
  }

  if (parsedUrl.hostname !== 'app.getcollectr.com') {
    res.status(400).json({ error: 'URL must be a app.getcollectr.com link.' })
    return
  }

  const includeNonEnglishRaw = Array.isArray(req.query?.includeNonEnglish)
    ? req.query.includeNonEnglish[0]
    : req.query?.includeNonEnglish
  const includeNonEnglish = ['1', 'true', 'yes', 'on'].includes(
    String(includeNonEnglishRaw || '').toLowerCase(),
  )

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
  })

  try {
    const { data: setRows, error: setErr } = await supabase
      .from('card_sets')
      .select('name')
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

    const response = await fetch(parsedUrl.toString(), {
      headers: {
        'user-agent': 'CardLobby Collectr Importer',
      },
    })
    if (!response.ok) {
      res.status(response.status).json({ error: `Failed to fetch ${response.status}` })
      return
    }
    const html = await response.text()

    const productBlocks = []
    const idMatches = Array.from(html.matchAll(/\\\"product_id\\\":\\\"(\\d+)\\\"/g))
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
      const collectrName = extractString(block, 'product_name')
      const quantityStr = extractString(block, 'quantity')
      const setName = extractString(block, 'catalog_group')
      const gradeCompany = extractNullable(block, 'grade_company')

      const idFromImage = imageUrl.match(/product_(\\d+)/)?.[1] || null
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
        collectrName: null,
        collectrImageUrl: null,
      }
      current.quantity += quantity
      if (!current.setName && setName) current.setName = setName
      current.englishMatch = current.englishMatch || englishStatus.match
      if (!current.collectrName && collectrName) current.collectrName = collectrName
      if (!current.collectrImageUrl && imageUrl) current.collectrImageUrl = imageUrl
      productMap.set(productId, current)
    }

    const productIds = Array.from(productMap.keys())
    const productRows = []
    const groups = chunk(productIds, 400)
    for (const group of groups) {
      const { data, error } = await supabase
        .from('products')
        .select(
          'tcg_product_id, name, product_type, card_number, rarity, image_url, market_price, card_sets(name, code)',
        )
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
        collectr_name: collectr.collectrName || null,
        collectr_image_url: collectr.collectrImageUrl || null,
        matched: !!product,
        name: product?.name ?? null,
        set: productSet ?? null,
        code: setEmbed?.code ?? null,
        product_type: product?.product_type ?? null,
        card_number: product?.card_number ?? null,
        rarity: product?.rarity ?? null,
        image_url: product?.image_url ?? null,
        market_price: product?.market_price ?? null,
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

    res.status(200).json({ summary, results })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Import failed.'
    res.status(500).json({ error: message })
  }
}
