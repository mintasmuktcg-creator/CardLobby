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

const appendDirectProductMatches = ({
  results,
  productEntries,
  englishLookup,
  japanLookup,
  missingJapanLookup,
}) => {
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
          ) || buildLooseKey(collectrSet, collectr?.collectrName, collectr?.cardNumber)
        const collectionKey =
          collectr.collectionKey ||
          buildCollectionKey(collectr.collectionId, collectr.collectionName)
        const fallback = matchKey
          ? missingJapanLookup.get(`${collectionKey}|${matchKey}`) || null
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
      collectr_image_url: collectr.collectrImageUrl || null,
      matched: !!product,
      name: product?.name ?? null,
      set: setEmbed?.name ?? null,
      code: setEmbed?.code ?? null,
      product_type: product?.product_type ?? null,
      card_number: product?.card_number ?? null,
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
    const lookupKey = matchKey ? `${collectionKey}|${matchKey}` : null
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
      collectr_image_url: collectr.collectrImageUrl || null,
      matched: !!product,
      name: product?.name ?? collectr.collectrName ?? null,
      set: setEmbed?.name ?? null,
      code: setEmbed?.code ?? null,
      product_type: product?.product_type ?? null,
      card_number: product?.card_number ?? collectr.cardNumber ?? null,
      rarity: product?.rarity ?? collectr.rarity ?? null,
      image_url: product?.image_url ?? null,
      market_price: product?.market_price ?? null,
      japanese_checks: japaneseChecks,
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
