import { createClient } from '@supabase/supabase-js'

const loadPuppeteer = async () => {
  try {
    const mod = await import('puppeteer')
    return mod?.default ?? mod
  } catch (err) {
    return null
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

const normalizeRarity = (value) => {
  if (!value) return null
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() || null
}

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
  const nameKey = normalizeName(cardName)
  const numberKey = normalizeCardNumberForMatch(cardNumber)
  if (!setKey || !nameKey || !numberKey) return null
  return `${setKey}|${nameKey}|${numberKey}`
}

const buildLooseKey = (setName, cardName, cardNumber) => {
  const parts = [
    normalizeName(setName) || '',
    normalizeName(cardName) || '',
    normalizeCardNumberForMatch(cardNumber) || '',
  ]
  return parts.join('|')
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

const getSetStatus = (setName, englishSetMap, japanSetMap) => {
  if (!setName) return { isJapanese: false, match: false }
  const normalized = normalizeName(setName)
  if (!normalized) return { isJapanese: false, match: false }
  const englishMatch = englishSetMap.has(normalized)
  const japanMatch = japanSetMap.has(normalized)
  const isJapanese = isJapaneseSetName(setName) || (!englishMatch && japanMatch)
  const match = isJapanese ? japanMatch : englishMatch
  return { isJapanese, match }
}

const stripSetPrefix = (name) => {
  if (!name) return name
  const colonMatch = name.match(/^([A-Z0-9]{2,6})\\s*:\\s*(.+)$/i)
  if (colonMatch) return colonMatch[2]
  const dashMatch = name.match(/^([A-Z0-9]{2,6})\\s*-\\s*(.+)$/i)
  if (dashMatch) return dashMatch[2]
  return name
}

const chunk = (arr, size) => {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

const extractCollectrItemsFromHtml = (html) => {
  const productBlocks = []
  const idMatches = Array.from(html.matchAll(/\\"product_id\\":\\"(\d+)\\"/g))
  for (const match of idMatches) {
    const start = html.lastIndexOf('{', match.index ?? 0)
    const end = html.indexOf('}', match.index ?? 0)
    if (start === -1 || end === -1) continue
    productBlocks.push(html.slice(start, end + 1))
  }

  const items = productBlocks.map((block) => ({
    product_id: extractString(block, 'product_id'),
    image_url: extractString(block, 'image_url') || '',
    product_name: extractString(block, 'product_name'),
    quantity: extractString(block, 'quantity'),
    catalog_group: extractString(block, 'catalog_group'),
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

const mergeCollectrItems = (baseItems, domItems) => {
  if (!Array.isArray(domItems) || !domItems.length) return baseItems
  const byId = new Map()
  const byLooseKey = new Map()

  baseItems.forEach((item) => {
    const id = item?.product_id ?? item?.productId ?? item?.tcg_product_id ?? null
    if (id) byId.set(String(id), item)
    const key = getLooseKeyFromItem(item)
    if (key && !byLooseKey.has(key)) byLooseKey.set(key, item)
  })

  domItems.forEach((domItem) => {
    const id = domItem?.product_id ?? domItem?.productId ?? null
    if (id && byId.has(String(id))) {
      const target = byId.get(String(id))
      Object.entries(domItem).forEach(([key, value]) => {
        if (value === null || value === undefined || value === '') return
        if (target[key] === null || target[key] === undefined || target[key] === '') {
          target[key] = value
        }
      })
      return
    }

    const key = getLooseKeyFromItem(domItem)
    if (key && byLooseKey.has(key)) {
      const target = byLooseKey.get(key)
      Object.entries(domItem).forEach(([k, value]) => {
        if (value === null || value === undefined || value === '') return
        if (target[k] === null || target[k] === undefined || target[k] === '') {
          target[k] = value
        }
      })
      return
    }

    baseItems.push(domItem)
    if (id) byId.set(String(id), domItem)
    if (key) byLooseKey.set(key, domItem)
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

  const collectrName =
    item.product_name ??
    item.productName ??
    item.name ??
    item.title ??
    findFirstValue(item, [/product_name/i, /card_name/i, /^name$/i, /title/i]) ??
    null

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

const getCollectrProfileId = (parsedUrl) => {
  if (!parsedUrl) return null
  const match = parsedUrl.pathname.match(/showcase\/profile\/([^/]+)/i)
  return match ? match[1] : null
}

const fetchCollectrItemsViaBrowser = async (url, profileId) => {
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

    const collected = []
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

    for (let i = 0; i < maxScrolls && idleRounds < maxIdleRounds; i += 1) {
      await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('*')).filter((el) => {
          const style = window.getComputedStyle(el)
          const overflowY = style.overflowY
          return (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight
        })
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
          for (let i = 0; i < 7 && current; i += 1) {
            if (current.matches?.('[data-slot="card"]')) return current
            const hasSet = current.querySelector?.('span.underline.text-muted-foreground')
            const hasNumber = current.querySelector?.(
              'div.flex.flex-row.flex-wrap.items-center.space-x-1.text-muted-foreground',
            )
            if (hasSet && hasNumber) return current
            current = current.parentElement
          }
          return node.closest?.('[data-slot="card"]') || node.parentElement
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
            if (values.length) {
              const last = values[values.length - 1]
              cardNumber = looksLikeNumber(last) ? last : null
            }
            const bulletIndex = values.indexOf('•')
            if (bulletIndex > 0) {
              rarity = values[bulletIndex - 1] || null
            }
          }

          if (!cardNumber) {
            const spanCandidates = Array.from(card.querySelectorAll('span'))
            const candidate = spanCandidates.find((span) => looksLikeNumber(text(span)))
            cardNumber = candidate ? text(candidate) : null
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

    if (collected.length) return collected

    const html = await page.content()
    const extracted = extractCollectrItemsFromHtml(html)
    if (extracted.items.length) return extracted.items
    return collected
  } finally {
    await browser.close()
  }
}

export async function runCollectrImport({
  url,
  includeNonEnglish = false,
  supabaseUrl,
  supabaseKey,
}) {
  void includeNonEnglish
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

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  })

  const { data: englishSetRows, error: englishSetErr } = await supabase
    .from('pokemon_sets')
    .select('id, name')
  if (englishSetErr) throw englishSetErr

  const { data: japanSetRows, error: japanSetErr } = await supabase
    .from('pokemon_japan_sets')
    .select('id, name')
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
  let totalCollectr = 0

  if (process.env.COLLECTR_USE_BROWSER !== '0') {
    try {
      collectrItems = await fetchCollectrItemsViaBrowser(
        parsedUrl.toString(),
        profileId,
      )
      totalCollectr = collectrItems.length
    } catch (err) {
      collectrItems = []
      totalCollectr = 0
    }
  }

  if (!collectrItems.length) {
    const response = await fetch(parsedUrl.toString(), {
      headers: {
        'user-agent': 'CardLobby Collectr Importer',
      },
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
    if (!collectrItems.length) {
      throw new Error(
        'No items found in Collectr HTML. The site may be blocking automated requests. Try setting COLLECTR_HEADLESS=0.',
      )
    }
  }

  const productMap = new Map()
  const missingMap = new Map()
  let skippedGraded = 0
  const skippedNonEnglish = 0

  for (const item of collectrItems) {
    const normalized = normalizeCollectrItem(item)
    if (!normalized) continue

    const {
      productId,
      quantity,
      collectrName,
      collectrImageUrl,
      setName,
      gradeCompany,
      gradeId,
      isCard,
      cardNumber,
      rarity,
    } = normalized

    if (isCollectrGraded({ gradeCompany, gradeId, isCard })) {
      skippedGraded += 1
      continue
    }

    const setStatus = getSetStatus(setName, englishSetMap, japanSetMap)

    if (!productId) {
      const matchKey = buildMatchKey(setName, collectrName, cardNumber)
      const bucketKey = matchKey || buildLooseKey(setName, collectrName, cardNumber)
      const current = missingMap.get(bucketKey) || {
        productId: null,
        quantity: 0,
        setName,
        isJapanese: setStatus.isJapanese,
        englishMatch: setStatus.match,
        collectrName: null,
        collectrImageUrl: null,
        cardNumber: null,
        rarity: null,
        matchKey,
      }
      current.quantity += quantity
      if (!current.setName && setName) current.setName = setName
      current.isJapanese = current.isJapanese || setStatus.isJapanese
      current.englishMatch = current.englishMatch || setStatus.match
      if (!current.collectrName && collectrName) current.collectrName = collectrName
      if (!current.collectrImageUrl && collectrImageUrl) {
        current.collectrImageUrl = collectrImageUrl
      }
      if (!current.cardNumber && cardNumber) current.cardNumber = cardNumber
      if (!current.rarity && rarity) current.rarity = rarity
      current.matchKey = current.matchKey || matchKey
      missingMap.set(bucketKey, current)
      continue
    }

    const current = productMap.get(productId) || {
      productId,
      quantity: 0,
      setName,
      isJapanese: setStatus.isJapanese,
      englishMatch: setStatus.match,
      collectrName: null,
      collectrImageUrl: null,
    }
    current.quantity += quantity
    if (!current.setName && setName) current.setName = setName
    current.isJapanese = current.isJapanese || setStatus.isJapanese
    current.englishMatch = current.englishMatch || setStatus.match
    if (!current.collectrName && collectrName) current.collectrName = collectrName
    if (!current.collectrImageUrl && collectrImageUrl) {
      current.collectrImageUrl = collectrImageUrl
    }
    productMap.set(productId, current)
  }

  const productIds = Array.from(productMap.keys())
  const missingItems = Array.from(missingMap.values())
  const englishIds = []
  const japanIds = []
  for (const id of productIds) {
    const entry = productMap.get(id)
    if (entry?.isJapanese) {
      japanIds.push(id)
    } else {
      englishIds.push(id)
    }
  }

  const fetchProducts = async (ids, table, embedKey) => {
    const rows = []
    const groups = chunk(ids, 400)
    for (const group of groups) {
      const { data, error } = await supabase
        .from(table)
        .select(
          `tcg_product_id, name, product_type, card_number, rarity, image_url, market_price, ${embedKey}(name, code)`,
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
    for (const group of groups) {
      const { data, error } = await supabase
        .from(table)
        .select(
          `tcg_product_id, name, product_type, card_number, rarity, image_url, market_price, ${embedKey}(id, name, code)`,
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

  const matchMissingItems = async (items, setMap, table, embedKey) => {
    if (!items.length) return new Map()
    const setIds = new Set()
    for (const item of items) {
      const normalized = normalizeName(item.setName)
      if (!normalized) continue
      const setRows = setMap.get(normalized) || []
      setRows.forEach((row) => setIds.add(row.id))
    }
    const ids = Array.from(setIds)
    if (!ids.length) return new Map()

    const rows = await fetchProductsBySetIds(ids, table, embedKey)
    const lookup = new Map()
    rows.forEach((row) => {
      const embedded = row?.[embedKey] ?? null
      const setEmbed = Array.isArray(embedded) ? embedded[0] ?? null : embedded ?? null
      const key = buildMatchKey(setEmbed?.name, row?.name, row?.card_number)
      if (!key) return
      if (!lookup.has(key)) lookup.set(key, row)
    })
    return lookup
  }

  const missingEnglish = missingItems.filter((item) => !item.isJapanese)
  const missingJapan = missingItems.filter((item) => item.isJapanese)
  const missingEnglishLookup = await matchMissingItems(
    missingEnglish,
    englishSetMap,
    'pokemon_products',
    'pokemon_sets',
  )
  const missingJapanLookup = await matchMissingItems(
    missingJapan,
    japanSetMap,
    'pokemon_japan_products',
    'pokemon_japan_sets',
  )

  const results = []

  productIds.forEach((id) => {
    const collectr = productMap.get(id)
    const isJapanese = collectr?.isJapanese
    const product = (isJapanese ? japanLookup : englishLookup).get(id) || null
    const embedded = isJapanese ? product?.pokemon_japan_sets : product?.pokemon_sets
    const setEmbed = Array.isArray(embedded) ? embedded[0] ?? null : embedded ?? null
    const collectrSet = collectr.setName || null
    const productSet = setEmbed?.name ?? null
    const normalizedCollectr = collectrSet ? normalizeName(collectrSet) : null
    const normalizedProduct = productSet ? normalizeName(productSet) : null
    const normalizedProductStripped = productSet
      ? normalizeName(stripSetPrefix(productSet))
      : null
    const setMatch =
      normalizedCollectr &&
      (normalizedCollectr === normalizedProduct ||
        normalizedCollectr === normalizedProductStripped)
    results.push({
      tcg_product_id: id,
      quantity: collectr.quantity,
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
      english_match: collectr.englishMatch || setMatch || false,
    })
  })

  missingItems.forEach((collectr) => {
    const isJapanese = collectr?.isJapanese
    const lookup = isJapanese ? missingJapanLookup : missingEnglishLookup
    const matchKey =
      collectr.matchKey ||
      buildMatchKey(
        collectr.setName,
        collectr.collectrName,
        collectr.cardNumber,
      )
    const product = matchKey ? lookup.get(matchKey) || null : null
    const embedded = isJapanese ? product?.pokemon_japan_sets : product?.pokemon_sets
    const setEmbed = Array.isArray(embedded) ? embedded[0] ?? null : embedded ?? null
    const collectrSet = collectr.setName || null
    const productSet = setEmbed?.name ?? null
    const normalizedCollectr = collectrSet ? normalizeName(collectrSet) : null
    const normalizedProduct = productSet ? normalizeName(productSet) : null
    const normalizedProductStripped = productSet
      ? normalizeName(stripSetPrefix(productSet))
      : null
    const setMatch =
      normalizedCollectr &&
      (normalizedCollectr === normalizedProduct ||
        normalizedCollectr === normalizedProductStripped)
    results.push({
      tcg_product_id: product?.tcg_product_id ?? null,
      quantity: collectr.quantity,
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
      english_match: collectr.englishMatch || setMatch || false,
    })
  })

  const summary = {
    totalCollectr,
    parsedProducts: productIds.length + missingItems.length,
    matchedProducts: results.filter((r) => r.matched).length,
    skippedGraded,
    skippedNonEnglish,
  }

  return { summary, results }
}
