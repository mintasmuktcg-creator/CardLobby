import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import Papa from 'papaparse'
import { supabase } from './lib/supabaseClient'
import type { SupabaseSession } from './features/shared/types'
import AdminPortal from './features/admin/AdminPortal'
import CollectrImporter from './features/collectr/CollectrImporter'
import ApiDocsPage from './features/api/ApiDocsPage'
import {
  fetchCatalogProducts,
  fetchCatalogSets,
  selectPreferredProductRows,
} from './lib/catalogApi'
import './App.css'

const CSV_FALLBACK_URL = new URL(
  '../CardCSVs/MEAscendedHeroesProductsAndPrices.csv',
  import.meta.url,
).toString()

const CSV_FALLBACK_SET_TITLE = 'Mega Evolution — Ascended Heroes'
type CatalogKey = 'pokemon' | 'pokemon_japan'

const CATALOGS = {
  pokemon: {
    label: 'Pokemon',
    region: 'EN',
    storageKey: 'cardlobby.selected_set_id.pokemon',
  },
  pokemon_japan: {
    label: 'Pokemon Japan',
    region: 'JP',
    storageKey: 'cardlobby.selected_set_id.pokemon_japan',
  },
} as const

const getInitialCatalog = (): CatalogKey => {
  if (typeof window === 'undefined') return 'pokemon'
  const saved = window.localStorage.getItem('cardlobby.selected_catalog')
  return saved === 'pokemon_japan' ? 'pokemon_japan' : 'pokemon'
}

type CardRow = {
  productId: number
  region: 'EN' | 'JP'
  conditionId: number
  rarityId: number
  printingId: number
  productType?: string | null
  name: string
  cleanName: string
  imageUrl?: string | null
  setId?: string | null
  setName?: string | null
  categoryId?: number | null
  groupId?: number | null
  lowPrice?: number | null
  midPrice?: number | null
  highPrice?: number | null
  marketPrice?: number | null
  extNumber?: string | null
  extRarity?: string | null
  extCardType?: string | null
  extCardText?: string | null
  extAttack1?: string | null
  extAttack2?: string | null
  imageCount?: number | null
  subTypeName?: string | null
  extHP?: string | null
  extStage?: string | null
  extWeakness?: string | null
  extResistance?: string | null
  extRetreatCost?: string | null
  url?: string | null
  modifiedOn?: string | null
  directLowPrice?: number | null
}

function formatPrice(value: number | null | undefined) {
  if (value === undefined || value === null || Number.isNaN(value)) return '-'
  return `$${value.toFixed(2)}`
}

function parseCardNumber(extNumber?: string | number | null): number | null {
  if (extNumber === undefined || extNumber === null) return null
  if (typeof extNumber === 'number' && Number.isFinite(extNumber)) {
    return extNumber
  }
  if (typeof extNumber === 'string') {
    // Examples: "175/217", "001/099", "180"
    const match = extNumber.match(/(\d{1,4})\s*\/\s*(\d{1,4})/)?.[1]
    if (match) return Number(match)
    // If only a number (no slash) and at least 1 digit, accept it too.
    const solo = extNumber.match(/^\s*(\d{1,4})\s*$/)?.[1]
    if (solo) return Number(solo)
    // Fallback: grab the first digit run anywhere in the string.
    const loose = extNumber.match(/(\d{1,4})/)
    if (loose) return Number(loose[1])
    // Otherwise, treat as no number.
    return null
  }
  return null
}

function normalizeCardNumber(value?: string | number | null) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') return value.trim()
  return ''
}

function getCardNumberSortKey(value?: string | number | null) {
  const raw = normalizeCardNumber(value)
  if (!raw) {
    return { group: 2, number: Number.POSITIVE_INFINITY, prefix: '', raw: '' }
  }

  const numericOnly = /^\d{1,4}(?:\s*\/\s*\d{1,4})?$/.test(raw)
  if (numericOnly) {
    return { group: 0, number: parseCardNumber(raw) ?? Number.POSITIVE_INFINITY, prefix: '', raw }
  }

  const match = raw.match(/^([A-Za-z]+)\s*([0-9]{1,4})/)
  const prefix = match?.[1]?.toUpperCase() ?? raw.toUpperCase()
  const number = match?.[2] ? Number(match[2]) : Number.POSITIVE_INFINITY
  return { group: 1, number, prefix, raw }
}

function compareCardOrder(a: CardRow, b: CardRow) {
  const aKey = getCardNumberSortKey(a.extNumber)
  const bKey = getCardNumberSortKey(b.extNumber)
  if (aKey.group !== bKey.group) return aKey.group - bKey.group

  if (aKey.group === 0) {
    if (aKey.number !== bKey.number) return aKey.number - bKey.number
    return aKey.raw.localeCompare(bKey.raw)
  }

  if (aKey.prefix !== bKey.prefix) return aKey.prefix.localeCompare(bKey.prefix)
  if (aKey.number !== bKey.number) return aKey.number - bKey.number
  return aKey.raw.localeCompare(bKey.raw)
}

function getCardKey(card: CardRow) {
  return [
    card.region || 'EN',
    card.productId,
    card.conditionId,
    card.rarityId,
    card.printingId,
  ].join('|')
}

function normalizeSubtype(value?: string | null) {
  return (value || 'Other').trim() || 'Other'
}

function isSingleCard(card: CardRow) {
  if (card.productType) return card.productType === 'single'
  const numberParsed = parseCardNumber(card.extNumber)
  return numberParsed !== null
}

const chunk = <T,>(arr: T[], size: number) => {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

type SetInfo = {
  id: string
  name: string
  code?: string | null
  releaseDate?: string | null
  generation?: number | null
}

function hydrateCards(
  rows: CardRow[],
  setCardsFn?: (r: CardRow[]) => void,
  setSubtypesFn?: (s: string[]) => void,
  setFiltersFn?: (s: Set<string>) => void,
) {
  const sorted = rows.sort((a: CardRow, b: CardRow) => {
    const byNumber = compareCardOrder(a, b)
    if (byNumber !== 0) return byNumber
    return (a.name || '').localeCompare(b.name || '')
  })
  const subtypeSet = new Set<string>()
  sorted.forEach((row) => {
    if (!isSingleCard(row)) return
    subtypeSet.add(normalizeSubtype(row.subTypeName))
  })
  const subtypeList = Array.from(subtypeSet).sort((a, b) => a.localeCompare(b))
  if (setCardsFn) setCardsFn(sorted)
  if (setSubtypesFn) setSubtypesFn(subtypeList)
  if (setFiltersFn) setFiltersFn(new Set(subtypeList))
}

function App() {
  const [cards, setCards] = useState<CardRow[]>([])
  const [sets, setSets] = useState<SetInfo[]>([])
  const [catalog, setCatalog] = useState<CatalogKey>(getInitialCatalog)
  const [selectedSetId, setSelectedSetId] = useState<string>('all')
  const [viewMode, setViewMode] = useState<'singles' | 'sealed'>('singles')
  const [availableSubtypes, setAvailableSubtypes] = useState<string[]>([])
  const [subtypeFilters, setSubtypeFilters] = useState<Set<string>>(new Set())
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin')
  const [authMessage, setAuthMessage] = useState<string | null>(null)
  const [session, setSession] = useState<SupabaseSession>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [adminCheckLoading, setAdminCheckLoading] = useState(false)
  const [path, setPath] = useState(window.location.pathname)
  const [loading, setLoading] = useState(false)
  const [ownedCounts, setOwnedCounts] = useState<Record<string, number>>({})
  const [confirmAction, setConfirmAction] = useState<'catch' | 'release' | null>(null)
  const [pendingScroll, setPendingScroll] = useState<number | null>(null)
  const [authOpen, setAuthOpen] = useState(false)
  const catalogConfig = CATALOGS[catalog]
  const ownedTable = 'user_owned_products'
  const ownedEnabled = true

  useEffect(() => {
    const fromCsvFallback = async () => {
      if (catalog !== 'pokemon') {
        setSets([])
        setSelectedSetId('all')
        setLoading(false)
        return
      }
      setLoading(true)
      try {
        const response = await fetch(CSV_FALLBACK_URL)
        if (!response.ok) {
          throw new Error(`Failed to fetch fallback CSV (${response.status})`)
        }
        const csvText = await response.text()
        Papa.parse<CardRow>(csvText, {
          header: true,
          skipEmptyLines: true,
          dynamicTyping: true,
          complete: (result) => {
            const parsed = (result.data || [])
              .filter((row: CardRow) => !!row.productId)
              .map((row: CardRow) => ({
                ...row,
                region: catalogConfig.region,
                conditionId: Number(row.conditionId) || 0,
                rarityId: Number(row.rarityId) || 0,
                printingId: Number(row.printingId) || 0,
                name: row.name || 'Unknown product',
                cleanName: row.cleanName || row.name || 'Unknown product',
              }))
            hydrateCards(parsed, setCards, setAvailableSubtypes, setSubtypeFilters)
            setSets([{ id: 'csv-set', name: CSV_FALLBACK_SET_TITLE }])
            setSelectedSetId('csv-set')
            setLoading(false)
          },
          error: () => {
            setLoading(false)
          },
        })
      } catch {
        setLoading(false)
      }
    }

    const fromCatalogApi = async () => {
      setLoading(true)
      try {
        const setRows = await fetchCatalogSets(catalogConfig.region)
        const setList: SetInfo[] = setRows.map((row) => ({
          id: String(row.set_name_id),
          name: row.name,
          code: row.abbreviation ?? null,
          releaseDate: row.release_date ?? null,
          generation: null,
        }))

        setList.sort((a, b) => {
          const aDate = a.releaseDate ? Date.parse(a.releaseDate) : Number.POSITIVE_INFINITY
          const bDate = b.releaseDate ? Date.parse(b.releaseDate) : Number.POSITIVE_INFINITY
          if (aDate !== bDate) return aDate - bDate
          return a.name.localeCompare(b.name)
        })

        setSets(setList)
        const saved = localStorage.getItem(catalogConfig.storageKey)
        const savedExists = !!saved && setList.some((entry) => entry.id === saved)
        const defaultId =
          (savedExists ? saved : null) ||
          setList.find((entry) => entry.name.toLowerCase().includes('ascended heroes'))?.id ||
          setList[0]?.id ||
          'all'
        setSelectedSetId(defaultId)
      } catch (error) {
        console.error('Failed to load catalog sets from API:', error)
        void fromCsvFallback()
      } finally {
        setLoading(false)
      }
    }

    void fromCatalogApi()
  }, [catalog, catalogConfig.region, catalogConfig.storageKey])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('cardlobby.selected_catalog', catalog)
    }
  }, [catalog])

  useEffect(() => {
    setSelectedSetId('all')
    setCards([])
    setAvailableSubtypes([])
    setSubtypeFilters(new Set())
    setOwnedCounts({})
    setConfirmAction(null)
  }, [catalog])

  useEffect(() => {
    // CSV fallback mode (used when API sets can't load). Don't query by set id.
    if (selectedSetId === 'csv-set') return

    if (!selectedSetId || selectedSetId === 'all') {
      localStorage.removeItem(catalogConfig.storageKey)
      setCards([])
      setAvailableSubtypes([])
      setSubtypeFilters(new Set())
      return
    }

    localStorage.setItem(catalogConfig.storageKey, selectedSetId)

    let cancelled = false

    const loadSet = async () => {
      setLoading(true)
      setCards([])
      setAvailableSubtypes([])
      setSubtypeFilters(new Set())

      try {
        const setNameId = Number.parseInt(selectedSetId, 10)
        if (!Number.isFinite(setNameId) || setNameId <= 0) {
          throw new Error('Invalid set id.')
        }

        const apiRows = await fetchCatalogProducts(setNameId)
        const preferredRows = selectPreferredProductRows(apiRows)
        if (cancelled) return

        const mapped: CardRow[] = preferredRows
          .map((product) => {
            const productId = Number(product?.product_id)
            const productName = String(product?.product_name || '').trim()
            const cardNumber = product?.number ? String(product.number).trim() : null
            const inferredType = parseCardNumber(cardNumber) !== null ? 'single' : 'sealed'
            return {
              productId: Number.isFinite(productId) ? productId : 0,
              region: catalogConfig.region,
              conditionId: Number(product?.condition_id) || 0,
              rarityId: Number(product?.rarity_id) || 0,
              printingId: Number(product?.printing_id) || 0,
              productType: inferredType,
              name: productName || 'Unknown product',
              cleanName: productName || 'Unknown product',
              setId: selectedSetId,
              setName: product?.set_name ?? null,
              imageUrl: product?.image_url ?? null,
              marketPrice: product?.market_price ?? null,
              extNumber: cardNumber,
              extRarity: product?.rarity ?? null,
              extCardType: product?.printing ?? null,
              subTypeName: product?.printing ?? null,
            }
          })
          .filter((row) => row.productId > 0)

        hydrateCards(mapped, setCards, setAvailableSubtypes, setSubtypeFilters)
      } catch (err) {
        console.error('Failed to load set products:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadSet()

    return () => {
      cancelled = true
    }
  }, [catalogConfig.region, catalogConfig.storageKey, selectedSetId])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, currentSession) => setSession(currentSession),
    )
    return () => {
      listener.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual'
    }
    window.scrollTo({ top: 0, behavior: 'auto' })
    return () => {
      if ('scrollRestoration' in window.history) {
        window.history.scrollRestoration = 'auto'
      }
    }
  }, [])

  useEffect(() => {
    if (session) {
      setAuthOpen(false)
    }
  }, [session])

  useEffect(() => {
    let cancelled = false

    const loadAdminStatus = async () => {
      if (!session?.access_token) {
        setIsAdmin(false)
        setAdminCheckLoading(false)
        return
      }

      setAdminCheckLoading(true)
      try {
        const response = await fetch('/api/admin-auth', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        })
        if (!response.ok) {
          if (!cancelled) setIsAdmin(false)
          return
        }

        const payload = await response.json().catch(() => ({}))
        if (!cancelled) {
          setIsAdmin(Boolean(payload?.isAdmin))
        }
      } catch {
        if (!cancelled) setIsAdmin(false)
      } finally {
        if (!cancelled) setAdminCheckLoading(false)
      }
    }

    void loadAdminStatus()

    return () => {
      cancelled = true
    }
  }, [session?.access_token])

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const normalizedPath =
    path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path

  const isAdminRoute = normalizedPath === '/admin'
  const isCollectrRoute = normalizedPath === '/collectr-importer'
  const isApiRoute = normalizedPath === '/api'

  const go = (to: string) => {
    if (window.location.pathname !== to) {
      window.history.pushState({}, '', to)
      setPath(to)
    }
  }

  const openAuthModal = (mode: 'signin' | 'signup') => {
    setAuthMode(mode)
    setAuthMessage(null)
    setAuthOpen(true)
  }

  const setViewModeWithScroll = (nextMode: 'singles' | 'sealed') => {
    if (nextMode === viewMode) return
    setPendingScroll(window.scrollY)
    setViewMode(nextMode)
  }

  useLayoutEffect(() => {
    if (pendingScroll === null) return
    const target = pendingScroll
    setPendingScroll(null)
    requestAnimationFrame(() => {
      window.scrollTo({ top: target, behavior: 'auto' })
    })
  }, [viewMode, pendingScroll])

  const filteredCards = useMemo(() => {
    return cards.filter((card) => {
      const single = isSingleCard(card)
      if (viewMode === 'singles' && !single) return false
      if (viewMode === 'sealed' && single) return false
      if (single && subtypeFilters.size > 0) {
        const label = normalizeSubtype(card.subTypeName)
        if (!subtypeFilters.has(label)) return false
      }
      return true
    })
  }, [cards, viewMode, subtypeFilters])

  const visibleCards = useMemo(() => {
    const sorted = [...filteredCards].sort((a, b) => {
      const byNumber = compareCardOrder(a, b)
      if (byNumber !== 0) return byNumber
      return (a.name || '').localeCompare(b.name || '')
    })
    return sorted
  }, [filteredCards])

  const persistOwnedUpdates = async (
    updates: {
      product_id: number
      region: 'EN' | 'JP'
      condition_id: number
      rarity_id: number
      printing_id: number
      quantity: number
    }[],
    deletes: {
      product_id: number
      region: 'EN' | 'JP'
      condition_id: number
      rarity_id: number
      printing_id: number
    }[],
  ) => {
    if (!session || !ownedEnabled) return
    const userId = session.user.id
    if (updates.length) {
      const updateChunks = chunk(updates, 400)
      for (const group of updateChunks) {
        const rows = group.map((row) => ({
          user_id: userId,
          product_id: row.product_id,
          region: row.region,
          condition_id: row.condition_id,
          rarity_id: row.rarity_id,
          printing_id: row.printing_id,
          quantity: row.quantity,
        }))
        const { error } = await supabase
          .from(ownedTable)
          .upsert(rows, {
            onConflict: 'user_id,product_id,region,condition_id,rarity_id,printing_id',
          })
        if (error) console.error('Failed to save owned products', error)
      }
    }
    if (deletes.length) {
      const deleteChunks = chunk(deletes, 50)
      for (const group of deleteChunks) {
        await Promise.all(
          group.map(async (row) => {
            const { error } = await supabase
              .from(ownedTable)
              .delete()
              .eq('user_id', userId)
              .eq('product_id', row.product_id)
              .eq('region', row.region)
              .eq('condition_id', row.condition_id)
              .eq('rarity_id', row.rarity_id)
              .eq('printing_id', row.printing_id)
            if (error) console.error('Failed to remove owned products', error)
          }),
        )
      }
    }
  }

  const bulkSetCaught = (nextValue: boolean) => {
    if (!ownedEnabled) return
    const next = { ...ownedCounts }
    const updates: {
      product_id: number
      region: 'EN' | 'JP'
      condition_id: number
      rarity_id: number
      printing_id: number
      quantity: number
    }[] = []
    const deletes: {
      product_id: number
      region: 'EN' | 'JP'
      condition_id: number
      rarity_id: number
      printing_id: number
    }[] = []
    visibleCards.forEach((card) => {
      const key = getCardKey(card)
      if (nextValue) {
        const qty = next[key] && next[key] > 0 ? next[key] : 1
        next[key] = qty
        updates.push({
          product_id: card.productId,
          region: card.region,
          condition_id: card.conditionId,
          rarity_id: card.rarityId,
          printing_id: card.printingId,
          quantity: qty,
        })
      } else {
        delete next[key]
        deletes.push({
          product_id: card.productId,
          region: card.region,
          condition_id: card.conditionId,
          rarity_id: card.rarityId,
          printing_id: card.printingId,
        })
      }
    })
    setOwnedCounts(next)
    void persistOwnedUpdates(updates, deletes)
  }

  useEffect(() => {
    if (!session || !ownedEnabled) {
      setOwnedCounts({})
      return
    }
    if (cards.length === 0) return
    const productIds = cards
      .map((card) => card.productId)
      .filter((value): value is number => Number.isFinite(value) && value > 0)
    if (productIds.length === 0) {
      setOwnedCounts({})
      return
    }
    const loadOwned = async () => {
      const next: Record<string, number> = {}
      const chunks = chunk(productIds, 400)
      for (const group of chunks) {
        const { data, error } = await supabase
          .from(ownedTable)
          .select('product_id, region, condition_id, rarity_id, printing_id, quantity')
          .eq('user_id', session.user.id)
          .eq('region', catalogConfig.region)
          .in('product_id', group)
        if (error) {
          console.error('Failed to load owned products', error)
          return
        }
        data?.forEach((row) => {
          const quantity = Number(row.quantity)
          if (row.product_id && quantity > 0) {
            const key = [
              row.region || catalogConfig.region,
              row.product_id,
              Number(row.condition_id) || 0,
              Number(row.rarity_id) || 0,
              Number(row.printing_id) || 0,
            ].join('|')
            next[key] = quantity
          }
        })
      }
      setOwnedCounts(next)
    }
    void loadOwned()
  }, [session, cards, ownedEnabled, ownedTable, catalogConfig.region])

  const totalValue = useMemo(() => {
    return visibleCards.reduce((sum, card) => {
      const price = card.marketPrice ?? card.midPrice ?? card.lowPrice ?? 0
      return sum + (Number.isFinite(price) ? price : 0)
    }, 0)
  }, [visibleCards])

  const ownedMarketValue = useMemo(() => {
    return visibleCards.reduce((sum, card) => {
      const qty = ownedCounts[getCardKey(card)] ?? 0
      if (qty <= 0) return sum
      const price = card.marketPrice ?? card.midPrice ?? card.lowPrice ?? 0
      const safePrice = Number.isFinite(price) ? price : 0
      return sum + safePrice * qty
    }, 0)
  }, [visibleCards, ownedCounts])

  const ownedStats = useMemo(() => {
    const total = visibleCards.length
    if (total === 0) return { owned: 0, total: 0, percent: 0 }
    let owned = 0
    visibleCards.forEach((card) => {
      const qty = ownedCounts[getCardKey(card)] ?? 0
      if (qty > 0) owned += 1
    })
    return {
      owned,
      total,
      percent: (owned / total) * 100,
    }
  }, [visibleCards, ownedCounts])

  const handleSignOut = () => {
    supabase.auth.signOut()
    if (isAdminRoute) {
      go('/')
    }
  }

  const topbar = (
    <header className="topbar">
      <div className="topbar-left">
        <button className="logo" onClick={() => go('/')}>
          <span className="logo-mark">Card Lobby</span>
        </button>
        <div className="topbar-links">
          <button
            className={normalizedPath === '/' ? 'topbar-link active' : 'topbar-link'}
            onClick={() => go('/')}
          >
            Browse cards
          </button>
          <button
            className={
              normalizedPath === '/collectr-importer' ? 'topbar-link active' : 'topbar-link'
            }
            onClick={() => go('/collectr-importer')}
          >
            Collectr Importer
          </button>
          <button
            className={isApiRoute ? 'topbar-link active' : 'topbar-link'}
            onClick={() => go('/api')}
          >
            API
          </button>
          {isAdmin && (
            <button
              className={normalizedPath === '/admin' ? 'topbar-link active' : 'topbar-link'}
              onClick={() => go('/admin')}
            >
              Admin
            </button>
          )}
        </div>
      </div>
      <div className="topbar-right">
        {session ? (
          <>
            <div className="pill muted">
              {session.user.email}
              {isAdmin ? ' · Admin' : ''}
            </div>
            <button className="btn ghost small" onClick={handleSignOut}>
              Sign out
            </button>
          </>
        ) : (
          <>
            <button
              className={
                authMode === 'signin' ? 'btn ghost small active' : 'btn ghost small'
              }
              onClick={() => {
                openAuthModal('signin')
              }}
            >
              Sign in
            </button>
            <button
              className={
                authMode === 'signup' ? 'btn primary small' : 'btn ghost small'
              }
              onClick={() => {
                openAuthModal('signup')
              }}
            >
              Sign up
            </button>
          </>
        )}
      </div>
    </header>
  )

  const authModal =
    authOpen && !session ? (
      <div
        className="modal-backdrop"
        role="dialog"
        aria-modal="true"
        onClick={() => setAuthOpen(false)}
      >
        <div className="modal auth-modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-head">
            <div className="pill">{authMode === 'signin' ? 'Sign in' : 'Sign up'}</div>
            <button className="btn ghost small" onClick={() => setAuthOpen(false)}>
              Close
            </button>
          </div>
          <form
            className="auth-form auth-modal-form"
            onSubmit={async (e) => {
              e.preventDefault()
              setAuthMessage(null)
              if (authMode === 'signin') {
                const { error } = await supabase.auth.signInWithPassword({
                  email,
                  password,
                })
                if (error) setAuthMessage(error.message)
              } else {
                const { data, error } = await supabase.auth.signUp({
                  email,
                  password,
                })
                if (error) setAuthMessage(error.message)
                else if (data.user) {
                  setAuthMessage('Check your email to confirm sign-up (if required).')
                }
              }
            }}
          >
            <span className="swatch-note">
              {authMode === 'signin'
                ? 'Use your existing Card Lobby account'
                : 'Create an account to access collections and admin tools'}
            </span>
            <div className="auth-fields">
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <div className="auth-actions">
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setAuthMode(authMode === 'signin' ? 'signup' : 'signin')
                  setAuthMessage(null)
                }}
              >
                {authMode === 'signin'
                  ? 'Need an account? Sign up'
                  : 'Have an account? Sign in'}
              </button>
              <button className="btn primary" type="submit">
                {authMode === 'signin' ? 'Sign in' : 'Create account'}
              </button>
            </div>
            {authMessage && <div className="auth-message">{authMessage}</div>}
          </form>
        </div>
      </div>
    ) : null

  if (isAdminRoute) {
    return (
      <div className="app-shell">
        {topbar}
        <div className="app-body no-sidebar">
          <main className="main-content">
            <div className="page content-narrow">
              {!session ? (
                <div className="card-surface denial">
                  <div className="pill muted">Access denied</div>
                  <p>You must be signed in as the admin to view this page.</p>
                  <button className="btn primary" onClick={() => go('/')}>
                    Go to sign in
                  </button>
                </div>
              ) : adminCheckLoading ? (
                <div className="card-surface denial">
                  <div className="pill muted">Checking access</div>
                  <p>Verifying admin permissions...</p>
                </div>
              ) : !isAdmin ? (
                <div className="card-surface denial">
                  <div className="pill muted">Access denied</div>
                  <p>You must be signed in as the admin to view this page.</p>
                  <button className="btn primary" onClick={() => go('/')}>
                    Go back
                  </button>
                </div>
              ) : (
                <AdminPortal session={session} />
              )}
            </div>
          </main>
        </div>
        {authModal}
      </div>
    )
  }

  if (isCollectrRoute) {
    return (
      <div className="app-shell">
        {topbar}
        <div className="app-body no-sidebar">
          <main className="main-content">
            <div className="page content-narrow">
              <CollectrImporter
                session={session}
                onSignIn={() => openAuthModal('signin')}
                onSignUp={() => openAuthModal('signup')}
              />
            </div>
          </main>
        </div>
        {authModal}
      </div>
    )
  }

  if (isApiRoute) {
    return (
      <div className="app-shell">
        {topbar}
        <div className="app-body no-sidebar">
          <main className="main-content">
            <div className="page content-narrow">
              <ApiDocsPage
                session={session}
                onSignIn={() => openAuthModal('signin')}
                onSignUp={() => openAuthModal('signup')}
              />
            </div>
          </main>
        </div>
        {authModal}
      </div>
    )
  }

  const currentSet = sets.find((s) => s.id === selectedSetId) || null
  const setTitle =
    currentSet?.name || (selectedSetId === 'csv-set' ? CSV_FALLBACK_SET_TITLE : 'Select a set')

  return (
    <div className="app-shell">
      {topbar}
      <div className="app-body">
        <aside className="sidebar">
          <div className="sidebar-section">
            <div>
              <div className="pill muted">Set navigation</div>
              <p className="sidebar-note">
                Pick a catalog and set to load cards into the grid.
              </p>
            </div>
            <div className="sidebar-block">
              <span className="sidebar-label">Catalog</span>
              <div className="segmented">
                <button
                  className={catalog === 'pokemon' ? 'seg-btn active' : 'seg-btn'}
                  onClick={() => setCatalog('pokemon')}
                >
                  Pokemon
                </button>
                <button
                  className={catalog === 'pokemon_japan' ? 'seg-btn active' : 'seg-btn'}
                  onClick={() => setCatalog('pokemon_japan')}
                >
                  Pokemon Japan
                </button>
              </div>
            </div>
            <div className="sidebar-block">
              <span className="sidebar-label">Set</span>
              <select
                className="select"
                value={selectedSetId}
                onChange={(e) => setSelectedSetId(e.target.value)}
              >
                <option value="all">Choose a set…</option>
                {sets.map((set) => (
                  <option key={set.id} value={set.id}>
                    {set.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </aside>
        <main className="main-content">
          <div className="page">
            <section className="set-hero">
              <div>
                <div className="pill muted">Set preview</div>
                <h2>{setTitle}</h2>
                <p>
                  {selectedSetId === 'all'
                    ? 'Choose a set to load its products.'
                    : cards.length
                      ? `${cards.length} products loaded.`
                      : loading
                        ? 'Loading products…'
                        : 'No products loaded yet.'}
                </p>
                {cards.length ? (
                  <div className="set-metrics">
                    <div className="metric">
                      <span className="metric-label">Owned</span>
                      <span className="metric-value">
                        {ownedStats.owned}/{ownedStats.total}
                      </span>
                      <span className="metric-sub">
                        {ownedStats.total === 0
                          ? '0% complete'
                          : `${ownedStats.percent.toFixed(1)}% complete`}
                      </span>
                    </div>
                    <div className="metric">
                      <span className="metric-label">Total set value</span>
                      <span className="metric-value">
                        {formatPrice(totalValue || 0)}
                      </span>
                    </div>
                    <div className="metric">
                      <span className="metric-label">Total set value owned</span>
                      <span className="metric-value">
                        {formatPrice(ownedMarketValue || 0)}
                      </span>
                    </div>
                  </div>
                ) : null}
              </div>
            </section>

            <section className="cards-section">
              <div className="cards-header">
                <div>
                  <div className="pill">Ascending order</div>
                  <h3>Browse the set</h3>
                </div>
                <div className="cards-toolbar">
                  <div className="segmented">
                    <button
                      className={viewMode === 'singles' ? 'seg-btn active' : 'seg-btn'}
                      onClick={() => setViewModeWithScroll('singles')}
                    >
                      Singles
                    </button>
                    <button
                      className={viewMode === 'sealed' ? 'seg-btn active' : 'seg-btn'}
                      onClick={() => setViewModeWithScroll('sealed')}
                    >
                      Sealed / kits
                    </button>
                  </div>
                  <div className="bulk-actions">
                    <button
                      className="btn ghost small"
                      type="button"
                      onClick={() => setConfirmAction('catch')}
                      disabled={!ownedEnabled || visibleCards.length === 0}
                    >
                      Catch all
                    </button>
                    <button
                      className="btn ghost small"
                      type="button"
                      onClick={() => setConfirmAction('release')}
                      disabled={!ownedEnabled || visibleCards.length === 0}
                    >
                      Release all
                    </button>
                  </div>
                </div>
              </div>

              {viewMode === 'singles' && availableSubtypes.length > 0 && (
                <div className="chip-row">
                  {availableSubtypes.map((subtype) => {
                    const active = subtypeFilters.has(subtype)
                    return (
                      <button
                        key={subtype}
                        className={active ? 'chip active' : 'chip'}
                        onClick={() => {
                          const next = new Set(subtypeFilters)
                          if (active) {
                            next.delete(subtype)
                          } else {
                            next.add(subtype)
                          }
                          if (next.size === 0) {
                            availableSubtypes.forEach((value) => next.add(value))
                          }
                          setSubtypeFilters(next)
                        }}
                      >
                        {subtype}
                      </button>
                    )
                  })}
                </div>
              )}

              <div className="cards-grid">
                {loading && <div className="card-tile loading">Loading set…</div>}
                {!loading && visibleCards.length === 0 && (
                  <div className="card-tile loading">No items found.</div>
                )}
                {visibleCards.map((card) => {
                  const cardKey = getCardKey(card)
                  const ownedCount = ownedCounts[cardKey] ?? 0
                  const isCaught = ownedCount > 0
                  return (
                  <article
                    className="card-tile"
                    key={cardKey}
                  >
                    <div className="card-media">
                      <button
                        type="button"
                        className={`pokeball-toggle${isCaught ? ' caught' : ''}`}
                        aria-pressed={isCaught}
                        aria-label={isCaught ? 'Mark as not caught' : 'Mark as caught'}
                        disabled={!ownedEnabled}
                        onClick={() => {
                          if (!ownedEnabled) return
                          const next = { ...ownedCounts }
                          const ownedRow = {
                            product_id: card.productId,
                            region: card.region,
                            condition_id: card.conditionId,
                            rarity_id: card.rarityId,
                            printing_id: card.printingId,
                          }
                          if (isCaught) {
                            delete next[cardKey]
                            void persistOwnedUpdates([], [ownedRow])
                          } else {
                            next[cardKey] = 1
                            void persistOwnedUpdates(
                              [{ ...ownedRow, quantity: 1 }],
                              [],
                            )
                          }
                          setOwnedCounts(next)
                        }}
                      >
                        <span className="pokeball" />
                      </button>
                      {isCaught && (
                        <label className="owned-qty">
                          <span>Qty</span>
                          <input
                            type="number"
                            min="1"
                            step="1"
                            value={ownedCount}
                            aria-label="Owned quantity"
                            disabled={!ownedEnabled}
                            onChange={(e) => {
                              if (!ownedEnabled) return
                              const nextValue = Number.parseInt(e.target.value, 10)
                              const next = { ...ownedCounts }
                              const ownedRow = {
                                product_id: card.productId,
                                region: card.region,
                                condition_id: card.conditionId,
                                rarity_id: card.rarityId,
                                printing_id: card.printingId,
                              }
                              if (!Number.isFinite(nextValue) || nextValue <= 0) {
                                delete next[cardKey]
                                void persistOwnedUpdates([], [ownedRow])
                              } else {
                                next[cardKey] = nextValue
                                void persistOwnedUpdates(
                                  [{ ...ownedRow, quantity: nextValue }],
                                  [],
                                )
                              }
                              setOwnedCounts(next)
                            }}
                          />
                        </label>
                      )}
                      {card.imageUrl ? (
                        <img src={card.imageUrl} alt={card.name} loading="lazy" />
                      ) : (
                        <div className="img-placeholder">No image</div>
                      )}
                      <div className="card-badge">#{card.extNumber ?? '—'}</div>
                    </div>
                    <div className="card-body">
                      <div className="card-title">{card.name}</div>
                      <div className="card-meta">
                        <span>{card.extRarity || '—'}</span>
                        <span>•</span>
                        <span>{card.extCardType || '—'}</span>
                      </div>
                      <div className="price-row">
                        <span className="price-label">Market</span>
                        <span className="price-value primary">
                          {formatPrice(card.marketPrice)}
                        </span>
                      </div>
                      <div className="price-row subtle">
                        <span className="price-label">Mid</span>
                        <span className="price-value">{formatPrice(card.midPrice)}</span>
                      </div>
                      <div className="price-row subtle">
                        <span className="price-label">Low</span>
                        <span className="price-value">{formatPrice(card.lowPrice)}</span>
                      </div>
                    </div>
                  </article>
                  )
                })}
              </div>
            </section>

            <section className="palette">
              <div className="palette-header">
                <span className="pill muted">Muk palette</span>
                <span className="swatch-note">Use these in future components</span>
              </div>
              <div className="swatches">
                <div className="swatch sludge">
                  <div className="tone">#6b2a7c</div>
                  <div className="label">Sludge base</div>
                </div>
                <div className="swatch ooze">
                  <div className="tone">#b8f000</div>
                  <div className="label">Toxic pop</div>
                </div>
                <div className="swatch ink">
                  <div className="tone">#1c0b26</div>
                  <div className="label">Shadow</div>
                </div>
                <div className="swatch mist">
                  <div className="tone">#f3ecff</div>
                  <div className="label">Highlight</div>
                </div>
              </div>
            </section>
          </div>
        </main>
      </div>
      {confirmAction && ownedEnabled && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="pill muted">Confirm</div>
            <h3>
              {confirmAction === 'catch'
                ? 'Catch every visible card?'
                : 'Release every visible card?'}
            </h3>
            <p className="swatch-note">
              {confirmAction === 'catch'
                ? 'This will mark every visible card as caught and set quantity to 1.'
                : 'This will clear the quantity for every visible card.'}
            </p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setConfirmAction(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  bulkSetCaught(confirmAction === 'catch')
                  setConfirmAction(null)
                }}
              >
                {confirmAction === 'catch' ? 'Catch all' : 'Release all'}
              </button>
            </div>
          </div>
        </div>
      )}
      {authModal}
    </div>
  )
}

export default App
