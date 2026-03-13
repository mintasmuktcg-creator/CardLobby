import {
  buildCollectionKey,
  buildJapanChecksFromProduct,
  buildJapanItemKey,
  buildLooseKey,
  buildMatchKey,
  chunk,
  compareNamesLike,
  findSetRowsByName,
  getSetStatus,
  isCollectrGraded,
  normalizeCardNumberForMatch,
  normalizeCollectrItem,
} from './shared.mjs'

const CARDHQ_DEFAULT_BASE_URL = 'https://api.cardlobby.app'
const CARDHQ_PRODUCT_PAGE_SIZE = 500
const CARDHQ_TIMEOUT_MS = (() => {
  const raw = Number(process.env.CARDHQ_API_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 15000
})()

const CARDHQ_PRODUCT_LINE_BY_REGION = {
  EN: 3,
  JP: 85,
}

const CONDITION_RANK = new Map([
  ['near mint', 0],
  ['lightly played', 1],
  ['moderately played', 2],
  ['heavily played', 3],
  ['damaged', 4],
])

const PRINTING_RANK = new Map([
  ['normal', 0],
  ['holofoil', 1],
  ['reverse holofoil', 2],
])

const normalizeRegion = (value) => {
  const normalized = String(value || '').trim().toUpperCase()
  return normalized === 'JP' ? 'JP' : 'EN'
}

const toPositiveInt = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  const parsed = Math.floor(number)
  return parsed > 0 ? parsed : null
}

const toRank = (value, rankMap) => {
  if (!value) return 99
  const normalized = String(value).trim().toLowerCase()
  if (!normalized) return 99
  return rankMap.get(normalized) ?? 50
}

const toComparablePrice = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : Number.POSITIVE_INFINITY
}

const normalizeBaseUrl = (value) => {
  const raw = String(value || CARDHQ_DEFAULT_BASE_URL).trim()
  if (!raw) return CARDHQ_DEFAULT_BASE_URL
  return raw.replace(/\/+$/, '')
}

const resolveCardhqConfig = ({ cardhqBaseUrl, cardhqApiKey } = {}) => {
  const baseUrl = normalizeBaseUrl(cardhqBaseUrl || process.env.CARDHQ_API_BASE_URL)
  const apiKey = String(
    cardhqApiKey || process.env.CARDHQ_API_KEY || process.env.CARDHQ_ADMIN_API_KEY || '',
  ).trim()

  if (!apiKey) {
    throw new Error('CARDHQ_API_KEY is required for Collectr importer matching.')
  }

  return {
    baseUrl,
    apiKey,
    timeoutMs: CARDHQ_TIMEOUT_MS,
  }
}

const fetchCardhqPage = async ({ config, pathname, searchParams }) => {
  const url = new URL(pathname, `${config.baseUrl}/`)
  url.search = searchParams.toString()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)

  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'x-api-key': config.apiKey,
      },
      signal: controller.signal,
    })

    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const message =
        payload && typeof payload === 'object' && typeof payload.error === 'string'
          ? payload.error
          : `CardHQ request failed (${response.status})`
      throw new Error(message)
    }

    return payload
  } finally {
    clearTimeout(timer)
  }
}

const fetchCardhqRows = async ({ config, pathname, baseParams = {} }) => {
  const out = []
  let offset = 0

  while (true) {
    const params = new URLSearchParams()
    Object.entries(baseParams).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return
      params.set(key, String(value))
    })
    params.set('limit', String(CARDHQ_PRODUCT_PAGE_SIZE))
    params.set('offset', String(offset))

    const payload = await fetchCardhqPage({ config, pathname, searchParams: params })
    const rows = Array.isArray(payload) ? payload : []
    if (!rows.length) break

    out.push(...rows)
    if (rows.length < CARDHQ_PRODUCT_PAGE_SIZE) break
    offset += CARDHQ_PRODUCT_PAGE_SIZE
  }

  return out
}

const mapSetRow = (row, region) => ({
  id: toPositiveInt(row?.set_name_id) || row?.set_name_id || null,
  name: String(row?.name || '').trim(),
  name_other:
    String(row?.name_other ?? row?.other_name ?? '')
      .trim() || null,
  code: row?.abbreviation ?? null,
  region,
})

const fetchSetRowsByRegion = async ({ config, region }) => {
  const productLineId = CARDHQ_PRODUCT_LINE_BY_REGION[normalizeRegion(region)]
  const rows = await fetchCardhqRows({
    config,
    pathname: '/sets',
    baseParams: {
      product_line_id: productLineId,
    },
  })

  return rows
    .map((row) => mapSetRow(row, normalizeRegion(region)))
    .filter((row) => row.id && row.name)
}

export const fetchCardhqSetRows = async ({ cardhqBaseUrl, cardhqApiKey } = {}) => {
  const cardhqConfig = resolveCardhqConfig({ cardhqBaseUrl, cardhqApiKey })

  const [englishSetRows, japanSetRows] = await Promise.all([
    fetchSetRowsByRegion({ config: cardhqConfig, region: 'EN' }),
    fetchSetRowsByRegion({ config: cardhqConfig, region: 'JP' }),
  ])

  const setIdRegionMap = new Map()
  englishSetRows.forEach((row) => {
    if (row?.id) setIdRegionMap.set(String(row.id), 'EN')
  })
  japanSetRows.forEach((row) => {
    if (row?.id) setIdRegionMap.set(String(row.id), 'JP')
  })

  return {
    englishSetRows,
    japanSetRows,
    setIdRegionMap,
    cardhqConfig,
  }
}

const shouldPreferApiVariant = (candidate, current) => {
  const candidateConditionRank = toRank(candidate?.condition, CONDITION_RANK)
  const currentConditionRank = toRank(current?.condition, CONDITION_RANK)
  if (candidateConditionRank !== currentConditionRank) {
    return candidateConditionRank < currentConditionRank
  }

  const candidatePrintingRank = toRank(candidate?.printing, PRINTING_RANK)
  const currentPrintingRank = toRank(current?.printing, PRINTING_RANK)
  if (candidatePrintingRank !== currentPrintingRank) {
    return candidatePrintingRank < currentPrintingRank
  }

  const candidatePrice = toComparablePrice(candidate?.market_price)
  const currentPrice = toComparablePrice(current?.market_price)
  if (candidatePrice !== currentPrice) {
    return candidatePrice < currentPrice
  }

  return String(candidate?.image_url || '').length > String(current?.image_url || '').length
}

const shouldPreferNormalizedProduct = (candidate, current) => {
  if (!current) return true
  const candidatePrice = toComparablePrice(candidate?.market_price)
  const currentPrice = toComparablePrice(current?.market_price)
  if (candidatePrice !== currentPrice) {
    return candidatePrice < currentPrice
  }
  return String(candidate?.image_url || '').length > String(current?.image_url || '').length
}

const inferProductType = (cardNumber) => {
  const raw = String(cardNumber || '').trim()
  if (!raw) return null
  if (/^\d{1,4}(?:\/\d{1,4})?$/.test(raw)) return 'single'
  return null
}

const normalizeApiProductRow = ({ row, region }) => {
  const productId = toPositiveInt(row?.product_id)
  const setId = toPositiveInt(row?.set_name_id)
  if (!productId || !setId) return null

  return {
    tcg_product_id: productId,
    set_id: setId,
    name: row?.product_name ?? null,
    product_type: inferProductType(row?.number),
    card_number: row?.number ?? null,
    rarity: row?.rarity ?? null,
    image_url: row?.image_url ?? null,
    market_price: row?.market_price ?? null,
    pokemon_sets: {
      id: setId,
      name: row?.set_name ?? null,
      name_other: row?.set_name_other ?? row?.set_other_name ?? null,
      code: row?.set_abbreviation ?? null,
      region: normalizeRegion(region),
    },
  }
}

const getSetIdFromRow = (row) => {
  const setId = toPositiveInt(row?.set_name_id)
  return setId ? String(setId) : null
}

const getRowRegion = ({ row, setIdRegionMap, regionHint = null }) => {
  const setKey = getSetIdFromRow(row)
  if (setKey && setIdRegionMap.has(setKey)) {
    return normalizeRegion(setIdRegionMap.get(setKey))
  }
  if (regionHint) return normalizeRegion(regionHint)
  return null
}

const createApiState = ({ cardhqConfig, setIdRegionMap }) => ({
  cardhqConfig,
  setIdRegionMap,
  setProductsCache: {
    EN: new Map(),
    JP: new Map(),
  },
  productByRegionCache: new Map(),
})

const productCacheKey = (region, productId) => `${normalizeRegion(region)}|${productId}`

const cacheProductRow = ({ apiState, row, region }) => {
  if (!row?.tcg_product_id) return
  const key = productCacheKey(region, row.tcg_product_id)
  const current = apiState.productByRegionCache.get(key)
  if (!current || shouldPreferNormalizedProduct(row, current)) {
    apiState.productByRegionCache.set(key, row)
  }
}

const fetchSetProducts = async ({ apiState, setId, region }) => {
  const regionKey = normalizeRegion(region)
  const cache = apiState.setProductsCache[regionKey]
  const setKey = String(setId)
  if (cache.has(setKey)) {
    return cache.get(setKey)
  }

  const rows = await fetchCardhqRows({
    config: apiState.cardhqConfig,
    pathname: '/products',
    baseParams: {
      set_name_id: setId,
    },
  })

  const preferredByProductId = new Map()
  rows.forEach((row) => {
    const productId = toPositiveInt(row?.product_id)
    if (!productId) return
    const rowRegion = getRowRegion({ row, setIdRegionMap: apiState.setIdRegionMap, regionHint: regionKey })
    if (rowRegion && rowRegion !== regionKey) return
    const current = preferredByProductId.get(productId)
    if (!current || shouldPreferApiVariant(row, current)) {
      preferredByProductId.set(productId, row)
    }
  })

  const normalizedRows = Array.from(preferredByProductId.values())
    .map((row) => normalizeApiProductRow({ row, region: regionKey }))
    .filter((row) => !!row)

  normalizedRows.forEach((row) => cacheProductRow({ apiState, row, region: regionKey }))

  cache.set(setKey, normalizedRows)
  return normalizedRows
}

const fetchProductsBySetIds = async ({ apiState, setIds, region }) => {
  if (!setIds.length) return []
  const out = []
  const groups = chunk(setIds, 5)
  for (const group of groups) {
    const rows = await Promise.all(
      group.map((setId) => fetchSetProducts({ apiState, setId, region })),
    )
    rows.forEach((list) => {
      if (Array.isArray(list) && list.length) {
        out.push(...list)
      }
    })
  }
  return out
}

const fetchProductById = async ({ apiState, productId, region }) => {
  const regionKey = normalizeRegion(region)
  const key = productCacheKey(regionKey, productId)
  if (apiState.productByRegionCache.has(key)) {
    return apiState.productByRegionCache.get(key)
  }

  const rows = await fetchCardhqRows({
    config: apiState.cardhqConfig,
    pathname: '/products',
    baseParams: {
      product_id: productId,
    },
  })

  let bestRaw = null
  rows.forEach((row) => {
    const rowRegion = getRowRegion({ row, setIdRegionMap: apiState.setIdRegionMap })
    if (rowRegion && rowRegion !== regionKey) return
    if (!bestRaw || shouldPreferApiVariant(row, bestRaw)) {
      bestRaw = row
    }
  })

  if (!bestRaw) {
    apiState.productByRegionCache.set(key, null)
    return null
  }

  const normalized = normalizeApiProductRow({ row: bestRaw, region: regionKey })
  apiState.productByRegionCache.set(key, normalized)
  return normalized
}

const fetchProductsByIds = async ({ apiState, ids, region }) => {
  if (!ids.length) return []

  const uniqueIds = Array.from(
    new Set(ids.map((id) => toPositiveInt(id)).filter((id) => !!id)),
  )

  const out = []
  const missing = []
  uniqueIds.forEach((id) => {
    const key = productCacheKey(region, id)
    if (apiState.productByRegionCache.has(key)) {
      const cached = apiState.productByRegionCache.get(key)
      if (cached) out.push(cached)
      return
    }
    missing.push(id)
  })

  const groups = chunk(missing, 20)
  for (const group of groups) {
    const rows = await Promise.all(
      group.map((productId) => fetchProductById({ apiState, productId, region })),
    )
    rows.forEach((row) => {
      if (row) out.push(row)
    })
  }

  return out
}

export const buildCollectrBuckets = ({
  collectrItems,
  englishSetMap,
  japanSetMap,
}) => {
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

  return {
    productEntries: Array.from(productMap.values()),
    missingItems: Array.from(missingMap.values()),
    skippedGraded,
  }
}

const collectSetIdsForItems = (items, setMap, allowPartial = false) => {
  const ids = new Set()
  items.forEach((item) => {
    const rows = findSetRowsByName(item?.setName, setMap, allowPartial)
    rows.forEach((row) => {
      const id = toPositiveInt(row?.id)
      if (id) ids.add(id)
    })
  })
  return Array.from(ids)
}

const prefetchSetProductsForMatching = async ({
  apiState,
  productEntries,
  missingItems,
  englishSetMap,
  japanSetMap,
}) => {
  const englishItems = [
    ...productEntries.filter((item) => !item.isJapanese),
    ...missingItems.filter((item) => !item.isJapanese),
  ]
  const japaneseItems = [
    ...productEntries.filter((item) => item.isJapanese),
    ...missingItems.filter((item) => item.isJapanese),
  ]

  const englishSetIds = collectSetIdsForItems(englishItems, englishSetMap, true)
  const japaneseSetIds = collectSetIdsForItems(japaneseItems, japanSetMap, true)

  await Promise.all([
    fetchProductsBySetIds({ apiState, setIds: englishSetIds, region: 'EN' }),
    fetchProductsBySetIds({ apiState, setIds: japaneseSetIds, region: 'JP' }),
  ])
}

const buildPrimaryLookups = async ({ apiState, productEntries }) => {
  const englishIdSet = new Set()
  const japanIdSet = new Set()
  for (const entry of productEntries) {
    const productId = toPositiveInt(entry?.productId)
    if (!productId) continue
    if (entry?.isJapanese) {
      japanIdSet.add(productId)
    } else {
      englishIdSet.add(productId)
    }
  }

  const englishRows = await fetchProductsByIds({
    apiState,
    ids: Array.from(englishIdSet),
    region: 'EN',
  })
  const japanRows = await fetchProductsByIds({
    apiState,
    ids: Array.from(japanIdSet),
    region: 'JP',
  })

  return {
    englishLookup: new Map(englishRows.map((row) => [row.tcg_product_id, row])),
    japanLookup: new Map(japanRows.map((row) => [row.tcg_product_id, row])),
  }
}

const matchMissingItems = async ({
  apiState,
  items,
  setMap,
  region,
  allowPartial = false,
}) => {
  if (!items.length) return new Map()
  const setIds = new Set()
  const itemSetIds = new Map()
  items.forEach((item) => {
    const rows = findSetRowsByName(item.setName, setMap, allowPartial)
    const ids = rows
      .map((row) => toPositiveInt(row.id))
      .filter((id) => !!id)
    if (ids.length) {
      itemSetIds.set(item, ids)
      ids.forEach((id) => setIds.add(id))
    }
  })
  const ids = Array.from(setIds)
  if (!ids.length) return new Map()

  const rows = await fetchProductsBySetIds({ apiState, setIds: ids, region })
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
      item.collectionKey || buildCollectionKey(item.collectionId, item.collectionName)
    const itemKey = `${collectionKey}|${baseKey}`
    const numberKey = normalizeCardNumberForMatch(item.cardNumber)
    const idsForItem = itemSetIds.get(item) || []
    let matched = null
    if (numberKey && idsForItem.length) {
      for (const setId of idsForItem) {
        const list = index.get(`${setId}|${numberKey}`) || []
        if (!list.length) continue
        if (item.collectrName) {
          matched = list.find((row) => compareNamesLike(row?.name, item.collectrName))
        }
        if (!matched) matched = list[0]
        if (matched) break
      }
    }
    if (matched) lookup.set(itemKey, matched)
  })

  return lookup
}

const matchJapaneseMissingItems = async ({ apiState, items, japanSetMap }) => {
  if (!items.length) return new Map()
  const lookup = new Map()

  const setIds = new Set()
  const itemSetIds = new Map()
  items.forEach((item) => {
    const rows = findSetRowsByName(item.setName, japanSetMap, true)
    const ids = rows
      .map((row) => toPositiveInt(row.id))
      .filter((id) => !!id)
    if (ids.length) {
      itemSetIds.set(item, ids)
      ids.forEach((id) => setIds.add(id))
    }
  })

  const rows = await fetchProductsBySetIds({
    apiState,
    setIds: Array.from(setIds),
    region: 'JP',
  })

  const index = new Map()
  rows.forEach((row) => {
    const numberKey = normalizeCardNumberForMatch(row?.card_number)
    if (!row?.set_id || !numberKey) return
    const key = `${row.set_id}|${numberKey}`
    const list = index.get(key) || []
    list.push(row)
    index.set(key, list)
  })

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

    const numberKey = normalizeCardNumberForMatch(rawCardNumber)
    const idsForItem = itemSetIds.get(item) || []
    let matched = null
    if (numberKey && idsForItem.length) {
      for (const setId of idsForItem) {
        const list = index.get(`${setId}|${numberKey}`) || []
        if (!list.length) continue
        if (collectrName) {
          matched = list.find((row) => compareNamesLike(row?.name, collectrName))
        }
        if (!matched) matched = list[0]
        if (matched) break
      }
    }

    const embedded = matched?.pokemon_sets ?? null
    const setEmbed = Array.isArray(embedded) ? embedded[0] ?? null : embedded ?? null
    const checks = buildJapanChecksFromProduct({
      collectrSet,
      collectrNumber: rawCardNumber,
      collectrName,
      productName: matched?.name ?? null,
      productSet: setEmbed?.name ?? null,
      productSetOther: setEmbed?.name_other ?? null,
      productNumber: matched?.card_number ?? null,
    })
    item.japaneseChecks = checks

    const itemKey = item.matchKey || buildJapanItemKey(collectrSet, rawCardNumber, collectrName)
    if (!itemKey) continue
    const collectionKey =
      item.collectionKey || buildCollectionKey(item.collectionId, item.collectionName)
    lookup.set(`${collectionKey}|${itemKey}`, { product: matched || null, checks })
  }

  return lookup
}

const buildFallbackJapanItems = ({ productEntries, japanLookup }) => {
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
      collectionKey:
        collectr.collectionKey ||
        buildCollectionKey(collectr.collectionId, collectr.collectionName),
    })
  })
  return fallbackJapanItems
}

export const resolveCollectrProductMatches = async ({
  productEntries,
  missingItems,
  englishSetMap,
  japanSetMap,
  setIdRegionMap,
  cardhqBaseUrl,
  cardhqApiKey,
}) => {
  const cardhqConfig = resolveCardhqConfig({ cardhqBaseUrl, cardhqApiKey })
  const apiState = createApiState({
    cardhqConfig,
    setIdRegionMap: setIdRegionMap || new Map(),
  })

  await prefetchSetProductsForMatching({
    apiState,
    productEntries,
    missingItems,
    englishSetMap,
    japanSetMap,
  })

  const { englishLookup, japanLookup } = await buildPrimaryLookups({
    apiState,
    productEntries,
  })

  const missingEnglish = missingItems.filter((item) => !item.isJapanese)
  const missingJapan = missingItems.filter((item) => item.isJapanese)
  const fallbackJapanItems = buildFallbackJapanItems({ productEntries, japanLookup })

  const missingEnglishLookup = await matchMissingItems({
    apiState,
    items: missingEnglish,
    setMap: englishSetMap,
    region: 'EN',
    allowPartial: true,
  })
  const missingJapanLookup = await matchJapaneseMissingItems({
    apiState,
    items: [...missingJapan, ...fallbackJapanItems],
    japanSetMap,
  })

  return {
    englishLookup,
    japanLookup,
    missingEnglishLookup,
    missingJapanLookup,
  }
}
