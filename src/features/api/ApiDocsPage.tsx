import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { ApiKeyRequestRecord, SupabaseSession } from '../shared/types'

type ApiDocsProps = {
  session: SupabaseSession
  onSignIn: () => void
  onSignUp: () => void
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

function ApiDocsPage({ session, onSignIn, onSignUp }: ApiDocsProps) {
  const baseUrl = 'https://api.cardlobby.app'
  const sampleKey = 'YOUR_API_KEY'
  const curlHealth = `curl ${baseUrl}/health \\\n  -H "x-api-key: ${sampleKey}"`
  const curlProducts = `curl "${baseUrl}/products?set_name_id=1374&limit=5" \\\n  -H "x-api-key: ${sampleKey}"`
  const [reason, setReason] = useState('')
  const [requestStatus, setRequestStatus] = useState<
    'idle' | 'sending' | 'sent' | 'error'
  >('idle')
  const [requestMessage, setRequestMessage] = useState<string | null>(null)
  const [requestRecord, setRequestRecord] = useState<ApiKeyRequestRecord | null>(null)
  const [requestLoading, setRequestLoading] = useState(false)
  const isSignedIn = Boolean(session?.user)

  const endpoints = [
    { method: 'GET', path: '/health', description: 'Service health check.' },
    { method: 'GET', path: '/product-lines', description: 'List product lines.' },
    { method: 'GET', path: '/sets', description: 'List sets (filterable).' },
    { method: 'GET', path: '/lookups/conditions', description: 'List conditions.' },
    { method: 'GET', path: '/lookups/rarities', description: 'List rarities.' },
    { method: 'GET', path: '/lookups/printings', description: 'List printings.' },
    { method: 'GET', path: '/products', description: 'Search products + variants.' },
    {
      method: 'GET',
      path: '/products/:productId/variants',
      description: 'All variants for a product.',
    },
    { method: 'GET', path: '/prices/latest', description: 'Latest price for a variant.' },
    { method: 'GET', path: '/prices/history', description: 'Price history for a variant.' },
    { method: 'GET', path: '/script-runs', description: 'Job run history.' },
  ]

  const productFilters = [
    { key: 'set_name_id', desc: 'Filter products by set id (from set-<id>.json).', type: 'int' },
    { key: 'product_id', desc: 'Exact product id (tcg product id).', type: 'int' },
    { key: 'product_name', desc: 'Case-insensitive match (partial).', type: 'string' },
    { key: 'rarity', desc: 'Exact rarity name (case-insensitive).', type: 'string' },
    { key: 'printing', desc: 'Exact printing name (case-insensitive).', type: 'string' },
    { key: 'condition', desc: 'Exact condition name (case-insensitive).', type: 'string' },
    { key: 'limit', desc: 'Page size (max 500).', type: 'int' },
    { key: 'offset', desc: 'Offset for pagination.', type: 'int' },
  ]

  const setFilters = [
    { key: 'product_line_id', desc: 'Filter by product line id.', type: 'int' },
    { key: 'active', desc: 'true | false', type: 'bool' },
    { key: 'name', desc: 'Partial match on set name.', type: 'string' },
  ]

  const priceFilters = [
    { key: 'product_id', desc: 'Product id.', type: 'int' },
    { key: 'condition_id', desc: 'Condition id.', type: 'int' },
    { key: 'rarity_id', desc: 'Rarity id.', type: 'int' },
    { key: 'printing_id', desc: 'Printing id.', type: 'int' },
    { key: 'start', desc: 'Start date YYYY-MM-DD (history only).', type: 'date' },
    { key: 'end', desc: 'End date YYYY-MM-DD (history only).', type: 'date' },
    { key: 'limit', desc: 'Page size (history only).', type: 'int' },
    { key: 'offset', desc: 'Offset (history only).', type: 'int' },
  ]

  const loadRequestStatus = useCallback(async () => {
    if (!isSignedIn || !session?.access_token) {
      setRequestRecord(null)
      return
    }
    setRequestLoading(true)
    try {
      const response = await fetch('/api/request-api-key', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(payload?.error || payload?.message || 'Failed to load request status.')
      }
      setRequestRecord(payload?.request || null)
    } catch (err) {
      setRequestMessage(formatError(err))
      setRequestStatus('error')
    } finally {
      setRequestLoading(false)
    }
  }, [isSignedIn, session?.access_token])

  useEffect(() => {
    void loadRequestStatus()
  }, [loadRequestStatus])

  const submitRequest = async (event: FormEvent) => {
    event.preventDefault()
    setRequestMessage(null)

    if (!isSignedIn || !session?.access_token) {
      setRequestStatus('error')
      setRequestMessage('Please sign in to request an API key.')
      return
    }

    const trimmed = reason.trim()
    if (trimmed.length < 10) {
      setRequestStatus('error')
      setRequestMessage('Please share a brief reason (at least 10 characters).')
      return
    }

    setRequestStatus('sending')
    try {
      const response = await fetch('/api/request-api-key', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ reason: trimmed }),
      })

      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(payload?.error || payload?.message || 'Request failed.')
      }

      setRequestStatus('sent')
      setReason('')
      setRequestRecord(payload?.request || null)
      setRequestMessage(
        payload?.existing
          ? payload?.message || 'You already have a request on file.'
          : 'Request submitted. We will review it soon.',
      )
    } catch (err) {
      setRequestStatus('error')
      setRequestMessage(formatError(err))
    }
  }

  return (
    <section className="api-page">
      <div className="api-hero card-surface">
        <div className="pill">Card Lobby API</div>
        <h1 className="headline">CardHQ public API</h1>
        <p className="lede">
          Query Pokemon products, sets, and daily price history. Built for fast lookups
          and clean client-side integration.
        </p>
        <div className="api-hero-meta">
          <div className="api-meta-card">
            <span className="api-meta-label">Base URL</span>
            <code>{baseUrl}</code>
          </div>
          <div className="api-meta-card">
            <span className="api-meta-label">Auth</span>
            <code>x-api-key</code>
          </div>
          <div className="api-meta-card">
            <span className="api-meta-label">Rate limits</span>
            <span>Per key, per minute (VIP keys can be unlimited).</span>
          </div>
        </div>
      </div>

      <div className="api-grid">
        <div className="api-card">
          <div className="pill muted">Quickstart</div>
          <h2>Test the API</h2>
          <div className="api-code">
            <pre>
              <code>{curlHealth}</code>
            </pre>
          </div>
          <div className="api-code">
            <pre>
              <code>{curlProducts}</code>
            </pre>
          </div>
        </div>
        <div className="api-card">
          <div className="pill muted">Authentication</div>
          <h2>Send your API key</h2>
          <p className="swatch-note">
            Use <code>x-api-key</code> or <code>Authorization: Bearer</code>. If the
            key is missing or inactive, you will receive a 401.
          </p>
          <div className="api-callout">
            <div>
              <strong>Headers returned</strong>
              <p className="swatch-note">
                X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
              </p>
            </div>
            <div>
              <strong>Errors</strong>
              <p className="swatch-note">401 Unauthorized, 429 Rate limit exceeded</p>
            </div>
          </div>
        </div>
        <div className="api-card">
          <div className="pill muted">Pagination</div>
          <h2>limit + offset</h2>
          <p className="swatch-note">
            Most list endpoints accept <code>limit</code> and <code>offset</code>.
            Maximum limit is 500.
          </p>
        </div>
      </div>

      <section className="api-section">
        <div className="api-section-head">
          <div>
            <div className="pill muted">Reference</div>
            <h2>Endpoints</h2>
            <p className="swatch-note">All endpoints are read-only (GET).</p>
          </div>
        </div>
        <div className="api-endpoints">
          {endpoints.map((endpoint) => (
            <div key={endpoint.path} className="api-endpoint">
              <div className="api-endpoint-row">
                <span className="api-method">{endpoint.method}</span>
                <code>{endpoint.path}</code>
              </div>
              <p className="swatch-note">{endpoint.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="api-section">
        <div className="api-section-head">
          <div>
            <div className="pill muted">Filters</div>
            <h2>/products</h2>
            <p className="swatch-note">
              Use filters to narrow down products by set, rarity, printing, and condition.
            </p>
          </div>
        </div>
        <div className="api-param-grid">
          {productFilters.map((filter) => (
            <div key={filter.key} className="api-param">
              <code>{filter.key}</code>
              <span className="api-param-type">{filter.type}</span>
              <p>{filter.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="api-section">
        <div className="api-section-head">
          <div>
            <div className="pill muted">Filters</div>
            <h2>/sets</h2>
            <p className="swatch-note">Filter by product line, status, or name.</p>
          </div>
        </div>
        <div className="api-param-grid">
          {setFilters.map((filter) => (
            <div key={filter.key} className="api-param">
              <code>{filter.key}</code>
              <span className="api-param-type">{filter.type}</span>
              <p>{filter.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="api-section">
        <div className="api-section-head">
          <div>
            <div className="pill muted">Filters</div>
            <h2>/prices/history</h2>
            <p className="swatch-note">Price history requires a specific variant.</p>
          </div>
        </div>
        <div className="api-param-grid">
          {priceFilters.map((filter) => (
            <div key={filter.key} className="api-param">
              <code>{filter.key}</code>
              <span className="api-param-type">{filter.type}</span>
              <p>{filter.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="api-section">
        <div className="api-section-head">
          <div>
            <div className="pill muted">Request Access</div>
            <h2>Request an API key</h2>
            <p className="swatch-note">
              You must be signed in to submit a request. We will review it and
              follow up using your account email.
            </p>
          </div>
        </div>
        <div className="api-request card-surface">
          {isSignedIn ? (
            <>
              <div className="api-request-status">
                {requestLoading ? (
                  <p className="swatch-note">Loading your request status…</p>
                ) : requestRecord ? (
                  <>
                    <div className="api-request-status-head">
                      <span className="swatch-note">Current request status</span>
                      <span className={`pill ${requestRecord.status === 'approved' ? 'success' : requestRecord.status === 'denied' ? 'warning' : 'muted'}`}>
                        {requestRecord.status.toUpperCase()}
                      </span>
                    </div>
                    <p className="swatch-note">
                      Submitted: {new Date(requestRecord.created_at).toLocaleString()}
                    </p>
                    {requestRecord.admin_notes && (
                      <p className="swatch-note">Admin notes: {requestRecord.admin_notes}</p>
                    )}
                    {requestRecord.status === 'approved' && requestRecord.api_key_preview && (
                      <div className="api-request-key">
                        <span className="swatch-note">Your API key preview</span>
                        <code>{requestRecord.api_key_preview}</code>
                        <span className="swatch-note">
                          Full keys are not stored. If you lost it, contact admin for regeneration.
                        </span>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="swatch-note">No API key request submitted yet.</p>
                )}
              </div>

              {!requestRecord ? (
                <form className="api-request-form" onSubmit={submitRequest}>
                  <label className="api-request-label">
                    Reason for API access
                    <textarea
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="Tell us how you plan to use the API."
                      rows={5}
                      required
                    />
                  </label>
                  <div className="api-request-actions">
                    <button
                      className="btn primary"
                      type="submit"
                      disabled={requestStatus === 'sending'}
                    >
                      {requestStatus === 'sending' ? 'Sending…' : 'Submit request'}
                    </button>
                    {session?.user?.email && (
                      <span className="swatch-note">Signed in as {session.user.email}</span>
                    )}
                  </div>
                  {requestMessage && (
                    <div
                      className={
                        requestStatus === 'error' ? 'api-request-error' : 'api-request-success'
                      }
                    >
                      {requestMessage}
                    </div>
                  )}
                </form>
              ) : (
                <>
                  <div className="api-request-locked">
                    <p className="swatch-note">
                      You can only submit one API key request per account.
                    </p>
                  </div>
                  {requestMessage && (
                    <div
                      className={
                        requestStatus === 'error' ? 'api-request-error' : 'api-request-success'
                      }
                    >
                      {requestMessage}
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <div className="api-request-locked">
              <p className="swatch-note">
                Sign in or create an account to request an API key.
              </p>
              <div className="cta-row">
                <button className="btn ghost" onClick={onSignIn}>
                  Sign in
                </button>
                <button className="btn primary" onClick={onSignUp}>
                  Sign up
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </section>
  )
}



export default ApiDocsPage
