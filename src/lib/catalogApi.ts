export type CatalogRegion = 'EN' | 'JP'

export type CatalogSetRow = {
  set_name_id: number
  name: string
  other_name?: string | null
  abbreviation?: string | null
  release_date?: string | null
  active?: boolean | null
}

export type CatalogProductRow = {
  product_id: number
  set_name_id: number
  set_name?: string | null
  set_other_name?: string | null
  set_abbreviation?: string | null
  product_name?: string | null
  number?: string | null
  image_url?: string | null
  market_price?: number | null
  condition_id?: number | null
  condition?: string | null
  rarity_id?: number | null
  rarity?: string | null
  printing_id?: number | null
  printing?: string | null
}

const TCGPLAYER_IMAGE_BASE_URL = 'https://tcgplayer-cdn.tcgplayer.com/product'

const toFiniteNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return null
  return numeric
}

const toPositiveInt = (value: unknown): number | null => {
  const numeric = toFiniteNumber(value)
  if (numeric === null) return null
  const asInt = Math.floor(numeric)
  return asInt > 0 ? asInt : null
}

const buildImageUrl = (productId: number | null) => {
  if (!productId) return null
  return `${TCGPLAYER_IMAGE_BASE_URL}/${productId}_200w.jpg`
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

const toRank = (value: string | null | undefined, rankMap: Map<string, number>) => {
  if (!value) return 99
  const normalized = String(value).trim().toLowerCase()
  if (!normalized) return 99
  return rankMap.get(normalized) ?? 50
}

const toComparablePrice = (value: unknown) => {
  const numeric = toFiniteNumber(value)
  return numeric === null ? Number.POSITIVE_INFINITY : numeric
}

const choosePreferredRow = (current: CatalogProductRow, candidate: CatalogProductRow) => {
  const currentConditionRank = toRank(current.condition, CONDITION_RANK)
  const nextConditionRank = toRank(candidate.condition, CONDITION_RANK)
  if (nextConditionRank !== currentConditionRank) {
    return nextConditionRank < currentConditionRank ? candidate : current
  }

  const currentPrintingRank = toRank(current.printing, PRINTING_RANK)
  const nextPrintingRank = toRank(candidate.printing, PRINTING_RANK)
  if (nextPrintingRank !== currentPrintingRank) {
    return nextPrintingRank < currentPrintingRank ? candidate : current
  }

  const currentPrice = toComparablePrice(current.market_price)
  const nextPrice = toComparablePrice(candidate.market_price)
  if (nextPrice !== currentPrice) {
    return nextPrice < currentPrice ? candidate : current
  }

  if ((candidate.image_url || '').length > (current.image_url || '').length) {
    return candidate
  }

  return current
}

const fetchJson = async (url: string) => {
  const response = await fetch(url, { method: 'GET' })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && typeof payload.error === 'string'
        ? payload.error
        : `Request failed (${response.status})`
    throw new Error(message)
  }
  return payload
}

export const fetchCatalogSets = async (region: CatalogRegion): Promise<CatalogSetRow[]> => {
  const payload = await fetchJson(`/api/catalog-sets?region=${encodeURIComponent(region)}`)
  const rows = payload?.rows
  return Array.isArray(rows) ? (rows as CatalogSetRow[]) : []
}

export const fetchCatalogProducts = async (setNameId: number): Promise<CatalogProductRow[]> => {
  const out: CatalogProductRow[] = []
  const pageSize = 500
  let offset = 0

  while (true) {
    const payload = await fetchJson(
      `/api/catalog-products?set_name_id=${encodeURIComponent(String(setNameId))}&limit=${pageSize}&offset=${offset}`,
    )
    const rows = Array.isArray(payload?.rows) ? (payload.rows as CatalogProductRow[]) : []
    if (!rows.length) break
    rows.forEach((row) => {
      const productId = toPositiveInt(row?.product_id)
      const imageUrl =
        typeof row?.image_url === 'string' && row.image_url.trim().length > 0
          ? row.image_url.trim()
          : buildImageUrl(productId)
      out.push({
        ...row,
        product_id: productId ?? 0,
        image_url: imageUrl,
        market_price: toFiniteNumber(row?.market_price),
      })
    })
    if (rows.length < pageSize) break
    offset += pageSize
  }

  return out
}

export const selectPreferredProductRows = (rows: CatalogProductRow[]) => {
  const byProductId = new Map<number, CatalogProductRow>()
  rows.forEach((row) => {
    const productId = Number(row?.product_id)
    if (!Number.isFinite(productId) || productId <= 0) return
    const current = byProductId.get(productId)
    if (!current) {
      byProductId.set(productId, row)
      return
    }
    byProductId.set(productId, choosePreferredRow(current, row))
  })
  return Array.from(byProductId.values())
}
