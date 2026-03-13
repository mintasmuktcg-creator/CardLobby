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

const PRODUCT_EMBED_SELECT = 'pokemon_sets(id, name, name_other, code, region)'

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

const fetchProductsByIds = async ({ supabase, ids, region }) => {
  if (!ids.length) return []
  const rows = []
  const groups = chunk(ids, 400)
  for (const group of groups) {
    const { data, error } = await supabase
      .from('pokemon_products')
      .select(
        `tcg_product_id, name, product_type, card_number, rarity, image_url, market_price, ${PRODUCT_EMBED_SELECT}`,
      )
      .in('tcg_product_id', group)
      .eq('region', region)
    if (error) throw error
    if (data) rows.push(...data)
  }
  return rows
}

const fetchProductsBySetIds = async ({ supabase, setIds, region }) => {
  if (!setIds.length) return []
  const rows = []
  const groups = chunk(setIds, 200)
  for (const group of groups) {
    const { data, error } = await supabase
      .from('pokemon_products')
      .select(
        `tcg_product_id, set_id, name, product_type, card_number, rarity, image_url, market_price, ${PRODUCT_EMBED_SELECT}`,
      )
      .in('set_id', group)
      .eq('region', region)
    if (error) throw error
    if (data) rows.push(...data)
  }
  return rows
}

const buildPrimaryLookups = async ({ supabase, productEntries }) => {
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

  const englishRows = await fetchProductsByIds({
    supabase,
    ids: Array.from(englishIdSet),
    region: 'EN',
  })
  const japanRows = await fetchProductsByIds({
    supabase,
    ids: Array.from(japanIdSet),
    region: 'JP',
  })

  return {
    englishLookup: new Map(englishRows.map((row) => [row.tcg_product_id, row])),
    japanLookup: new Map(japanRows.map((row) => [row.tcg_product_id, row])),
  }
}

const matchMissingItems = async ({
  supabase,
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
    const ids = rows.map((row) => row.id)
    if (ids.length) {
      itemSetIds.set(item, ids)
      ids.forEach((id) => setIds.add(id))
    }
  })
  const ids = Array.from(setIds)
  if (!ids.length) return new Map()

  const rows = await fetchProductsBySetIds({ supabase, setIds: ids, region })
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

const matchJapaneseMissingItems = async ({ supabase, items }) => {
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
      .from('pokemon_products')
      .select(
        'tcg_product_id, set_id, name, product_type, card_number, rarity, image_url, market_price, pokemon_sets(id, name, name_other, code, region)',
      )
      .eq('card_number', rawCardNumber)
      .eq('region', 'JP')

    if (collectrName) {
      query = query.ilike('name', `%${collectrName}%`)
    }
    if (collectrSet) {
      query = query.or(`name.ilike.%${collectrSet}%,name_other.ilike.%${collectrSet}%`, {
        foreignTable: 'pokemon_sets',
      })
    }

    const { data, error } = await query.limit(5)
    if (error) throw error

    const product = Array.isArray(data) ? data[0] ?? null : null
    const embedded = product?.pokemon_sets ?? null
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

    const itemKey = item.matchKey || buildJapanItemKey(collectrSet, rawCardNumber, collectrName)
    if (!itemKey) continue
    const collectionKey =
      item.collectionKey || buildCollectionKey(item.collectionId, item.collectionName)
    lookup.set(`${collectionKey}|${itemKey}`, { product, checks })
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
  supabase,
  productEntries,
  missingItems,
  englishSetMap,
}) => {
  const { englishLookup, japanLookup } = await buildPrimaryLookups({
    supabase,
    productEntries,
  })

  const missingEnglish = missingItems.filter((item) => !item.isJapanese)
  const missingJapan = missingItems.filter((item) => item.isJapanese)
  const fallbackJapanItems = buildFallbackJapanItems({ productEntries, japanLookup })

  const missingEnglishLookup = await matchMissingItems({
    supabase,
    items: missingEnglish,
    setMap: englishSetMap,
    region: 'EN',
    allowPartial: true,
  })
  const missingJapanLookup = await matchJapaneseMissingItems({
    supabase,
    items: [...missingJapan, ...fallbackJapanItems],
  })

  return {
    englishLookup,
    japanLookup,
    missingEnglishLookup,
    missingJapanLookup,
  }
}
