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

export function runCollectrImport(args: {
  url: string
  cardhqBaseUrl?: string
  cardhqApiKey?: string
}): Promise<{
  summary: CollectrImportSummary
  results: unknown[]
  collections?: CollectrCollection[]
}>
