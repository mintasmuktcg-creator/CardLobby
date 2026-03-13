export const decodeEscapes = (value) => {
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

export const isPlainObject = (value) => {
  if (!value || typeof value !== 'object') return false
  return Object.getPrototypeOf(value) === Object.prototype
}

export const summarizeKeys = (value, depth = 2) => {
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

export const normalizeName = (value) => {
  return decodeEscapes(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export const stripJpTag = (value) => {
  if (!value) return value
  return String(value)
    .replace(/\(\s*JP\s*\)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export const normalizeCardNameForMatch = (value) => normalizeName(stripJpTag(value))

export const normalizeCardNumberForMatch = (value) => {
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

export const compareSetNames = (left, right) => {
  const leftKey = normalizeName(left)
  const rightKey = normalizeName(right)
  if (!leftKey || !rightKey) return false
  return (
    leftKey === rightKey || leftKey.includes(rightKey) || rightKey.includes(leftKey)
  )
}

export const looksLikeCardNumber = (value) => {
  if (!value) return false
  const raw = String(value).trim()
  return /(\d{1,4}(?:\/\d{1,4})?|[A-Z]{1,4}\d{1,4}(?:\/\d{1,4})?)/i.test(raw)
}

export const findFirstValue = (value, keyPatterns, valueCheck, depth = 4) => {
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

export const buildMatchKey = (setName, cardName, cardNumber) => {
  const setKey = normalizeName(setName)
  const nameKey = normalizeCardNameForMatch(cardName)
  const numberKey = normalizeCardNumberForMatch(cardNumber)
  if (!setKey || !nameKey || !numberKey) return null
  return `${setKey}|${nameKey}|${numberKey}`
}

export const buildLooseKey = (setName, cardName, cardNumber) => {
  const parts = [
    normalizeName(setName) || '',
    normalizeCardNameForMatch(cardName) || '',
    normalizeCardNumberForMatch(cardNumber) || '',
  ]
  return parts.join('|')
}

export const buildNameSetKey = (setName, cardName) => {
  const setKey = normalizeName(setName)
  const nameKey = normalizeCardNameForMatch(cardName)
  if (!setKey || !nameKey) return null
  return `${setKey}|${nameKey}`
}

export const buildJapanItemKey = (setName, cardNumber, cardName) => {
  const setKey = normalizeName(setName)
  const numberKey = normalizeCardNumberForMatch(cardNumber)
  if (!setKey || !numberKey) return null
  const nameKey = normalizeName(cardName) || ''
  return `${setKey}|${numberKey}|${nameKey}`
}

export const compareNamesLike = (left, right) => {
  const leftKey = normalizeName(left)
  const rightKey = normalizeName(right)
  if (!leftKey || !rightKey) return false
  return (
    leftKey === rightKey || leftKey.includes(rightKey) || rightKey.includes(leftKey)
  )
}

export const buildJapanChecksFromProduct = ({
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

export const extractString = (block, key) => {
  const reEscaped = new RegExp(`\\\\\"${key}\\\\\":\\\\\"(.*?)\\\\\"`)
  const rePlain = new RegExp(`\"${key}\":\"(.*?)\"`)
  const escaped = block.match(reEscaped)
  if (escaped) return decodeEscapes(escaped[1])
  const plain = block.match(rePlain)
  return plain ? decodeEscapes(plain[1]) : null
}

export const extractNullable = (block, key) => {
  const str = extractString(block, key)
  if (str !== null) return str
  const reEscaped = new RegExp(`\\\\\"${key}\\\\\":null`)
  const rePlain = new RegExp(`\"${key}\":null`)
  if (reEscaped.test(block) || rePlain.test(block)) return null
  return null
}

export const isJapaneseSetName = (setName) => {
  if (!setName) return false
  return /(\bjp\b|\bjpn\b|japanese|pokemon\s+japan)/i.test(setName)
}

export const findSetRowsByName = (setName, setMap, allowPartial = false) => {
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

export const getSetStatus = (setName, englishSetMap, japanSetMap) => {
  if (!setName) return { isJapanese: false, match: false }
  const englishRows = findSetRowsByName(setName, englishSetMap, false)
  const japanRows = findSetRowsByName(setName, japanSetMap, true)
  const englishMatch = englishRows.length > 0
  const japanMatch = japanRows.length > 0
  const isJapanese = isJapaneseSetName(setName) || (!englishMatch && japanMatch)
  const match = isJapanese ? japanMatch : englishMatch
  return { isJapanese, match }
}

export const chunk = (arr, size) => {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export const getLooseKeyFromItem = (item) => {
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

export const getFallbackKeyFromItem = (item) => {
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

export const extractCardNumberFromName = (value) => {
  if (!value) return null
  const raw = String(value)
  const withSlash = raw.match(/#?\s*([A-Z0-9]{1,6}-\d{1,4}(?:\/\d{1,4})?)/i)
  if (withSlash) return withSlash[1]
  const basic = raw.match(/#?\s*([A-Z]{1,3}\d{1,4}(?:\/\d{1,4})?)/i)
  if (basic) return basic[1]
  const numeric = raw.match(/#?\s*(\d{1,4}(?:\/\d{1,4})?)/)
  return numeric ? numeric[1] : null
}

export const normalizeCollectrItem = (item) => {
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

export const isCollectrGraded = ({ gradeCompany, gradeId, isCard }) => {
  if (gradeCompany) return true
  if (isCard === false) return false
  if (gradeId === null || gradeId === undefined) return false
  const normalizedGrade = String(gradeId).trim()
  if (!normalizedGrade) return false
  return normalizedGrade !== '52'
}

export const buildCollectionKey = (collectionId, collectionName) => {
  if (collectionId) return `id:${collectionId}`
  if (collectionName) {
    const normalized = normalizeName(collectionName)
    if (normalized) return `name:${normalized}`
  }
  return 'default'
}

export const getCollectionKeyFromItem = (item) => {
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

export const buildSetMap = (rows) => {
  const map = new Map()
  const add = (row, name) => {
    const normalized = normalizeName(name)
    if (!normalized) return
    const list = map.get(normalized) || []
    list.push(row)
    map.set(normalized, list)
  }
  for (const row of rows || []) {
    const primaryName = String(row?.name || '')
    add(row, primaryName)
    if (row?.name_other) add(row, row.name_other)
    if (row?.other_name) add(row, row.other_name)
    const colonMatch = primaryName.match(/^([A-Z0-9]{2,6})\s*:\s*(.+)$/i)
    if (colonMatch) add(row, colonMatch[2])
    const dashMatch = primaryName.match(/^([A-Z0-9]{2,6})\s*-\s*(.+)$/i)
    if (dashMatch) add(row, dashMatch[2])
  }
  return map
}
