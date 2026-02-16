export type CollectrImportSummary = {
  totalCollectr: number
  parsedProducts: number
  matchedProducts: number
  skippedGraded: number
  skippedNonEnglish: number
}

export function runCollectrImport(args: {
  url: string
  includeNonEnglish?: boolean
  supabaseUrl: string
  supabaseKey: string
}): Promise<{ summary: CollectrImportSummary; results: unknown[] }>
