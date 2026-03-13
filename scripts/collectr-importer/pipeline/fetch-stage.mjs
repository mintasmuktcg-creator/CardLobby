import {
  buildNameSetKey,
  extractNullable,
  extractString,
  getCollectionKeyFromItem,
  getFallbackKeyFromItem,
  getLooseKeyFromItem,
} from './shared.mjs'

const COLLECTR_API_BASE = 'https://api-v2.getcollectr.com'
const COLLECTR_ANON_USERNAME = '00000000-0000-0000-0000-000000000000'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const loadPuppeteer = async () => {
  try {
    const mod = await import('puppeteer')
    return mod?.default ?? mod
  } catch {
    return null
  }
}

export const buildCollectrApiHeaders = () => {
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

export const extractCollectrItemsFromHtml = (html) => {
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

const buildHtmlCardNumberLookup = (items) => {
  if (!Array.isArray(items) || !items.length) return null
  const lookup = new Map()
  items.forEach((item) => {
    const key = buildNameSetKey(item.catalog_group, item.product_name)
    const number = item.card_number
    if (key && number && !lookup.has(key)) lookup.set(key, number)
  })
  return lookup.size ? lookup : null
}

export const mergeCollectrItems = (baseItems, domItems) => {
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

export const getCollectrProfileId = (parsedUrl) => {
  if (!parsedUrl) return null
  const match = parsedUrl.pathname.match(/showcase\/profile\/([^/]+)/i)
  return match ? match[1] : null
}

export const getCollectrCollectionId = (parsedUrl) => {
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

const fetchHtmlExtraction = async (url, { strict = false } = {}) => {
  const response = await fetch(url, {
    headers: buildCollectrApiHeaders(),
  })
  if (!response.ok) {
    if (strict) {
      throw new Error(`Failed to fetch ${response.status}`)
    }
    return null
  }
  const html = await response.text()
  if (strict && (!html || html.trim().length < 1000)) {
    throw new Error(
      'Collectr returned empty HTML. The site may be blocking automated requests. Try setting COLLECTR_HEADLESS=0.',
    )
  }
  const extracted = extractCollectrItemsFromHtml(html)
  return { html, extracted }
}

export const fetchHtmlCardNumberLookup = async (url) => {
  try {
    const extraction = await fetchHtmlExtraction(url, { strict: false })
    if (!extraction?.extracted?.items?.length) return null
    return buildHtmlCardNumberLookup(extraction.extracted.items)
  } catch {
    return null
  }
}

export const fetchCollectrSourceData = async ({
  parsedUrl,
  profileId,
  collectionId,
  collectionFilters,
}) => {
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
    } catch {
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
        const extraction = await fetchHtmlExtraction(parsedUrl.toString(), {
          strict: false,
        })
        if (extraction?.extracted?.items?.length) {
          mergeCollectrItems(collectrItems, extraction.extracted.items)
          totalCollectr = Math.max(
            totalCollectr,
            extraction.extracted.totalBlocks || extraction.extracted.items.length,
          )
          const lookup = buildHtmlCardNumberLookup(extraction.extracted.items)
          if (lookup?.size) htmlCardNumberLookup = lookup
        }
      } catch {
        // ignore html enrichment errors
      }
    }
  }

  if (!collectrItems.length) {
    const extraction = await fetchHtmlExtraction(parsedUrl.toString(), { strict: true })
    collectrItems = extraction.extracted.items
    totalCollectr = extraction.extracted.totalBlocks || collectrItems.length
    if (extraction.extracted.items.length) {
      const lookup = buildHtmlCardNumberLookup(extraction.extracted.items)
      if (lookup?.size) htmlCardNumberLookup = lookup
    }
    if (!collectrItems.length) {
      throw new Error(
        'No items found in Collectr HTML. The site may be blocking automated requests. Try setting COLLECTR_HEADLESS=0.',
      )
    }
  }

  return { collectrItems, collections, totalCollectr, htmlCardNumberLookup }
}
