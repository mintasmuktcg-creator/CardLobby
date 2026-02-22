import { createClient } from '@supabase/supabase-js'

const loadPuppeteer = async () => {
  try {
    const mod = await import('puppeteer')
    return mod?.default ?? mod
  } catch (err) {
    return null
  }
}

const COLLECTR_API_BASE = 'https://api-v2.getcollectr.com'
const COLLECTR_ANON_USERNAME = '00000000-0000-0000-0000-000000000000'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const buildCollectrApiHeaders = () => {
  const headers = {
    'user-agent': process.env.COLLECTR_USER_AGENT || 'CardLobby Collectr Importer',
    accept: process.env.COLLECTR_ACCEPT || 'application/json',
  }
  const acceptLanguage = process.env.COLLECTR_ACCEPT_LANGUAGE
  if (acceptLanguage) headers['accept-language'] = acceptLanguage
  const authToken = process.env.COLLECTR_AUTH_TOKEN || process.env.COLLECTR_AUTHORIZATION
  if (authToken) headers.authorization = authToken
  const origin = process.env.COLLECTR_ORIGIN
  if (origin) headers.origin = origin
  const referer = process.env.COLLECTR_REFERER
  if (referer) headers.referer = referer
  return headers
}

const buildCollectrPageHeaders = () => {
  const headers = {}
  const accept = process.env.COLLECTR_ACCEPT
  if (accept) headers.accept = accept
  const acceptLanguage = process.env.COLLECTR_ACCEPT_LANGUAGE
  if (acceptLanguage) headers['accept-language'] = acceptLanguage
  const authToken = process.env.COLLECTR_AUTH_TOKEN || process.env.COLLECTR_AUTHORIZATION
  if (authToken) headers.authorization = authToken
  return headers
}

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

const isPlainObject = (value) => {
  if (!value || typeof value !== 'object') return false
  return Object.getPrototypeOf(value) === Object.prototype
}

const summarizeKeys = (value, depth = 2) => {
  if (depth < 0) return null
  if (Array.isArray(value)) {
    if (!value.length) return []
    return [summarizeKeys(value[0], depth - 1)]
  }
  if (!isPlainObject(value)) return typeof value
  const out = {}
  for (const key of Object.keys(value)) {
    const child = value[key]
    if (isPlainObject(child) || Array.isArray(child)) {
      out[key] = summarizeKeys(child, depth - 1)
    } else {
      out[key] = typeof child
    }
  }
  return out
}

const normalizeName = (value) => {
  return decodeEscapes(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const stripJpTag = (value) => {
  if (!value) return value
  return String(value)
    .replace(/\(\s*JP\s*\)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const normalizeCardNameForMatch = (value) => normalizeName(stripJpTag(value))


const normalizeCardNumberForMatch = (value) => {
  if (!value) return null
  let raw = String(value).trim().toUpperCase()
  raw = raw.replace(/#/g, '').replace(/\s+/g, '')
  if (!raw) return null

  if (raw.includes('/')) {
    const [left, right] = raw.split('/')
    const l = left ? left.replace(/^0+(?=\d)/, '') : left
    const r = right ? right.replace(/^0+(?=\d)/, '') : right
    return `${l}/${r}`
  }

  return raw.replace(/^0+(?=\d)/, '')
}

const compareSetNames = (left, right) => {
  const leftKey = normalizeName(left)
  const rightKey = normalizeName(right)
  if (!leftKey || !rightKey) return false
  return (
    leftKey === rightKey || leftKey.includes(rightKey) || rightKey.includes(leftKey)
  )
}

const looksLikeCardNumber = (value) => {
  if (!value) return false
  const raw = String(value).trim()
  return /(\d{1,4}(?:\/\d{1,4})?|[A-Z]{1,4}\d{1,4}(?:\/\d{1,4})?)/i.test(
    raw,
  )
}

const findFirstValue = (value, keyPatterns, valueCheck, depth = 4) => {
  if (!value || depth < 0) return null
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findFirstValue(entry, keyPatterns, valueCheck, depth - 1)
      if (found !== null && found !== undefined) return found
    }
    return null
  }
  if (!isPlainObject(value)) return null
  for (const key of Object.keys(value)) {
    const val = value[key]
    if (keyPatterns.some((pattern) => pattern.test(key))) {
      if (val !== null && val !== undefined && (!valueCheck || valueCheck(val))) {
        return val
      }
    }
  }
  for (const key of Object.keys(value)) {
    const val = value[key]
    if (isPlainObject(val) || Array.isArray(val)) {
      const found = findFirstValue(val, keyPatterns, valueCheck, depth - 1)
      if (found !== null && found !== undefined) return found
    }
  }
  return null
}

const buildMatchKey = (setName, cardName, cardNumber) => {
  const setKey = normalizeName(setName)
  const nameKey = normalizeCardNameForMatch(cardName)
  const numberKey = normalizeCardNumberForMatch(cardNumber)
  if (!setKey || !nameKey || !numberKey) return null
  return `${setKey}|${nameKey}|${numberKey}`
}

const buildLooseKey = (setName, cardName, cardNumber) => {
  const parts = [
    normalizeName(setName) || '',
    normalizeCardNameForMatch(cardName) || '',
    normalizeCardNumberForMatch(cardNumber) || '',
  ]
  return parts.join('|')
}

const buildNameSetKey = (setName, cardName) => {
  const setKey = normalizeName(setName)
  const nameKey = normalizeCardNameForMatch(cardName)
  if (!setKey || !nameKey) return null
  return `${setKey}|${nameKey}`
}

const buildJapanItemKey = (setName, cardNumber, cardName) => {
  const setKey = normalizeName(setName)
  const numberKey = normalizeCardNumberForMatch(cardNumber)
  if (!setKey || !numberKey) return null
  const nameKey = normalizeName(cardName) || ''
  return `${setKey}|${numberKey}|${nameKey}`
}

const buildJapanChecksFromProduct = ({
  collectrSet,
  collectrNumber,
  collectrName,
  productName,
  productSet,
  productSetOther,
  productNumber,
}) => {
  const setMatch =
    compareSetNames(collectrSet, productSet) ||
    compareSetNames(collectrSet, productSetOther)
  const numberMatch =
    !!collectrNumber &&
    !!productNumber &&
    normalizeCardNumberForMatch(collectrNumber) ===
      normalizeCardNumberForMatch(productNumber)
  const nameMatch =
    collectrName && productName ? compareNamesLike(collectrName, productName) : null
  return {
    set_match: setMatch,
    card_number_match: numberMatch,
    name_match: nameMatch,
  }
}

const compareNamesLike = (left, right) => {
  const leftKey = normalizeName(left)
  const rightKey = normalizeName(right)
  if (!leftKey || !rightKey) return false
  return (
    leftKey === rightKey || leftKey.includes(rightKey) || rightKey.includes(leftKey)
  )
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

const isJapaneseSetName = (setName) => {
  if (!setName) return false
  return /(\bjp\b|\bjpn\b|japanese|pokemon\s+japan)/i.test(setName)
}

const findSetRowsByName = (setName, setMap, allowPartial = false) => {
  if (!setName) return []
  const normalized = normalizeName(setName)
  if (!normalized) return []
  const out = []
  const seen = new Set()
  const addRows = (rows) => {
    if (!rows) return
    for (const row of rows) {
      const key = row?.id ?? row?.name ?? JSON.stringify(row)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(row)
    }
  }
  addRows(setMap.get(normalized))
  if (!allowPartial || out.length) return out
  for (const [key, rows] of setMap.entries()) {
    if (key.includes(normalized) || normalized.includes(key)) {
      addRows(rows)
    }
  }
  return out
}

const getSetStatus = (setName, englishSetMap, japanSetMap) => {
  if (!setName) return { isJapanese: false, match: false }
  const englishRows = findSetRowsByName(setName, englishSetMap, false)
  const japanRows = findSetRowsByName(setName, japanSetMap, true)
  const englishMatch = englishRows.length > 0
  const japanMatch = japanRows.length > 0
  const isJapanese = isJapaneseSetName(setName) || (!englishMatch && japanMatch)
  const match = isJapanese ? japanMatch : englishMatch
  return { isJapanese, match }
}


const chunk = (arr, size) => {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

const extractCollectrItemsFromHtml = (html) => {
  const productBlocks = []
  const seenBlocks = new Set()
  const patterns = [/\\"product_id\\":\\"(\d+)\\"/g, /"product_id":"(\d+)"/g]
  for (const pattern of patterns) {
    const idMatches = Array.from(html.matchAll(pattern))
    for (const match of idMatches) {
      const start = html.lastIndexOf('{', match.index ?? 0)
      const end = html.indexOf('}', match.index ?? 0)
      if (start === -1 || end === -1) continue
      const block = html.slice(start, end + 1)
      if (seenBlocks.has(block)) continue
      seenBlocks.add(block)
      productBlocks.push(block)
    }
  }

  const items = productBlocks.map((block) => ({
    product_id: extractString(block, 'product_id'),
    image_url: extractString(block, 'image_url') || '',
    product_name: extractString(block, 'product_name'),
    quantity: extractString(block, 'quantity'),
    catalog_group: extractString(block, 'catalog_group'),
    card_number: extractString(block, 'card_number'),
    rarity: extractString(block, 'rarity'),
    grade_id: extractString(block, 'grade_id'),
    grade_company: extractNullable(block, 'grade_company'),
  }))

  return { items, totalBlocks: productBlocks.length }
}

const getLooseKeyFromItem = (item) => {
  if (!item || typeof item !== 'object') return null
  const setName =
    item.catalog_group ??
    item.catalogGroup ??
    item.set_name ??
    item.setName ??
    item.group ??
    null
  const cardName =
    item.product_name ?? item.productName ?? item.name ?? item.title ?? null
  const cardNumber =
    item.card_number ??
    item.cardNumber ??
    item.collector_number ??
    item.collectorNumber ??
    item.number ??
    null
  return buildMatchKey(setName, cardName, cardNumber)
}

const getFallbackKeyFromItem = (item) => {
  if (!item || typeof item !== 'object') return null
  const setName =
    item.catalog_group ??
    item.catalogGroup ??
    item.set_name ??
    item.setName ??
    item.group ??
    null
  const cardName =
    item.product_name ?? item.productName ?? item.name ?? item.title ?? null
  const setKey = normalizeName(setName)
  const nameKey = normalizeName(cardName)
  if (!setKey && !nameKey) return null
  return `${setKey}|${nameKey}|`
}

const mergeCollectrItems = (baseItems, domItems) => {
  if (!Array.isArray(domItems) || !domItems.length) return baseItems
  const byId = new Map()
  const byLooseKey = new Map()
  const byFallbackKey = new Map()

  baseItems.forEach((item) => {
    const collectionKey = getCollectionKeyFromItem(item)
    const id = item?.product_id ?? item?.productId ?? item?.tcg_product_id ?? null
    if (id) byId.set(`${collectionKey}|${String(id)}`, item)
    const key = getLooseKeyFromItem(item)
    const keyedLoose = key ? `${collectionKey}|${key}` : null
    if (keyedLoose && !byLooseKey.has(keyedLoose)) byLooseKey.set(keyedLoose, item)
    const fallbackKey = getFallbackKeyFromItem(item)
    const keyedFallback = fallbackKey ? `${collectionKey}|${fallbackKey}` : null
    if (keyedFallback && !byFallbackKey.has(keyedFallback)) {
      byFallbackKey.set(keyedFallback, item)
    }
  })

  domItems.forEach((domItem) => {
    const collectionKey = getCollectionKeyFromItem(domItem)
    const id = domItem?.product_id ?? domItem?.productId ?? null
    if (id && byId.has(`${collectionKey}|${String(id)}`)) {
      const target = byId.get(`${collectionKey}|${String(id)}`)
      Object.entries(domItem).forEach(([key, value]) => {
        if (value === null || value === undefined || value === '') return
        if (target[key] === null || target[key] === undefined || target[key] === '') {
          target[key] = value
        }
      })
      return
    }

    const key = getLooseKeyFromItem(domItem)
    const keyedLoose = key ? `${collectionKey}|${key}` : null
    if (keyedLoose && byLooseKey.has(keyedLoose)) {
      const target = byLooseKey.get(keyedLoose)
      Object.entries(domItem).forEach(([k, value]) => {
        if (value === null || value === undefined || value === '') return
        if (target[k] === null || target[k] === undefined || target[k] === '') {
          target[k] = value
        }
      })
      return
    }

    const fallbackKey = getFallbackKeyFromItem(domItem)
    const keyedFallback = fallbackKey ? `${collectionKey}|${fallbackKey}` : null
    if (keyedFallback && byFallbackKey.has(keyedFallback)) {
      const target = byFallbackKey.get(keyedFallback)
      Object.entries(domItem).forEach(([k, value]) => {
        if (value === null || value === undefined || value === '') return
        if (target[k] === null || target[k] === undefined || target[k] === '') {
          target[k] = value
        }
      })
      return
    }

    baseItems.push(domItem)
    if (id) byId.set(`${collectionKey}|${String(id)}`, domItem)
    if (keyedLoose) byLooseKey.set(keyedLoose, domItem)
    if (keyedFallback) byFallbackKey.set(keyedFallback, domItem)
  })

  return baseItems
}

const extractCardNumberFromName = (value) => {
  if (!value) return null
  const raw = String(value)
  const withSlash = raw.match(/#?\s*([A-Z0-9]{1,6}-\d{1,4}(?:\/\d{1,4})?)/i)
  if (withSlash) return withSlash[1]
  const basic = raw.match(/#?\s*([A-Z]{1,3}\d{1,4}(?:\/\d{1,4})?)/i)
  if (basic) return basic[1]
  const numeric = raw.match(/#?\s*(\d{1,4}(?:\/\d{1,4})?)/)
  return numeric ? numeric[1] : null
}

const normalizeCollectrItem = (item) => {
  if (!item || typeof item !== 'object') return null
  const debug = process.env.COLLECTR_DEBUG === '1'
  const debugLimit = Number(process.env.COLLECTR_DEBUG_LIMIT || 3)
  const collectionId =
    item.collection_id ??
    item.collectionId ??
    item.collectr_collection_id ??
    item.collectrCollectionId ??
    item.__collection_id ??
    null
  const collectionName =
    item.collection_name ??
    item.collectionName ??
    item.collectr_collection_name ??
    item.collectrCollectionName ??
    item.__collection_name ??
    null
  const idStr =
    item.product_id ??
    item.productId ??
    item.tcg_product_id ??
    item.tcgProductId ??
    null
  const imageUrl = item.image_url ?? item.imageUrl ?? ''
  const idFromImage = imageUrl?.match(/product_(\d+)/)?.[1] || null
  const numericId = Number(idStr || idFromImage)
  const productId = Number.isFinite(numericId) && numericId > 0 ? numericId : null

  const quantityRaw =
    item.quantity ??
    item.qty ??
    item.count ??
    item.total ??
    item.total_quantity ??
    '1'
  const quantity = Number.parseInt(String(quantityRaw), 10) || 1
  const gradeId =
    item.grade_id ??
    item.gradeId ??
    item.grade ??
    item.grade_value ??
    item.gradeValue ??
    null
  const cardCondition = item.card_condition ?? item.cardCondition ?? null
  const isCard =
    typeof item.is_card === 'boolean'
      ? item.is_card
      : typeof item.isCard === 'boolean'
        ? item.isCard
        : null

  const rawCollectrName =
    item.product_name ??
    item.productName ??
    item.name ??
    item.title ??
    findFirstValue(item, [/product_name/i, /card_name/i, /^name$/i, /title/i]) ??
    null
  const collectrName = stripJpTag(rawCollectrName)

  let setName =
    item.catalog_group ??
    item.catalogGroup ??
    item.set_name ??
    item.setName ??
    item.group ??
    null
  if (!setName) {
    setName = findFirstValue(
      item,
      [/set_name/i, /setName/i, /catalog_group/i, /group_name/i, /^set$/i],
    )
  }

  let cardNumber =
    item.card_number ??
    item.cardNumber ??
    item.collector_number ??
    item.collectorNumber ??
    item.number ??
    item.card_no ??
    item.cardNo ??
    item.num ??
    null
  if (!cardNumber) {
    cardNumber = findFirstValue(
      item,
      [/card_number/i, /collector_number/i, /cardNo/i, /card_no/i, /number/i],
      looksLikeCardNumber,
    )
  }
  if (!cardNumber) {
    cardNumber = extractCardNumberFromName(collectrName)
  }

  let rarity =
    item.rarity ??
    item.card_rarity ??
    item.cardRarity ??
    item.rarity_name ??
    item.rarityName ??
    null
  if (!rarity) {
    rarity = findFirstValue(item, [/rarity/i])
  }

  if (debug && !productId) {
    normalizeCollectrItem._debugCount = normalizeCollectrItem._debugCount || 0
    if (normalizeCollectrItem._debugCount < debugLimit) {
      normalizeCollectrItem._debugCount += 1
      console.log(
        '[collectr-debug] Missing product_id keys:',
        JSON.stringify(summarizeKeys(item, 2)),
      )
      console.log(
        '[collectr-debug] Extracted fields:',
        JSON.stringify({ collectrName, setName, cardNumber, rarity }, null, 2),
      )
    }
  }

  return {
    productId,
    quantity,
    collectrName,
    collectrImageUrl: imageUrl || null,
    setName: setName || null,
    collectionId: collectionId || null,
    collectionName: collectionName || null,
    gradeCompany: item.grade_company ?? item.gradeCompany ?? null,
    gradeId,
    cardCondition,
    isCard,
    cardNumber,
    rarity,
  }
}

const isCollectrGraded = ({ gradeCompany, gradeId, isCard }) => {
  if (gradeCompany) return true
  if (isCard === false) return false
  if (gradeId === null || gradeId === undefined) return false
  const normalizedGrade = String(gradeId).trim()
  if (!normalizedGrade) return false
  return normalizedGrade !== '52'
}

const buildCollectionKey = (collectionId, collectionName) => {
  if (collectionId) return `id:${collectionId}`
  if (collectionName) {
    const normalized = normalizeName(collectionName)
    if (normalized) return `name:${normalized}`
  }
  return 'default'
}

const getCollectionKeyFromItem = (item) => {
  if (!item || typeof item !== 'object') return 'default'
  const collectionId =
    item.collection_id ??
    item.collectionId ??
    item.collectr_collection_id ??
    item.collectrCollectionId ??
    item.__collection_id ??
    null
  const collectionName =
    item.collection_name ??
    item.collectionName ??
    item.collectr_collection_name ??
    item.collectrCollectionName ??
    item.__collection_name ??
    null
  return buildCollectionKey(collectionId, collectionName)
}

const tagItemsWithCollection = (items, collection) => {
  if (!Array.isArray(items) || !items.length) return items
  const collectionId = collection?.id ?? null
  const collectionName = collection?.name ?? null
  if (!collectionId && !collectionName) return items
  items.forEach((item) => {
    if (!item || typeof item !== 'object') return
    if (collectionId && !item.collection_id) item.collection_id = collectionId
    if (collectionName && !item.collection_name) item.collection_name = collectionName
  })
  return items
}

const getCollectrProfileId = (parsedUrl) => {
  if (!parsedUrl) return null
  const match = parsedUrl.pathname.match(/showcase\/profile\/([^/]+)/i)
  return match ? match[1] : null
}

const getCollectrCollectionId = (parsedUrl) => {
  if (!parsedUrl) return null
  const collection = parsedUrl.searchParams.get('collection')
  if (collection && collection.trim()) return collection.trim()
  const idParam = parsedUrl.searchParams.get('id')
  if (idParam && idParam.trim()) return idParam.trim()
  return null
}

const buildCollectrQueryParams = ({
  offset,
  limit,
  username,
  collectionId,
  filters,
}) => {
  const params = new URLSearchParams()
  params.set('offset', String(offset))
  params.set('limit', String(limit))
  params.set('unstackedView', 'true')
  params.set('username', username)
  if (collectionId) params.set('id', collectionId)
  if (filters !== null && filters !== undefined) {
    params.set('filters', String(filters))
  }
  return params
}

const fetchCollectrItemsViaApi = async (profileId, collectionId, filters) => {
  if (!profileId) return { items: [], collections: [] }
  const rawLimit = Number(process.env.COLLECTR_API_LIMIT || 30)
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 10), 30)
    : 30
  const rawMaxPages = Number(process.env.COLLECTR_API_MAX_PAGES || 200)
  const maxPages = Number.isFinite(rawMaxPages)
    ? Math.min(Math.max(rawMaxPages, 1), 500)
    : 200
  const anonUsername =
    process.env.COLLECTR_USERNAME ||
    process.env.COLLECTR_ANON_USERNAME ||
    COLLECTR_ANON_USERNAME
  const headers = buildCollectrApiHeaders()

  let offset = 0
  const items = []
  let collections = []

  for (let page = 0; page < maxPages; page += 1) {
    const params = buildCollectrQueryParams({
      offset,
      limit,
      username: anonUsername,
      collectionId,
      filters,
    })

    const response = await fetch(
      `${COLLECTR_API_BASE}/data/showcase/${profileId}?${params.toString()}`,
      { headers },
    )

    if (!response.ok) {
      throw new Error(`Collectr API failed with status ${response.status}`)
    }

    const payload = await response.json()
    const products = Array.isArray(payload?.products)
      ? payload.products
      : Array.isArray(payload?.data?.products)
        ? payload.data.products
        : Array.isArray(payload?.data?.data?.products)
          ? payload.data.data.products
          : []
    if (!page) {
      const maybeCollections = Array.isArray(payload?.collections)
        ? payload.collections
        : Array.isArray(payload?.data?.collections)
          ? payload.data.collections
          : []
      if (maybeCollections.length) {
        collections = maybeCollections
      }
    }

    if (!Array.isArray(products) || products.length === 0) break

    items.push(...products)
    offset += limit
  }

  return { items, collections }
}

const fetchCollectrItemsViaPageApi = async (
  page,
  profileId,
  headerOverrides = {},
  forcedUsername = null,
  collectionId = null,
  filters = null,
) => {
  if (!page || !profileId) return []
  try {
    return await page.evaluate(
      async (
        profileId,
        headerOverrides,
        forcedUsername,
        collectionId,
        filters,
      ) => {
      const limit = 30
      const maxPages = 200
      const items = []
      let offset = 0

      const getAnonUsername = () => {
        try {
          const token = JSON.parse(localStorage.getItem('collectrToken') || '{}')
          if (token?.username) return token.username
        } catch {
          // ignore parse errors
        }
        return '00000000-0000-0000-0000-000000000000'
      }

      const username = forcedUsername || getAnonUsername()
      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        const params = new URLSearchParams()
        params.set('offset', String(offset))
        params.set('limit', String(limit))
        params.set('unstackedView', 'true')
        params.set('username', username)
        if (collectionId) params.set('id', collectionId)
        if (filters !== null && filters !== undefined) {
          params.set('filters', String(filters))
        }
        const url = `https://api-v2.getcollectr.com/data/showcase/${profileId}?${params.toString()}`
        const response = await fetch(url, {
          credentials: 'include',
          headers: headerOverrides || undefined,
        })
        if (!response.ok) break
        const payload = await response.json()
        const products = Array.isArray(payload?.products)
          ? payload.products
          : Array.isArray(payload?.data?.products)
            ? payload.data.products
            : Array.isArray(payload?.data?.data?.products)
              ? payload.data.data.products
              : []
        if (!Array.isArray(products) || products.length === 0) break
        items.push(...products)
        offset += limit
      }
      return items
      },
      profileId,
      headerOverrides,
      forcedUsername,
      collectionId,
      filters,
    )
  } catch {
    return []
  }
}

const fetchCollectrItemsViaBrowser = async (url, profileId, collectionId) => {
  const puppeteer = await loadPuppeteer()
  if (!puppeteer) {
    throw new Error(
      'Puppeteer is not installed. Run `npm install puppeteer` to enable browser scraping.',
    )
  }

  const headlessEnv = (process.env.COLLECTR_HEADLESS || '').toLowerCase()
  const headless =
    headlessEnv === '0' || headlessEnv === 'false' || headlessEnv === 'no'
      ? false
      : 'new'

  const browser = await puppeteer.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--lang=en-US,en',
    ],
  })

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 800 })
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    )
    await page.setExtraHTTPHeaders({
      'accept-language': 'en-US,en;q=0.9',
    })
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
      window.chrome = { runtime: {} }
    })

    await page.setRequestInterception(true)
    page.on('request', (request) => {
      const type = request.resourceType()
      if (type === 'image' || type === 'font' || type === 'media') {
        request.abort()
        return
      }
      request.continue()
    })

    let collected = []
    const seenOffsets = new Set()

    page.on('response', async (response) => {
      try {
        const responseUrl = response.url()
        if (!responseUrl.includes('/data/showcase/')) return
        if (profileId && !responseUrl.includes(profileId)) return
        if (!response.ok()) return

        const contentType = response.headers()?.['content-type'] || ''
        if (!contentType.includes('application/json')) return

        const offsetParam = new URL(responseUrl).searchParams.get('offset')
        if (offsetParam && seenOffsets.has(offsetParam)) return
        if (offsetParam) seenOffsets.add(offsetParam)

        const payload = await response.json()
        const products = Array.isArray(payload?.products)
          ? payload.products
          : Array.isArray(payload?.data?.products)
            ? payload.data.products
            : null
        if (!Array.isArray(products)) return
        collected.push(...products)
      } catch {
        // ignore response parsing errors
      }
    })

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await delay(2000)

    let pageApiItems = []
    if (profileId) {
      const pageHeaders = buildCollectrPageHeaders()
      const forcedUsername =
        process.env.COLLECTR_USERNAME || process.env.COLLECTR_ANON_USERNAME || null
      const filters =
        process.env.COLLECTR_FILTERS !== undefined
          ? process.env.COLLECTR_FILTERS
          : collectionId
            ? ''
            : null
      pageApiItems = await fetchCollectrItemsViaPageApi(
        page,
        profileId,
        pageHeaders,
        forcedUsername,
        collectionId,
        filters,
      )
      if (pageApiItems.length) {
        mergeCollectrItems(collected, pageApiItems)
      }
    }

    const scrollEnv = (process.env.COLLECTR_SCROLL || '').toLowerCase()
    let enableScroll = !(
      scrollEnv === '0' || scrollEnv === 'false' || scrollEnv === 'no'
    )
    if (pageApiItems.length && pageApiItems.length < 30) enableScroll = false
    const maxScrolls = 60
    const scrollDelayMs = 1200
    const maxIdleRounds = 4
    let idleRounds = 0
    let lastCount = collected.length
    let lastDomCount = 0

    const getDomCount = async () => {
      try {
        return await page.evaluate(() => {
          const selectors = [
            'span.mt-3.text-lg.mb-1.leading-tight.font-bold.line-clamp-2.text-card-foreground',
            'span.place-self-start.my-auto.text-base.sm\\:text-lg.font-bold.line-clamp-2',
          ]
          const nodes = selectors.flatMap((selector) =>
            Array.from(document.querySelectorAll(selector)),
          )
          return nodes.length
        })
      } catch {
        return 0
      }
    }

    lastDomCount = await getDomCount()

    if (enableScroll) {
      for (let i = 0; i < maxScrolls && idleRounds < maxIdleRounds; i += 1) {
        await page.evaluate(() => {
          const candidates = Array.from(document.querySelectorAll('*')).filter(
            (el) => {
              const style = window.getComputedStyle(el)
              const overflowY = style.overflowY
              return (
                (overflowY === 'auto' || overflowY === 'scroll') &&
                el.scrollHeight > el.clientHeight
              )
            },
          )
          const target = candidates.sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
          if (target) {
            target.scrollTop = target.scrollHeight
          } else {
            window.scrollTo(0, document.body.scrollHeight)
          }
        })
        await delay(scrollDelayMs)
        try {
          if (typeof page.waitForNetworkIdle === 'function') {
            await page.waitForNetworkIdle({ idleTime: 1000, timeout: 10000 })
          }
        } catch {
          // ignore network idle timeouts
        }

        const currentCount = collected.length
        const domCount = await getDomCount()
        if (currentCount === lastCount && domCount === lastDomCount) {
          idleRounds += 1
        } else {
          idleRounds = 0
          lastCount = currentCount
          lastDomCount = domCount
        }
      }
    }

    await delay(1000)

    let domItems = []
    try {
      const payload = await page.evaluate(() => {
        const text = (value) => {
          if (!value) return null
          const raw = value.textContent || ''
          const trimmed = raw.replace(/\s+/g, ' ').trim()
          return trimmed || null
        }
        const nameSelectors = [
          'span.mt-3.text-lg.mb-1.leading-tight.font-bold.line-clamp-2.text-card-foreground',
          'span.place-self-start.my-auto.text-base.sm\\:text-lg.font-bold.line-clamp-2',
        ]
        const nameNodes = nameSelectors.flatMap((selector) =>
          Array.from(document.querySelectorAll(selector)),
        )
        const uniqueNodes = Array.from(new Set(nameNodes))
        const items = []
        const seenCards = new Set()

        const findCardRoot = (node) => {
          let current = node
          for (let i = 0; i < 14 && current; i += 1) {
            if (current.matches?.('[data-slot="card"]')) return current
            const hasSet = current.querySelector?.('span.underline.text-muted-foreground')
            const hasNumberBlock =
              current.querySelector?.(
                'div.flex.flex-row.flex-wrap.items-center.space-x-1.text-muted-foreground',
              ) ||
              current.querySelector?.(
                'div.flex.flex-col.text-xs.sm\\:text-sm.text-muted-foreground',
              )
            const hasNumberText = Array.from(
              current.querySelectorAll?.('span') || [],
            ).some((span) => looksLikeNumber(text(span)))
            if (hasSet && (hasNumberBlock || hasNumberText)) return current
            current = current.parentElement
          }
          return (
            node.closest?.('[data-slot="card"]') ||
            node.closest?.('article') ||
            node.parentElement
          )
        }

        const looksLikeNumber = (value) => {
          if (!value) return false
          const raw = String(value).trim()
          if (!raw) return false
          if (raw.includes('.')) return false
          return /([A-Z]{1,4}\d{1,4}(?:\/\d{1,4})?|\d{1,4}\/\d{1,4}|\d{1,4})/i.test(
            raw,
          )
        }

        const pickNumber = (values) => {
          if (!Array.isArray(values) || !values.length) return null
          const normalized = values
            .map((value) => (value ? String(value).trim() : ''))
            .filter(Boolean)
          if (!normalized.length) return null
          const slashMatch = normalized.find((value) =>
            /[A-Z0-9]{0,4}\d{1,4}\/\d{1,4}/i.test(value),
          )
          if (slashMatch) return slashMatch
          const alphaMatch = normalized.find((value) =>
            /^[A-Z]{1,4}\d{1,4}$/i.test(value),
          )
          if (alphaMatch) return alphaMatch
          const numericMatch = normalized.find((value) => /^\d{1,4}$/.test(value))
          return numericMatch || null
        }

        const extractNumberFromText = (rawText) => {
          if (!rawText) return null
          const textValue = String(rawText).replace(/\s+/g, ' ').trim()
          if (!textValue) return null
          const slashMatch = textValue.match(/[A-Z0-9]{0,4}\d{1,4}\/\d{1,4}/i)
          if (slashMatch) return slashMatch[0]
          const alphaMatch = textValue.match(/[A-Z]{1,4}\d{1,4}/i)
          if (alphaMatch) return alphaMatch[0]
          const hashMatch = textValue.match(/#\s*(\d{1,4})\b/)
          if (hashMatch) return hashMatch[1]
          return null
        }

        uniqueNodes.forEach((nameNode) => {
          const card = findCardRoot(nameNode)
          if (!card) return
          if (seenCards.has(card)) return
          seenCards.add(card)

          const name = text(nameNode)
          const setEl = card.querySelector('span.underline.text-muted-foreground')
          const setName = text(setEl)

          const numberContainerSelectors = [
            'div.flex.flex-row.flex-wrap.items-center.space-x-1.text-muted-foreground',
            'div.flex.flex-col.text-xs.sm\\:text-sm.text-muted-foreground',
          ]
          let numberDiv = null
          for (const selector of numberContainerSelectors) {
            const found = card.querySelector(selector)
            if (found) {
              numberDiv = found
              break
            }
          }

          let cardNumber = null
          let rarity = null
          if (numberDiv) {
            const spans = Array.from(numberDiv.querySelectorAll('span'))
            const values = spans.map((span) => text(span)).filter(Boolean)
            cardNumber = pickNumber(values)
            const bulletIndex = values.indexOf(String.fromCharCode(8226))
            if (bulletIndex > 0) {
              rarity = values[bulletIndex - 1] || null
            }
          }

          if (!cardNumber) {
            const spanCandidates = Array.from(card.querySelectorAll('span'))
            const values = spanCandidates.map((span) => text(span)).filter(Boolean)
            cardNumber = pickNumber(values)
          }

          if (!cardNumber) {
            cardNumber = extractNumberFromText(card.textContent || '')
          }

          let imageUrl =
            card.querySelector('img[src*="public-assets/products/product_"]')?.getAttribute('src') ||
            card.querySelector('img[src*="product_"]')?.getAttribute('src') ||
            ''
          imageUrl = imageUrl || ''
          const match = imageUrl.match(/product_(\d+)/)
          const productId = match ? match[1] : null

          let quantity = null
          const qtyNode = Array.from(card.querySelectorAll('span, p, div')).find((el) =>
            /Qty\s*:/i.test(el.textContent || ''),
          )
          if (qtyNode) {
            const qtyMatch = qtyNode.textContent.match(/Qty\s*:\s*(\d+)/i)
            if (qtyMatch) quantity = qtyMatch[1]
          }

          const graded = card.querySelectorAll('div.animate-in img').length >= 2

          if (!name && !setName && !cardNumber && !imageUrl) return

          items.push({
            product_id: productId,
            image_url: imageUrl,
            product_name: name,
            catalog_group: setName,
            card_number: cardNumber,
            rarity,
            quantity: quantity || '1',
            grade_id: graded ? '1' : null,
          })
        })

        return { items }
      })
      domItems = payload?.items || []
    } catch {
      domItems = []
    }

    if (domItems.length) {
      mergeCollectrItems(collected, domItems)
    }

    const html = await page.content()
    const extracted = extractCollectrItemsFromHtml(html)
    if (extracted.items.length) {
      mergeCollectrItems(collected, extracted.items)
    }

    const deduped = []
    if (collected.length) {
      mergeCollectrItems(deduped, collected)
    }
    if (deduped.length) return deduped
    if (extracted.items.length) return extracted.items
    return deduped
  } finally {
    await browser.close()
  }
}

export async function runCollectrImport({ url, supabaseUrl, supabaseKey }) {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase env vars are missing.')
  }
  if (!url) {
    throw new Error('Missing Collectr URL.')
  }

  let parsedUrl
  try {
    parsedUrl = new URL(url)
  } catch {
    throw new Error('Invalid Collectr URL.')
  }

  if (parsedUrl.hostname !== 'app.getcollectr.com') {
    throw new Error('URL must be a app.getcollectr.com link.')
  }

  const profileId = getCollectrProfileId(parsedUrl)
  if (!profileId) {
    throw new Error('URL must point to a Collectr profile page.')
  }

  const collectionId = getCollectrCollectionId(parsedUrl)
  const collectionFilters =
    process.env.COLLECTR_FILTERS !== undefined
      ? process.env.COLLECTR_FILTERS
      : collectionId
        ? ''
        : null

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  })

  const { data: englishSetRows, error: englishSetErr } = await supabase
    .from('pokemon_sets')
    .select('id, name, name_other')
  if (englishSetErr) throw englishSetErr

  const { data: japanSetRows, error: japanSetErr } = await supabase
    .from('pokemon_japan_sets')
    .select('id, name, name_other')
  if (japanSetErr) throw japanSetErr

  const buildSetMap = (rows) => {
    const map = new Map()
    const add = (row, name) => {
      const normalized = normalizeName(name)
      if (!normalized) return
      const list = map.get(normalized) || []
      list.push(row)
      map.set(normalized, list)
    }
    for (const row of rows || []) {
      add(row, row.name)
      if (row.name_other) add(row, row.name_other)
      const colonMatch = row.name.match(/^([A-Z0-9]{2,6})\\s*:\\s*(.+)$/i)
      if (colonMatch) add(row, colonMatch[2])
      const dashMatch = row.name.match(/^([A-Z0-9]{2,6})\\s*-\\s*(.+)$/i)
      if (dashMatch) add(row, dashMatch[2])
    }
    return map
  }

  const englishSetMap = buildSetMap(englishSetRows || [])
  const japanSetMap = buildSetMap(japanSetRows || [])

  let collectrItems = []
  let collections = []
  let totalCollectr = 0
  let htmlCardNumberLookup = null

  if (process.env.COLLECTR_USE_API !== '0') {
    try {
      const initialResult = await fetchCollectrItemsViaApi(
        profileId,
        collectionId,
        collectionFilters,
      )
      collections = Array.isArray(initialResult.collections)
        ? initialResult.collections
        : []
      if (collections.length) {
        const loopFilters =
          process.env.COLLECTR_FILTERS !== undefined ? process.env.COLLECTR_FILTERS : ''
        collectrItems = []
        for (const collection of collections) {
          const nextResult = await fetchCollectrItemsViaApi(
            profileId,
            collection.id,
            loopFilters,
          )
          const items = nextResult.items || []
          tagItemsWithCollection(items, collection)
          collectrItems.push(...items)
        }
      } else {
        collectrItems = initialResult.items || []
      }
      totalCollectr = collectrItems.length
    } catch {
      collectrItems = []
      totalCollectr = 0
    }
  }

  if (!collectrItems.length && process.env.COLLECTR_USE_BROWSER !== '0') {
    try {
      collectrItems = await fetchCollectrItemsViaBrowser(
        parsedUrl.toString(),
        profileId,
        collectionId,
      )
      totalCollectr = collectrItems.length
    } catch (err) {
      collectrItems = []
      totalCollectr = 0
    }
  }

  if (collectrItems.length) {
    const missingCardNumbers = collectrItems.some((item) => {
      const cardNumber =
        item?.card_number ??
        item?.cardNumber ??
        item?.collector_number ??
        item?.collectorNumber ??
        item?.number ??
        item?.card_no ??
        item?.cardNo ??
        item?.num ??
        null
      return !cardNumber
    })
    if (missingCardNumbers) {
      try {
        const response = await fetch(parsedUrl.toString(), {
          headers: buildCollectrApiHeaders(),
        })
        if (response.ok) {
          const html = await response.text()
          const extracted = extractCollectrItemsFromHtml(html)
          if (extracted.items.length) {
            mergeCollectrItems(collectrItems, extracted.items)
            totalCollectr = Math.max(
              totalCollectr,
              extracted.totalBlocks || extracted.items.length,
            )
            const lookup = new Map()
            extracted.items.forEach((item) => {
              const key = buildNameSetKey(item.catalog_group, item.product_name)
              const number = item.card_number
              if (key && number && !lookup.has(key)) lookup.set(key, number)
            })
            if (lookup.size) htmlCardNumberLookup = lookup
          }
        }
      } catch {
        // ignore html enrichment errors
      }
    }
  }

  if (!collectrItems.length) {
    const response = await fetch(parsedUrl.toString(), {
      headers: buildCollectrApiHeaders(),
    })
    if (!response.ok) {
      throw new Error(`Failed to fetch ${response.status}`)
    }
    const html = await response.text()
    if (!html || html.trim().length < 1000) {
      throw new Error(
        'Collectr returned empty HTML. The site may be blocking automated requests. Try setting COLLECTR_HEADLESS=0.',
      )
    }
    const extracted = extractCollectrItemsFromHtml(html)
    collectrItems = extracted.items
    totalCollectr = extracted.totalBlocks || collectrItems.length
    if (extracted.items.length) {
      const lookup = new Map()
      extracted.items.forEach((item) => {
        const key = buildNameSetKey(item.catalog_group, item.product_name)
        const number = item.card_number
        if (key && number && !lookup.has(key)) lookup.set(key, number)
      })
      if (lookup.size) htmlCardNumberLookup = lookup
    }
    if (!collectrItems.length) {
      throw new Error(
        'No items found in Collectr HTML. The site may be blocking automated requests. Try setting COLLECTR_HEADLESS=0.',
      )
    }
  }

  const productMap = new Map()
  const missingMap = new Map()
  let skippedGraded = 0
  for (const item of collectrItems) {
    const normalized = normalizeCollectrItem(item)
    if (!normalized) continue

    const {
      productId,
      quantity,
      collectrName,
      collectrImageUrl,
      setName,
      collectionId: itemCollectionId,
      collectionName: itemCollectionName,
      gradeCompany,
      gradeId,
      isCard,
      cardNumber,
      rarity,
    } = normalized
    const collectionKey = buildCollectionKey(itemCollectionId, itemCollectionName)

    const setStatus = getSetStatus(setName, englishSetMap, japanSetMap)
    if (setStatus.isJapanese) {
      console.log(
        '[collectr-japan-scrape]',
        JSON.stringify(
          {
            productId,
            quantity,
            setName,
            collectrName,
            cardNumber,
            rarity,
            collectrImageUrl,
            gradeCompany,
            gradeId,
            isCard,
            collectionId: itemCollectionId,
            collectionName: itemCollectionName,
          },
          null,
          2,
        ),
      )
    }

    if (isCollectrGraded({ gradeCompany, gradeId, isCard })) {
      skippedGraded += 1
      continue
    }

    if (!productId) {
      const matchKey = setStatus.isJapanese
        ? buildJapanItemKey(setName, cardNumber, collectrName)
        : buildMatchKey(setName, collectrName, cardNumber)
      const bucketKey =
        matchKey ||
        (setStatus.isJapanese
          ? buildJapanItemKey(setName, cardNumber, null)
          : buildLooseKey(setName, collectrName, cardNumber))
      const keyedBucket = `${collectionKey}|${bucketKey}`
      const current = missingMap.get(keyedBucket) || {
        productId: null,
        quantity: 0,
        setName,
        isJapanese: setStatus.isJapanese,
        collectrName: null,
        collectrImageUrl: null,
        cardNumber: null,
        rarity: null,
        matchKey,
        collectionId: itemCollectionId || null,
        collectionName: itemCollectionName || null,
        collectionKey,
      }
      current.quantity += quantity
      if (!current.setName && setName) current.setName = setName
      current.isJapanese = current.isJapanese || setStatus.isJapanese
      if (!current.collectrName && collectrName) current.collectrName = collectrName
      if (!current.collectrImageUrl && collectrImageUrl) {
        current.collectrImageUrl = collectrImageUrl
      }
      if (!current.cardNumber && cardNumber) current.cardNumber = cardNumber
      if (!current.rarity && rarity) current.rarity = rarity
      current.matchKey = current.matchKey || matchKey
      missingMap.set(keyedBucket, current)
      continue
    }

    const productKey = `${collectionKey}|${productId}`
    const current = productMap.get(productKey) || {
      productId,
      quantity: 0,
      setName,
      isJapanese: setStatus.isJapanese,
      collectrName: null,
      collectrImageUrl: null,
      cardNumber: null,
      rarity: null,
      collectionId: itemCollectionId || null,
      collectionName: itemCollectionName || null,
      collectionKey,
    }
    current.quantity += quantity
    if (!current.setName && setName) current.setName = setName
    current.isJapanese = current.isJapanese || setStatus.isJapanese
    if (!current.collectrName && collectrName) current.collectrName = collectrName
    if (!current.collectrImageUrl && collectrImageUrl) {
      current.collectrImageUrl = collectrImageUrl
    }
    if (!current.cardNumber && cardNumber) current.cardNumber = cardNumber
    if (!current.rarity && rarity) current.rarity = rarity
    productMap.set(productKey, current)
  }

  const productEntries = Array.from(productMap.values())
  const missingItems = Array.from(missingMap.values())
  const englishIdSet = new Set()
  const japanIdSet = new Set()
  for (const entry of productEntries) {
    if (!entry?.productId) continue
    if (entry?.isJapanese) {
      japanIdSet.add(entry.productId)
    } else {
      englishIdSet.add(entry.productId)
    }
  }
  const englishIds = Array.from(englishIdSet)
  const japanIds = Array.from(japanIdSet)
  const productIds = Array.from(new Set([...englishIds, ...japanIds]))

  const getEmbedSelect = (embedKey) => {
    if (embedKey === 'pokemon_japan_sets') {
      return `${embedKey}(id, name, name_other, code)`
    }
    return `${embedKey}(id, name, code)`
  }

  const fetchProducts = async (ids, table, embedKey) => {
    const rows = []
    const groups = chunk(ids, 400)
    const embedSelect = getEmbedSelect(embedKey)
    for (const group of groups) {
      const { data, error } = await supabase
        .from(table)
        .select(
          `tcg_product_id, name, product_type, card_number, rarity, image_url, market_price, ${embedSelect}`,
        )
        .in('tcg_product_id', group)
      if (error) throw error
      if (data) rows.push(...data)
    }
    return rows
  }

  const fetchProductsBySetIds = async (setIds, table, embedKey) => {
    const rows = []
    const groups = chunk(setIds, 200)
    const embedSelect = getEmbedSelect(embedKey)
    for (const group of groups) {
      const { data, error } = await supabase
        .from(table)
        .select(
          `tcg_product_id, set_id, name, product_type, card_number, rarity, image_url, market_price, ${embedSelect}`,
        )
        .in('set_id', group)
      if (error) throw error
      if (data) rows.push(...data)
    }
    return rows
  }

  const englishRows = englishIds.length
    ? await fetchProducts(englishIds, 'pokemon_products', 'pokemon_sets')
    : []
  const japanRows = japanIds.length
    ? await fetchProducts(japanIds, 'pokemon_japan_products', 'pokemon_japan_sets')
    : []

  const englishLookup = new Map(
    englishRows.map((row) => [row.tcg_product_id, row]),
  )
  const japanLookup = new Map(
    japanRows.map((row) => [row.tcg_product_id, row]),
  )

  const matchMissingItems = async (
    items,
    setMap,
    table,
    embedKey,
    allowPartial = false,
  ) => {
    if (!items.length) return new Map()
    const setIds = new Set()
    const itemSetIds = new Map()
    items.forEach((item) => {
      const rows = findSetRowsByName(item.setName, setMap, allowPartial)
      const ids = rows.map((row) => row.id)
      if (ids.length) {
        itemSetIds.set(item, ids)
        ids.forEach((id) => setIds.add(id))
      }
    })
    const ids = Array.from(setIds)
    if (!ids.length) return new Map()

    const rows = await fetchProductsBySetIds(ids, table, embedKey)
    const index = new Map()
    rows.forEach((row) => {
      const numberKey = normalizeCardNumberForMatch(row?.card_number)
      if (!row?.set_id || !numberKey) return
      const key = `${row.set_id}|${numberKey}`
      const list = index.get(key) || []
      list.push(row)
      index.set(key, list)
    })

    const lookup = new Map()
    items.forEach((item) => {
      const baseKey =
        buildMatchKey(item.setName, item.collectrName, item.cardNumber) ||
        buildLooseKey(item.setName, item.collectrName, item.cardNumber)
      if (!baseKey || !baseKey.replace(/\|/g, '').trim()) return
      const collectionKey =
        item.collectionKey ||
        buildCollectionKey(item.collectionId, item.collectionName)
      const itemKey = `${collectionKey}|${baseKey}`
      const numberKey = normalizeCardNumberForMatch(item.cardNumber)
      const idsForItem = itemSetIds.get(item) || []
      let matched = null
      if (numberKey && idsForItem.length) {
        for (const setId of idsForItem) {
          const list = index.get(`${setId}|${numberKey}`) || []
          if (!list.length) continue
          if (item.collectrName) {
            matched = list.find((row) =>
              compareNamesLike(row?.name, item.collectrName),
            )
          }
          if (!matched) matched = list[0]
          if (matched) break
        }
      }
      if (matched) lookup.set(itemKey, matched)
    })

    return lookup
  }

  const matchJapaneseMissingItems = async (items) => {
    if (!items.length) return new Map()
    const lookup = new Map()

    for (const item of items) {
      const collectrSet = item.setName || null
      const collectrName = item.collectrName || null
      const rawCardNumber =
        typeof item.cardNumber === 'string'
          ? item.cardNumber.trim()
          : item.cardNumber ?? null

      if (!collectrSet || !rawCardNumber) {
        item.japaneseChecks = {
          set_match: !!collectrSet,
          card_number_match: !!rawCardNumber,
          name_match: collectrName ? false : null,
        }
        continue
      }

      let query = supabase
        .from('pokemon_japan_products')
        .select(
          'tcg_product_id, set_id, name, product_type, card_number, rarity, image_url, market_price, pokemon_japan_sets(id, name, name_other, code)',
        )
        .eq('card_number', rawCardNumber)

      if (collectrName) {
        query = query.ilike('name', `%${collectrName}%`)
      }
      if (collectrSet) {
        query = query.or(
          `name.ilike.%${collectrSet}%,name_other.ilike.%${collectrSet}%`,
          { foreignTable: 'pokemon_japan_sets' },
        )
      }

      const { data, error } = await query.limit(5)
      if (error) throw error

      const product = Array.isArray(data) ? data[0] ?? null : null
      const embedded = product?.pokemon_japan_sets ?? null
      const setEmbed = Array.isArray(embedded) ? embedded[0] ?? null : embedded ?? null
      const productSet = setEmbed?.name ?? null
      const productSetOther = setEmbed?.name_other ?? null

      const checks = buildJapanChecksFromProduct({
        collectrSet,
        collectrNumber: rawCardNumber,
        collectrName,
        productName: product?.name ?? null,
        productSet,
        productSetOther,
        productNumber: product?.card_number ?? null,
      })
      item.japaneseChecks = checks

      const itemKey =
        item.matchKey ||
        buildJapanItemKey(collectrSet, rawCardNumber, collectrName)
      if (!itemKey) continue
      const collectionKey =
        item.collectionKey ||
        buildCollectionKey(item.collectionId, item.collectionName)
      lookup.set(`${collectionKey}|${itemKey}`, { product, checks })
    }

    return lookup
  }

  const missingEnglish = missingItems.filter((item) => !item.isJapanese)
  const missingJapan = missingItems.filter((item) => item.isJapanese)
  const fallbackJapanItems = []
  productEntries.forEach((collectr) => {
    if (!collectr?.isJapanese) return
    if (japanLookup.has(collectr.productId)) return
    const matchKey =
      buildJapanItemKey(collectr.setName, collectr.cardNumber, collectr.collectrName) ||
      buildLooseKey(collectr.setName, collectr.collectrName, collectr.cardNumber)
    if (!matchKey) return
    fallbackJapanItems.push({
      setName: collectr.setName,
      collectrName: collectr.collectrName,
      cardNumber: collectr.cardNumber,
      matchKey,
      collectionId: collectr.collectionId || null,
      collectionName: collectr.collectionName || null,
      collectionKey: collectr.collectionKey || buildCollectionKey(collectr.collectionId, collectr.collectionName),
    })
  })
  const missingEnglishLookup = await matchMissingItems(
    missingEnglish,
    englishSetMap,
    'pokemon_products',
    'pokemon_sets',
    true,
  )
  const missingJapanLookup = await matchJapaneseMissingItems([
    ...missingJapan,
    ...fallbackJapanItems,
  ])

  const results = []

  productEntries.forEach((collectr) => {
    const isJapanese = collectr?.isJapanese
    let product =
      (isJapanese ? japanLookup : englishLookup).get(collectr.productId) || null
    const collectrSet = collectr.setName || null
    let japaneseChecks = null
    if (isJapanese) {
      if (!product) {
        const matchKey =
          buildJapanItemKey(
            collectrSet,
            collectr?.cardNumber ?? null,
            collectr?.collectrName ?? null,
          ) ||
          buildLooseKey(collectrSet, collectr?.collectrName, collectr?.cardNumber)
        const collectionKey =
          collectr.collectionKey ||
          buildCollectionKey(collectr.collectionId, collectr.collectionName)
        const fallback = matchKey
          ? missingJapanLookup.get(`${collectionKey}|${matchKey}`) || null
          : null
        if (fallback?.product) {
          product = fallback.product
          const embeddedFallback = product?.pokemon_japan_sets ?? null
          const setFallback = Array.isArray(embeddedFallback)
            ? embeddedFallback[0] ?? null
            : embeddedFallback ?? null
          const fallbackSetName = setFallback?.name ?? null
          const fallbackSetOther = setFallback?.name_other ?? null
          japaneseChecks = fallback.checks ?? null
          if (!japaneseChecks) {
            japaneseChecks = buildJapanChecksFromProduct({
              collectrSet,
              collectrNumber: collectr?.cardNumber ?? null,
              collectrName: collectr?.collectrName ?? null,
              productName: product?.name ?? null,
              productSet: fallbackSetName,
              productSetOther: fallbackSetOther,
              productNumber: product?.card_number ?? null,
            })
          }
        }
      }

      if (!japaneseChecks) {
        const embeddedCurrent = product?.pokemon_japan_sets ?? null
        const setCurrent = Array.isArray(embeddedCurrent)
          ? embeddedCurrent[0] ?? null
          : embeddedCurrent ?? null
        const currentSetName = setCurrent?.name ?? null
        const currentSetOther = setCurrent?.name_other ?? null
        japaneseChecks = buildJapanChecksFromProduct({
          collectrSet,
          collectrNumber: collectr?.cardNumber ?? null,
          collectrName: collectr?.collectrName ?? null,
          productName: product?.name ?? null,
          productSet: currentSetName,
          productSetOther: currentSetOther,
          productNumber: product?.card_number ?? null,
        })
      }
    }
    const embedded = isJapanese ? product?.pokemon_japan_sets : product?.pokemon_sets
    const setEmbed = Array.isArray(embedded) ? embedded[0] ?? null : embedded ?? null
    const productSet = setEmbed?.name ?? null
    results.push({
      tcg_product_id: collectr.productId,
      quantity: collectr.quantity,
      collectr_collection_id: collectr.collectionId || null,
      collectr_collection_name: collectr.collectionName || null,
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
      japanese_checks: japaneseChecks,
    })
  })

  missingItems.forEach((collectr) => {
    const isJapanese = collectr?.isJapanese
    const lookup = isJapanese ? missingJapanLookup : missingEnglishLookup
    const collectionKey =
      collectr.collectionKey ||
      buildCollectionKey(collectr.collectionId, collectr.collectionName)
    const matchKey =
      collectr.matchKey ||
      (isJapanese
        ? buildJapanItemKey(
            collectr.setName,
            collectr.cardNumber,
            collectr.collectrName,
          )
        : buildMatchKey(
            collectr.setName,
            collectr.collectrName,
            collectr.cardNumber,
          ))
    const lookupKey = matchKey ? `${collectionKey}|${matchKey}` : null
    const matchInfo = isJapanese && lookupKey ? lookup.get(lookupKey) || null : null
    const product = isJapanese
      ? matchInfo?.product || null
      : lookupKey
        ? lookup.get(lookupKey) || null
        : null
    const embedded = isJapanese ? product?.pokemon_japan_sets : product?.pokemon_sets
    const setEmbed = Array.isArray(embedded) ? embedded[0] ?? null : embedded ?? null
    const collectrSet = collectr.setName || null
    const productSet = setEmbed?.name ?? null
    const japaneseChecks = isJapanese
      ? matchInfo?.checks ?? collectr?.japaneseChecks ?? null
      : null
    results.push({
      tcg_product_id: product?.tcg_product_id ?? null,
      quantity: collectr.quantity,
      collectr_collection_id: collectr.collectionId || null,
      collectr_collection_name: collectr.collectionName || null,
      collectr_set: collectrSet,
      collectr_name: collectr.collectrName || null,
      collectr_image_url: collectr.collectrImageUrl || null,
      matched: !!product,
      name: product?.name ?? collectr.collectrName ?? null,
      set: productSet ?? null,
      code: setEmbed?.code ?? null,
      product_type: product?.product_type ?? null,
      card_number: product?.card_number ?? collectr.cardNumber ?? null,
      rarity: product?.rarity ?? collectr.rarity ?? null,
      image_url: product?.image_url ?? null,
      market_price: product?.market_price ?? null,
      japanese_checks: japaneseChecks,
    })
  })

  let cardNumberLookup = htmlCardNumberLookup
  if (
    (!cardNumberLookup || !cardNumberLookup.size) &&
    results.some((row) => !row.card_number)
  ) {
    try {
      const response = await fetch(parsedUrl.toString(), {
        headers: buildCollectrApiHeaders(),
      })
      if (response.ok) {
        const html = await response.text()
        const extracted = extractCollectrItemsFromHtml(html)
        if (extracted.items.length) {
          const lookup = new Map()
          extracted.items.forEach((item) => {
            const key = buildNameSetKey(item.catalog_group, item.product_name)
            const number = item.card_number
            if (key && number && !lookup.has(key)) lookup.set(key, number)
          })
          if (lookup.size) cardNumberLookup = lookup
        }
      }
    } catch {
      // ignore html fill errors
    }
  }

  if (cardNumberLookup && cardNumberLookup.size) {
    results.forEach((row) => {
      if (row.card_number) return
      const key = buildNameSetKey(
        row.collectr_set || row.set,
        row.collectr_name || row.name,
      )
      const number = key ? cardNumberLookup.get(key) : null
      if (number) row.card_number = number
    })
  }

  const summary = {
    totalCollectr,
    parsedProducts: productEntries.length + missingItems.length,
    matchedProducts: results.filter((r) => r.matched).length,
    skippedGraded,
  }

  return { summary, results, collections }
}





