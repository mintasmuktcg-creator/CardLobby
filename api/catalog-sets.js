import {
  fetchCardhqJson,
  getCardhqConfigError,
  normalizeRegion,
  productLineIdForRegion,
} from './_cardhq-client.js'

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const configError = getCardhqConfigError()
  if (configError) {
    res.status(500).json({ error: configError })
    return
  }

  const region = normalizeRegion(Array.isArray(req.query?.region) ? req.query.region[0] : req.query?.region)
  const productLineId = productLineIdForRegion(region)
  const params = new URLSearchParams()
  params.set('product_line_id', String(productLineId))
  params.set('active', 'true')

  try {
    const payload = await fetchCardhqJson('/sets', params)
    const rows = Array.isArray(payload) ? payload : []
    res.status(200).json({
      region,
      product_line_id: productLineId,
      rows,
    })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to load sets.'
    res.status(502).json({ error: message })
  }
}
