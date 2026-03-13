import { createClient } from '@supabase/supabase-js'

import { assembleCollectrResults } from './collectr-importer/pipeline/assemble-stage.mjs'
import {
  fetchCollectrSourceData,
  fetchHtmlCardNumberLookup,
  getCollectrCollectionId,
  getCollectrProfileId,
} from './collectr-importer/pipeline/fetch-stage.mjs'
import {
  buildCollectrBuckets,
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

const fetchSetRows = async (supabase, region) => {
  const { data, error } = await supabase
    .from('pokemon_sets')
    .select('id, name, name_other')
    .eq('region', region)
  if (error) throw error
  return data || []
}

export async function runCollectrImport({ url, supabaseUrl, supabaseKey }) {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase env vars are missing.')
  }

  const { parsedUrl, profileId, collectionId, collectionFilters } =
    parseAndValidateCollectrUrl(url)

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  })

  const [englishSetRows, japanSetRows] = await Promise.all([
    fetchSetRows(supabase, 'EN'),
    fetchSetRows(supabase, 'JP'),
  ])
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
    supabase,
    productEntries,
    missingItems,
    englishSetMap,
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
