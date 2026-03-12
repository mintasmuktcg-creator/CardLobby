alter table public.api_key_requests
  add column if not exists api_key_preview text;

update public.api_key_requests
set api_key_preview = case
  when api_key_preview is not null then api_key_preview
  when issued_api_key is null then null
  when length(issued_api_key) <= 12 then issued_api_key
  else left(issued_api_key, 8) || '...' || right(issued_api_key, 4)
end
where true;

alter table public.api_key_requests
  drop column if exists issued_api_key;

select pg_notify('pgrst', 'reload schema');
