import { fetchCardhqJson, getCardhqConfigError } from './_cardhq-client.js'

const toInt = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.floor(number)
}

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

  const setNameId = toInt(Array.isArray(req.query?.set_name_id) ? req.query.set_name_id[0] : req.query?.set_name_id)
  if (!setNameId || setNameId <= 0) {
    res.status(400).json({ error: 'set_name_id is required.' })
    return
  }

  const limitRaw = toInt(Array.isArray(req.query?.limit) ? req.query.limit[0] : req.query?.limit)
  const offsetRaw = toInt(Array.isArray(req.query?.offset) ? req.query.offset[0] : req.query?.offset)
  const limit = limitRaw && limitRaw > 0 ? Math.min(limitRaw, 500) : 500
  const offset = offsetRaw && offsetRaw >= 0 ? offsetRaw : 0

  const params = new URLSearchParams()
  params.set('set_name_id', String(setNameId))
  params.set('limit', String(limit))
  params.set('offset', String(offset))

  try {
    const payload = await fetchCardhqJson('/products', params)
    const rows = Array.isArray(payload) ? payload : []
    res.status(200).json({
      set_name_id: setNameId,
      limit,
      offset,
      rows,
    })
  } catch (error) {
    const message =
      error instanceof Error && error.message ? error.message : 'Failed to load products.'
    res.status(502).json({ error: message })
  }
}
