import { assembleCollectrResults } from './collectr-importer/pipeline/assemble-stage.mjs'
import {
  fetchCollectrSourceData,
  fetchHtmlCardNumberLookup,
  getCollectrCollectionId,
  getCollectrProfileId,
} from './collectr-importer/pipeline/fetch-stage.mjs'
import {
  buildCollectrBuckets,
  fetchCardhqSetRows,
  resolveCollectrProductMatches,
} from './collectr-importer/pipeline/match-stage.mjs'
import { buildSetMap } from './collectr-importer/pipeline/shared.mjs'

const parseAndValidateCollectrUrl = (url) => {
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

  return { parsedUrl, profileId, collectionId, collectionFilters }
}

export async function runCollectrImport({ url, cardhqBaseUrl, cardhqApiKey } = {}) {
  const { parsedUrl, profileId, collectionId, collectionFilters } =
    parseAndValidateCollectrUrl(url)

  const { englishSetRows, japanSetRows, setIdRegionMap, cardhqConfig } =
    await fetchCardhqSetRows({
      cardhqBaseUrl,
      cardhqApiKey,
    })

  if (!englishSetRows.length && !japanSetRows.length) {
    throw new Error('No CardHQ sets available for Collectr matching.')
  }

  const englishSetMap = buildSetMap(englishSetRows)
  const japanSetMap = buildSetMap(japanSetRows)

  const { collectrItems, collections, totalCollectr, htmlCardNumberLookup } =
    await fetchCollectrSourceData({
      parsedUrl,
      profileId,
      collectionId,
      collectionFilters,
    })

  const { productEntries, missingItems, skippedGraded } = buildCollectrBuckets({
    collectrItems,
    englishSetMap,
    japanSetMap,
  })

  const {
    englishLookup,
    japanLookup,
    missingEnglishLookup,
    missingJapanLookup,
  } = await resolveCollectrProductMatches({
    productEntries,
    missingItems,
    englishSetMap,
    japanSetMap,
    setIdRegionMap,
    cardhqBaseUrl: cardhqConfig.baseUrl,
    cardhqApiKey: cardhqConfig.apiKey,
  })

  const results = await assembleCollectrResults({
    productEntries,
    missingItems,
    englishLookup,
    japanLookup,
    missingEnglishLookup,
    missingJapanLookup,
    htmlCardNumberLookup,
    collectrUrl: parsedUrl.toString(),
    fetchHtmlCardNumberLookup,
  })

  const summary = {
    totalCollectr,
    parsedProducts: productEntries.length + missingItems.length,
    matchedProducts: results.filter((row) => row.matched).length,
    skippedGraded,
  }

  return { summary, results, collections }
}
