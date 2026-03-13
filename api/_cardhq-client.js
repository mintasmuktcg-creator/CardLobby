const CARDHQ_API_BASE_URL = String(
  process.env.CARDHQ_API_BASE_URL || 'https://api.cardlobby.app',
)
  .trim()
  .replace(/\/+$/, '')

const CARDHQ_API_KEY = String(
  process.env.CARDHQ_API_KEY || process.env.CARDHQ_ADMIN_API_KEY || '',
).trim()

const CARDHQ_TIMEOUT_MS = (() => {
  const raw = Number(process.env.CARDHQ_API_TIMEOUT_MS)
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw)
  return 15000
})()

const REGION_TO_PRODUCT_LINE_ID = {
  EN: 3,
  JP: 85,
}

export const normalizeRegion = (value) => {
  const upper = String(value || 'EN').trim().toUpperCase()
  return upper === 'JP' ? 'JP' : 'EN'
}

export const productLineIdForRegion = (region) => {
  return REGION_TO_PRODUCT_LINE_ID[normalizeRegion(region)]
}

export const getCardhqConfigError = () => {
  if (!CARDHQ_API_BASE_URL) {
    return 'CARDHQ_API_BASE_URL is required.'
  }
  if (!CARDHQ_API_KEY) {
    return 'CARDHQ_API_KEY is required.'
  }
  return null
}

export const fetchCardhqJson = async (pathname, searchParams = new URLSearchParams()) => {
  const url = new URL(pathname, `${CARDHQ_API_BASE_URL}/`)
  url.search = searchParams.toString()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CARDHQ_TIMEOUT_MS)

  try {
    const response = await fetch(url.toString(), {
      headers: {
        'x-api-key': CARDHQ_API_KEY,
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
