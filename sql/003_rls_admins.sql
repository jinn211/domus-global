-- Politicas de lectura para la interfaz web. Ver README de bot-whatsapp.
-- Hasta esta migracion el RLS estaba prendido sin ninguna politica: la key
-- publica devolvia [] para todo. Servia de candado, pero impedia cualquier UI.
-- El bot no se ve afectado: usa la secret key, que saltea RLS por diseno.

create table if not exists public.admins (
  email      text primary key,
  nombre     text,
  created_at timestamptz not null default now()
);

alter table public.admins enable row level security;

-- Cada uno ve su propia fila y nada mas: la interfaz sabe quien es sin exponer
-- la lista completa de administradores.
create policy "cada admin ve su fila" on public.admins
  for select to authenticated
  using (lower(email) = lower(auth.jwt() ->> 'email'));

-- SECURITY DEFINER a proposito: tiene que consultar `admins` sin quedar atrapada
-- por el RLS de esa misma tabla. search_path fijo para que nadie interponga un
-- esquema propio.
create or replace function public.es_admin() returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.admins where lower(email) = lower(auth.jwt() ->> 'email')
  );
$$;

-- Solo SELECT. Escribir sigue siendo exclusivo del bot: una interfaz de consulta
-- no tiene por que poder modificar la contabilidad.
do $$
declare t text;
begin
  foreach t in array array['invoices','companies','employees','categories','bank_transactions']
  loop
    execute format('drop policy if exists "admins leen" on public.%I', t);
    execute format(
      'create policy "admins leen" on public.%I for select to authenticated using (public.es_admin())', t);
  end loop;
end $$;

-- Sin esto la interfaz lista las facturas pero no abre ni un archivo: crear una
-- URL firmada exige permiso de lectura sobre el objeto.
create policy "admins leen comprobantes" on storage.objects
  for select to authenticated
  using (bucket_id = 'facturas' and public.es_admin());
