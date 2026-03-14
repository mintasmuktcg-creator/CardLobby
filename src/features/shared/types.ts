import type { Session } from '@supabase/supabase-js'

export type SupabaseSession = Session | null

export type UploadStatus =
  | { state: 'idle' }
  | { state: 'parsing' }
  | { state: 'uploading'; progress: string }
  | { state: 'done'; message: string }
  | { state: 'error'; message: string }

export type CollectrImportSummary = {
  totalCollectr: number
  parsedProducts: number
  matchedProducts: number
  skippedGraded: number
}

export type CollectrCollection = {
  id: string
  name: string
  [key: string]: unknown
}

export type CollectrImportResultStatus = 'matched' | 'unmatched' | 'skipped-graded'

export type CollectrImportResult = {
  tcg_product_id: number | null
  quantity: number
  collectr_collection_id?: string | null
  collectr_collection_name?: string | null
  collectr_set: string | null
  collectr_name?: string | null
  collectr_condition?: string | null
  collectr_image_url?: string | null
  matched: boolean
  status?: CollectrImportResultStatus
  skip_reason?: 'graded' | null
  grade_company?: string | null
  grade_id?: string | number | null
  name: string | null
  set: string | null
  code: string | null
  product_type: string | null
  card_number: string | null
  condition?: string | null
  rarity: string | null
  image_url?: string | null
  market_price?: number | string | null
  japanese_checks?: {
    set_match: boolean
    card_number_match: boolean
    name_match: boolean | null
  } | null
}

export type ApiKeyRequestStatus = 'pending' | 'approved' | 'denied'

export type ApiKeyRequestRecord = {
  request_id: string
  user_id: string | null
  email: string | null
  reason: string
  status: ApiKeyRequestStatus
  source_ip: string | null
  user_agent: string | null
  created_at: string
  reviewed_at: string | null
  reviewed_by: string | null
  admin_notes: string | null
  api_key_id: string | null
  api_key_preview: string | null
}
