import { useCallback, useEffect, useState } from 'react'
import Papa from 'papaparse'
import { supabase } from '../../lib/supabaseClient'
import type { ApiKeyRequestRecord, SupabaseSession, UploadStatus } from '../shared/types'

type CardRow = {
  productId: number
  categoryId?: number | null
  groupId?: number | null
  name: string
  cleanName: string
  extNumber?: string | null
  subTypeName?: string | null
  extRarity?: string | null
  extCardType?: string | null
  extHP?: string | null
  extStage?: string | null
  extAttack1?: string | null
  extAttack2?: string | null
  extWeakness?: string | null
  extResistance?: string | null
  extRetreatCost?: string | null
  imageUrl?: string | null
  imageCount?: number | null
  url?: string | null
  modifiedOn?: string | null
  lowPrice?: number | null
  midPrice?: number | null
  highPrice?: number | null
  marketPrice?: number | null
  directLowPrice?: number | null
}

type AdminPortalProps = {
  session: SupabaseSession
}

const chunkRows = <T,>(arr: T[], size: number) => {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}

const toIso = (value: unknown): string => {
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return new Date().toISOString()
}

const formatError = (err: unknown): string => {
  if (err === null || err === undefined) return 'Unknown error'
  if (typeof err === 'string') return err
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'object') {
    const maybeMessage = (err as { message?: unknown }).message
    if (typeof maybeMessage === 'string' && maybeMessage.trim().length > 0) {
      return maybeMessage
    }
    const maybeError = (err as { error?: unknown }).error
    if (typeof maybeError === 'string' && maybeError.trim().length > 0) {
      return maybeError
    }
    try {
      return JSON.stringify(err, Object.getOwnPropertyNames(err))
    } catch {
      return String(err)
    }
  }
  return String(err)
}

const parseCardNumber = (extNumber?: string | number | null): number | null => {
  if (extNumber === undefined || extNumber === null) return null
  if (typeof extNumber === 'number' && Number.isFinite(extNumber)) {
    return extNumber
  }
  if (typeof extNumber === 'string') {
    const match = extNumber.match(/(\d{1,4})\s*\/\s*(\d{1,4})/)?.[1]
    if (match) return Number(match)
    const solo = extNumber.match(/^\s*(\d{1,4})\s*$/)?.[1]
    if (solo) return Number(solo)
    const loose = extNumber.match(/(\d{1,4})/)
    if (loose) return Number(loose[1])
    return null
  }
  return null
}

function AdminPortal({ session }: AdminPortalProps) {
  const [file, setFile] = useState<File | null>(null)
  const [status, setStatus] = useState<UploadStatus>({ state: 'idle' })
  const [tcgTypeName, setTcgTypeName] = useState('Pokemon TCG')
  const [setName, setSetName] = useState('Mega Evolution — Ascended Heroes')
  const [setCode, setSetCode] = useState('MEA')
  const [replaceProducts, setReplaceProducts] = useState(false)

  const handleUpload = () => {
    if (!file) return
    setStatus({ state: 'parsing' })

    Papa.parse<CardRow>(file, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
      complete: async (result) => {
        const rows: CardRow[] = (result.data || []).filter((r) => r.productId)
        try {
          // Derive set/group/category ids from the CSV
          const first = rows[0]
          const tcgCategoryId = first?.categoryId ?? null
          const tcgGroupId = first?.groupId ?? null

          // Upsert TCG type
          const { data: typeData, error: typeError } = await supabase
            .from('tcg_types')
            .upsert({ name: tcgTypeName }, { onConflict: 'name' })
            .select('id')
            .single()
          if (typeError) throw typeError
          const categoryId = typeData.id

          // Upsert set
          const { data: setData, error: setError } = await supabase
            .from('pokemon_sets')
            .upsert(
              {
                name: setName,
                code: setCode || null,
                region: 'EN',
                tcg_type_id: categoryId,
                tcg_group_id: tcgGroupId,
                tcg_category_id: tcgCategoryId,
              },
              { onConflict: 'code,region' },
            )
            .select('id')
            .single()
          if (setError) throw setError
          const setId = setData.id

          if (replaceProducts) {
            setStatus({ state: 'uploading', progress: 'Clearing existing products' })
            const { error: deleteErr } = await supabase
              .from('pokemon_products')
              .delete()
              .eq('set_id', setId)
            if (deleteErr) throw deleteErr
          }

          // De-dupe products by tcg_product_id and keep the latest price snapshot per product.
          const productMap = new Map<
            number,
            { row: Record<string, unknown>; priceUpdatedAt: number }
          >()
          rows.forEach((row) => {
            const productId = row.productId
            if (!productId) return
            const capturedAt = toIso(row.modifiedOn)
            const capturedTime = Date.parse(capturedAt)

            const baseRow = {
              tcg_product_id: productId,
              name: row.name,
              clean_name: row.cleanName,
              product_type: parseCardNumber(row.extNumber) === null ? 'sealed' : 'single',
              subtype: row.subTypeName,
              card_number: row.extNumber,
              rarity: row.extRarity,
              card_type: row.extCardType,
              hp: row.extHP,
              stage: row.extStage,
              attack1: row.extAttack1,
              attack2: row.extAttack2,
              weakness: row.extWeakness,
              resistance: row.extResistance,
              retreat_cost: row.extRetreatCost,
              image_url: row.imageUrl,
              image_count: row.imageCount,
              external_url: row.url,
              modified_on: row.modifiedOn || null,
              set_id: setId,
              region: 'EN',
            }

            const priceRow = {
              low_price: toNumber(row.lowPrice),
              mid_price: toNumber(row.midPrice),
              high_price: toNumber(row.highPrice),
              market_price: toNumber(row.marketPrice),
              direct_low_price: toNumber(row.directLowPrice),
              currency: 'USD',
              price_updated_at: capturedAt,
              modified_on: capturedAt,
            }

            const existing = productMap.get(productId)
            if (!existing) {
              productMap.set(productId, {
                row: { ...baseRow, ...priceRow },
                priceUpdatedAt: Number.isFinite(capturedTime) ? capturedTime : 0,
              })
              return
            }

            const nextRow = { ...existing.row, ...baseRow }
            const nextTime = Number.isFinite(capturedTime) ? capturedTime : existing.priceUpdatedAt
            if (nextTime >= existing.priceUpdatedAt) {
              Object.assign(nextRow, priceRow)
              existing.priceUpdatedAt = nextTime
            }
            existing.row = nextRow
          })

          const products = Array.from(productMap.values()).map((entry) => entry.row)
          const productChunks = chunkRows(products, 400)

          for (let i = 0; i < productChunks.length; i++) {
            setStatus({
              state: 'uploading',
              progress: `Upserting products ${i + 1}/${productChunks.length}`,
            })
            const { error } = await supabase
              .from('pokemon_products')
              .upsert(productChunks[i], { onConflict: 'tcg_product_id,region' })
            if (error) throw error
          }

          setStatus({
            state: 'done',
            message: `Imported ${products.length} products.`,
          })
        } catch (err) {
          setStatus({ state: 'error', message: formatError(err) || 'Upload failed' })
        }
      },
      error: (err) => setStatus({ state: 'error', message: formatError(err) }),
    })
  }

  return (
    <div className="admin-stack">
      <div className="admin-panel card-surface">
        <div className="admin-panel-head">
          <div>
            <div className="pill">CSV import</div>
            <h2>Upload TCG CSV</h2>
            <p className="swatch-note">
              Maps CSV rows to Supabase `pokemon_products` with current prices. Only admin can run.
            </p>
          </div>
          <div className="admin-actions">
            <input
              type="text"
              value={tcgTypeName}
              onChange={(e) => setTcgTypeName(e.target.value)}
              placeholder="TCG type name"
            />
            <input
              type="text"
              value={setName}
              onChange={(e) => setSetName(e.target.value)}
              placeholder="Set name"
            />
            <input
              type="text"
              value={setCode}
              onChange={(e) => setSetCode(e.target.value)}
              placeholder="Set code"
            />
            <label className="toggle">
              <input
                type="checkbox"
                checked={replaceProducts}
                onChange={(e) => setReplaceProducts(e.target.checked)}
              />
              Replace products in set
            </label>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <button className="btn primary" onClick={handleUpload} disabled={!file || status.state === 'uploading'}>
              {status.state === 'uploading' ? 'Uploading…' : 'Start import'}
            </button>
          </div>
        </div>
        <div className="admin-status">
          {status.state === 'idle' && <span>Choose a CSV to begin.</span>}
          {status.state === 'parsing' && <span>Parsing CSV…</span>}
          {status.state === 'uploading' && <span>{status.progress}</span>}
          {status.state === 'done' && <span className="success">{status.message}</span>}
          {status.state === 'error' && <span className="error">{status.message}</span>}
        </div>
      </div>
      <ApiKeyRequestsAdmin session={session} />
    </div>
  )
}

function ApiKeyRequestsAdmin({ session }: { session: SupabaseSession }) {
  const [requests, setRequests] = useState<ApiKeyRequestRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [issuedKeyOnce, setIssuedKeyOnce] = useState<string | null>(null)
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({})
  const [rateDrafts, setRateDrafts] = useState<Record<string, string>>({})
  const [unlimitedDrafts, setUnlimitedDrafts] = useState<Record<string, boolean>>({})

  const loadRequests = useCallback(async () => {
    if (!session?.access_token) return
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/admin-api-key-requests', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })

      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(payload?.error || payload?.message || 'Failed to load requests.')
      }

      const nextRequests = Array.isArray(payload?.requests)
        ? (payload.requests as ApiKeyRequestRecord[])
        : []
      setRequests(nextRequests)
    } catch (err) {
      setError(formatError(err))
    } finally {
      setLoading(false)
    }
  }, [session?.access_token])

  useEffect(() => {
    void loadRequests()
  }, [loadRequests])

  const runAction = async (
    requestId: string,
    action: 'approve' | 'deny' | 'regenerate',
  ) => {
    if (!session?.access_token) return
    setBusyRequestId(requestId)
    setError(null)
    setActionMessage(null)
    setIssuedKeyOnce(null)

    const rateRaw = String(rateDrafts[requestId] || '').trim()
    const isUnlimited = !!unlimitedDrafts[requestId]
    const rateLimitPerMin = rateRaw.length > 0 ? Number(rateRaw) : null
    if (
      (action === 'approve' || action === 'regenerate') &&
      !isUnlimited &&
      rateRaw.length > 0 &&
      (!Number.isFinite(rateLimitPerMin) || (rateLimitPerMin as number) <= 0)
    ) {
      setBusyRequestId(null)
      setError('Rate limit must be a positive number.')
      return
    }

    try {
      const response = await fetch('/api/admin-api-key-requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          requestId,
          action,
          adminNotes: noteDrafts[requestId] || '',
          isUnlimited,
          rateLimitPerMin:
            action === 'approve' || action === 'regenerate'
              ? isUnlimited
                ? null
                : rateRaw.length > 0
                  ? Number(rateRaw)
                  : 120
              : null,
        }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(payload?.error || payload?.message || 'Action failed.')
      }

      setActionMessage(
        action === 'approve'
          ? 'Request approved and API key generated.'
          : action === 'regenerate'
            ? 'API key regenerated.'
            : 'Request denied.',
      )
      if (typeof payload?.issuedApiKeyOnce === 'string' && payload.issuedApiKeyOnce.trim()) {
        setIssuedKeyOnce(payload.issuedApiKeyOnce.trim())
      }
      await loadRequests()
    } catch (err) {
      setError(formatError(err))
    } finally {
      setBusyRequestId(null)
    }
  }

  const pendingCount = requests.filter((row) => row.status === 'pending').length

  const formatDateTime = (value?: string | null) => {
    if (!value) return '-'
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return value
    return parsed.toLocaleString()
  }

  return (
    <div className="admin-panel card-surface">
      <div className="admin-panel-head">
        <div>
          <div className="pill">API key requests</div>
          <h2>Review API access requests</h2>
          <p className="swatch-note">
            Pending: {pendingCount} · Total requests: {requests.length}
          </p>
        </div>
        <div className="admin-actions">
          <button className="btn ghost" onClick={() => void loadRequests()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="admin-status">
        {error && <span className="error">{error}</span>}
        {!error && actionMessage && <span className="success">{actionMessage}</span>}
        {!error && issuedKeyOnce && (
          <div className="api-admin-key">
            <span className="swatch-note">Copy now: one-time API key</span>
            <code>{issuedKeyOnce}</code>
          </div>
        )}
        {!error && !actionMessage && loading && <span>Loading requests…</span>}
        {!error && !actionMessage && !loading && requests.length === 0 && (
          <span>No API key requests yet.</span>
        )}
      </div>

      <div className="api-admin-list">
        {requests.map((request) => {
          const isBusy = busyRequestId === request.request_id
          return (
            <article key={request.request_id} className="api-admin-item">
              <div className="api-admin-item-head">
                <div className="pill muted">{request.status.toUpperCase()}</div>
                <span className="swatch-note">
                  Requested {formatDateTime(request.created_at)}
                </span>
              </div>
              <div className="api-admin-meta">
                <strong>{request.email || request.user_id || 'Unknown user'}</strong>
                <span>Request ID: {request.request_id}</span>
              </div>
              <p className="api-admin-reason">{request.reason}</p>

              {request.status === 'approved' && request.api_key_preview && (
                <div className="api-admin-key">
                  <span className="swatch-note">Current key preview</span>
                  <code>{request.api_key_preview}</code>
                </div>
              )}

              {request.admin_notes && (
                <p className="swatch-note">Admin notes: {request.admin_notes}</p>
              )}

              {request.status === 'pending' && (
                <div className="api-admin-actions">
                  <input
                    type="number"
                    min="1"
                    placeholder="Rate limit / min (default 120)"
                    value={rateDrafts[request.request_id] || ''}
                    onChange={(event) =>
                      setRateDrafts((prev) => ({
                        ...prev,
                        [request.request_id]: event.target.value,
                      }))
                    }
                    disabled={isBusy}
                  />
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={!!unlimitedDrafts[request.request_id]}
                      onChange={(event) =>
                        setUnlimitedDrafts((prev) => ({
                          ...prev,
                          [request.request_id]: event.target.checked,
                        }))
                      }
                      disabled={isBusy}
                    />
                    Unlimited
                  </label>
                  <textarea
                    rows={2}
                    placeholder="Admin notes (optional)"
                    value={noteDrafts[request.request_id] || ''}
                    onChange={(event) =>
                      setNoteDrafts((prev) => ({
                        ...prev,
                        [request.request_id]: event.target.value,
                      }))
                    }
                    disabled={isBusy}
                  />
                  <div className="api-admin-action-row">
                    <button
                      className="btn primary"
                      onClick={() => void runAction(request.request_id, 'approve')}
                      disabled={isBusy}
                    >
                      {isBusy ? 'Processing…' : 'Approve + Generate Key'}
                    </button>
                    <button
                      className="btn ghost"
                      onClick={() => void runAction(request.request_id, 'deny')}
                      disabled={isBusy}
                    >
                      Deny
                    </button>
                  </div>
                </div>
              )}

              {request.status === 'approved' && (
                <div className="api-admin-actions">
                  <input
                    type="number"
                    min="1"
                    placeholder="Rate limit / min (optional on regenerate)"
                    value={rateDrafts[request.request_id] || ''}
                    onChange={(event) =>
                      setRateDrafts((prev) => ({
                        ...prev,
                        [request.request_id]: event.target.value,
                      }))
                    }
                    disabled={isBusy}
                  />
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={!!unlimitedDrafts[request.request_id]}
                      onChange={(event) =>
                        setUnlimitedDrafts((prev) => ({
                          ...prev,
                          [request.request_id]: event.target.checked,
                        }))
                      }
                      disabled={isBusy}
                    />
                    Unlimited
                  </label>
                  <textarea
                    rows={2}
                    placeholder="Admin notes (optional)"
                    value={noteDrafts[request.request_id] || ''}
                    onChange={(event) =>
                      setNoteDrafts((prev) => ({
                        ...prev,
                        [request.request_id]: event.target.value,
                      }))
                    }
                    disabled={isBusy}
                  />
                  <div className="api-admin-action-row">
                    <button
                      className="btn ghost"
                      onClick={() => void runAction(request.request_id, 'regenerate')}
                      disabled={isBusy}
                    >
                      {isBusy ? 'Processing…' : 'Regenerate Key'}
                    </button>
                  </div>
                </div>
              )}
            </article>
          )
        })}
      </div>
    </div>
  )
}


export default AdminPortal
