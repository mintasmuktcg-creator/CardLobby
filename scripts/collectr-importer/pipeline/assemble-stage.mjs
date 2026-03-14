import {
  buildCollectionKey,
  buildJapanChecksFromProduct,
  buildJapanItemKey,
  buildLooseKey,
  buildMatchKey,
  buildNameSetKey,
} from './shared.mjs'

const getSetEmbed = (product) => {
  const embedded = product?.pokemon_sets ?? null
  return Array.isArray(embedded) ? embedded[0] ?? null : embedded ?? null
}

const normalizeConditionKey = (value) => {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return ''
  if (/\b(near\s*mint|nm)\b/i.test(raw)) return 'near mint'
  if (/\b(lightly\s*played|lp)\b/i.test(raw)) return 'lightly played'
  if (/\b(moderately\s*played|mp)\b/i.test(raw)) return 'moderately played'
  if (/\b(heavily\s*played|hp)\b/i.test(raw)) return 'heavily played'
  if (/\b(damaged|dmg)\b/i.test(raw)) return 'damaged'
  return raw
}

const buildPrimaryLookupKey = (productId, collectrCondition) => {
  const numeric = Number(productId)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return `${Math.floor(numeric)}|${normalizeConditionKey(collectrCondition)}`
}

const buildMissingLookupKey = ({
  collectionKey,
  matchKey,
  collectrCondition,
}) => {
  return `${collectionKey}|${matchKey}|${normalizeConditionKey(collectrCondition)}`
}

const appendDirectProductMatches = ({
  results,
  productEntries,
  englishLookup,
  japanLookup,
  missingJapanLookup,
}) => {
  productEntries.forEach((collectr) => {
    const isJapanese = collectr?.isJapanese
    const primaryLookupKey =
      collectr.primaryLookupKey ||
      buildPrimaryLookupKey(collectr.productId, collectr.collectrCondition)
    let product =
      (isJapanese ? japanLookup : englishLookup).get(primaryLookupKey) || null
    const collectrSet = collectr.setName || null
    let japaneseChecks = null

    if (isJapanese) {
      if (!product) {
        const matchKey =
          buildJapanItemKey(
            collectrSet,
            collectr?.cardNumber ?? null,
            collectr?.collectrName ?? null,
          ) || buildLooseKey(collectrSet, collectr?.collectrName, collectr?.cardNumber)
        const collectionKey =
          collectr.collectionKey ||
          buildCollectionKey(collectr.collectionId, collectr.collectionName)
        const fallbackLookupKey = matchKey
          ? buildMissingLookupKey({
              collectionKey,
              matchKey,
              collectrCondition: collectr.collectrCondition,
            })
          : null
        const fallback = fallbackLookupKey
          ? missingJapanLookup.get(fallbackLookupKey) || null
          : null
        if (fallback?.product) {
          product = fallback.product
          const setFallback = getSetEmbed(product)
          japaneseChecks = fallback.checks ?? null
          if (!japaneseChecks) {
            japaneseChecks = buildJapanChecksFromProduct({
              collectrSet,
              collectrNumber: collectr?.cardNumber ?? null,
              collectrName: collectr?.collectrName ?? null,
              productName: product?.name ?? null,
              productSet: setFallback?.name ?? null,
              productSetOther: setFallback?.name_other ?? null,
              productNumber: product?.card_number ?? null,
            })
          }
        }
      }

      if (!japaneseChecks) {
        const setCurrent = getSetEmbed(product)
        japaneseChecks = buildJapanChecksFromProduct({
          collectrSet,
          collectrNumber: collectr?.cardNumber ?? null,
          collectrName: collectr?.collectrName ?? null,
          productName: product?.name ?? null,
          productSet: setCurrent?.name ?? null,
          productSetOther: setCurrent?.name_other ?? null,
          productNumber: product?.card_number ?? null,
        })
      }
    }

    const setEmbed = getSetEmbed(product)
    results.push({
      tcg_product_id: collectr.productId,
      quantity: collectr.quantity,
      collectr_collection_id: collectr.collectionId || null,
      collectr_collection_name: collectr.collectionName || null,
      collectr_set: collectrSet,
      collectr_name: collectr.collectrName || null,
      collectr_condition: collectr.collectrCondition || null,
      collectr_image_url: collectr.collectrImageUrl || null,
      matched: !!product,
      status: product ? 'matched' : 'unmatched',
      skip_reason: null,
      grade_company: null,
      grade_id: null,
      name: product?.name ?? null,
      set: setEmbed?.name ?? null,
      code: setEmbed?.code ?? null,
      product_type: product?.product_type ?? null,
      card_number: product?.card_number ?? null,
      condition: product?.condition ?? null,
      rarity: product?.rarity ?? null,
      image_url: product?.image_url ?? null,
      market_price: product?.market_price ?? null,
      japanese_checks: japaneseChecks,
    })
  })
}

const appendMissingMatches = ({
  results,
  missingItems,
  missingEnglishLookup,
  missingJapanLookup,
}) => {
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
        : buildMatchKey(collectr.setName, collectr.collectrName, collectr.cardNumber))
    const lookupKey =
      collectr.lookupKey ||
      (matchKey
        ? buildMissingLookupKey({
            collectionKey,
            matchKey,
            collectrCondition: collectr.collectrCondition,
          })
        : null)
    const matchInfo = isJapanese && lookupKey ? lookup.get(lookupKey) || null : null
    const product = isJapanese
      ? matchInfo?.product || null
      : lookupKey
        ? lookup.get(lookupKey) || null
        : null
    const setEmbed = getSetEmbed(product)
    const japaneseChecks = isJapanese
      ? matchInfo?.checks ?? collectr?.japaneseChecks ?? null
      : null

    results.push({
      tcg_product_id: product?.tcg_product_id ?? null,
      quantity: collectr.quantity,
      collectr_collection_id: collectr.collectionId || null,
      collectr_collection_name: collectr.collectionName || null,
      collectr_set: collectr.setName || null,
      collectr_name: collectr.collectrName || null,
      collectr_condition: collectr.collectrCondition || null,
      collectr_image_url: collectr.collectrImageUrl || null,
      matched: !!product,
      status: product ? 'matched' : 'unmatched',
      skip_reason: null,
      grade_company: null,
      grade_id: null,
      name: product?.name ?? collectr.collectrName ?? null,
      set: setEmbed?.name ?? null,
      code: setEmbed?.code ?? null,
      product_type: product?.product_type ?? null,
      card_number: product?.card_number ?? collectr.cardNumber ?? null,
      condition: product?.condition ?? null,
      rarity: product?.rarity ?? collectr.rarity ?? null,
      image_url: product?.image_url ?? null,
      market_price: product?.market_price ?? null,
      japanese_checks: japaneseChecks,
    })
  })
}

const appendSkippedGradedMatches = ({ results, skippedGradedItems }) => {
  skippedGradedItems.forEach((collectr) => {
    results.push({
      tcg_product_id: collectr.productId ?? null,
      quantity: collectr.quantity,
      collectr_collection_id: collectr.collectionId || null,
      collectr_collection_name: collectr.collectionName || null,
      collectr_set: collectr.setName || null,
      collectr_name: collectr.collectrName || null,
      collectr_condition: collectr.collectrCondition || null,
      collectr_image_url: collectr.collectrImageUrl || null,
      matched: false,
      status: 'skipped-graded',
      skip_reason: 'graded',
      grade_company: collectr.gradeCompany || null,
      grade_id: collectr.gradeId ?? null,
      name: collectr.collectrName || null,
      set: null,
      code: null,
      product_type: null,
      card_number: collectr.cardNumber || null,
      condition: null,
      rarity: collectr.rarity || null,
      image_url: null,
      market_price: null,
      japanese_checks: null,
    })
  })
}

const applyCardNumberLookup = ({ results, cardNumberLookup }) => {
  if (!cardNumberLookup || !cardNumberLookup.size) return
  results.forEach((row) => {
    if (row.card_number) return
    const key = buildNameSetKey(row.collectr_set || row.set, row.collectr_name || row.name)
    const number = key ? cardNumberLookup.get(key) : null
    if (number) row.card_number = number
  })
}

export const assembleCollectrResults = async ({
  productEntries,
  missingItems,
  skippedGradedItems,
  englishLookup,
  japanLookup,
  missingEnglishLookup,
  missingJapanLookup,
  htmlCardNumberLookup,
  collectrUrl,
  fetchHtmlCardNumberLookup,
}) => {
  const results = []
  appendDirectProductMatches({
    results,
    productEntries,
    englishLookup,
    japanLookup,
    missingJapanLookup,
  })
  appendMissingMatches({
    results,
    missingItems,
    missingEnglishLookup,
    missingJapanLookup,
  })
  appendSkippedGradedMatches({
    results,
    skippedGradedItems,
  })

  let cardNumberLookup = htmlCardNumberLookup
  if (
    (!cardNumberLookup || !cardNumberLookup.size) &&
    results.some((row) => !row.card_number) &&
    typeof fetchHtmlCardNumberLookup === 'function' &&
    collectrUrl
  ) {
    cardNumberLookup = await fetchHtmlCardNumberLookup(collectrUrl)
  }

  applyCardNumberLookup({ results, cardNumberLookup })
  return results
}
