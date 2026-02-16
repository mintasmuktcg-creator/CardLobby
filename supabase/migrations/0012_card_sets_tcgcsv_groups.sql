-- Add TCGCSV group metadata fields to card_sets.

alter table public.card_sets
  add column if not exists abbreviation text,
  add column if not exists is_supplemental boolean,
  add column if not exists published_on timestamptz,
  add column if not exists modified_on timestamptz;
