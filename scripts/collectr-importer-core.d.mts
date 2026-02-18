export type CollectrImportSummary = {
  totalCollectr: number
  parsedProducts: number
  matchedProducts: number
  skippedGraded: number
}

export function runCollectrImport(args: {
  url: string
  supabaseUrl: string
  supabaseKey: string
}): Promise<{ summary: CollectrImportSummary; results: unknown[] }>
