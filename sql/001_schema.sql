-- =====================================================================
-- Domus Global — Sistema de Conciliación de Gastos
-- Migración 001: esquema base
-- =====================================================================
-- Tablas: companies, employees, categories, invoices, bank_transactions
-- Convención: montos en numeric(14,2); moneda ISO (UYU/USD); fechas date;
-- timestamps en timestamptz.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- companies — empresas del holding (~13)
-- dominio_email es la clave para identificar al emisor en el canal email
-- ---------------------------------------------------------------------
create table if not exists companies (
  id            uuid primary key default gen_random_uuid(),
  nombre        text not null,
  rut           text unique,
  dominio_email text unique,                    -- ej: 'empresax.com.uy' (sin @)
  activo        boolean not null default true,
  created_at    timestamptz not null default now()
);

comment on column companies.dominio_email is 'Dominio del remitente sin @, en minúsculas. Identifica la empresa en el canal email.';

-- ---------------------------------------------------------------------
-- employees — whitelist de WhatsApp
-- phone normalizado a solo dígitos con código de país (ej: 59899123456)
-- ---------------------------------------------------------------------
create table if not exists employees (
  id         uuid primary key default gen_random_uuid(),
  phone      text not null unique,              -- solo dígitos, E.164 sin '+' (ej: 59899123456)
  nombre     text,
  company_id uuid not null references companies(id) on delete restrict,
  activo     boolean not null default true,
  created_at timestamptz not null default now()
);

comment on column employees.phone is 'Solo dígitos con código país, sin + ni sufijo @s.whatsapp.net. Normalizar el remoteJid de Evolution antes de comparar.';

-- ---------------------------------------------------------------------
-- categories — ~5 categorías fijas de gasto (definidas por el cliente)
-- ---------------------------------------------------------------------
create table if not exists categories (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null unique,
  descripcion text,
  orden       int,
  activo      boolean not null default true
);

-- ---------------------------------------------------------------------
-- invoices — cada factura/ticket capturado (email o whatsapp)
-- ---------------------------------------------------------------------
create table if not exists invoices (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid references companies(id) on delete restrict,  -- empresa del holding que gastó
  empresa_emisora     text,                       -- proveedor (Shell, Tienda X)
  rut_emisor          text,
  monto               numeric(14,2),
  moneda              text not null default 'UYU',
  fecha               date,
  nro_factura         text,
  tipo_comprobante    text,                       -- e-Ticket, e-Factura, e-Remito, ticket físico, etc.
  categoria_id        uuid references categories(id),
  fuente              text not null check (fuente in ('email','whatsapp')),
  reporter            text,                       -- email del remitente o teléfono que reportó
  archivo_url         text,                       -- path del original en Storage (PDF/imagen)
  archivo_xml_url     text,                       -- path del XML e-CFE en Storage (si aplica)
  estado_conciliacion text not null default 'pendiente'
                        check (estado_conciliacion in ('pendiente','conciliada','sin_match','revision')),
  bank_transaction_id uuid,                       -- FK agregada abajo (referencia circular)
  datos_extra         jsonb,                      -- detalle de ítems / raw de extracción IA
  hash_dedupe         text unique,                -- evita duplicados (ej: rut_emisor+nro_factura+monto)
  created_at          timestamptz not null default now()
);

comment on column invoices.company_id is 'Empresa del holding que hizo el gasto. NO es el emisor de la factura.';
comment on column invoices.empresa_emisora is 'Proveedor que emite la factura (ej: Shell). Distinto de company_id.';
comment on column invoices.hash_dedupe is 'Clave de deduplicación. Sugerido: lower(rut_emisor)||nro_factura||monto. Permite idempotencia en la ingesta.';

-- ---------------------------------------------------------------------
-- bank_transactions — movimientos del extracto bancario mensual
-- ---------------------------------------------------------------------
create table if not exists bank_transactions (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid references companies(id) on delete restrict,
  fecha            date,
  monto            numeric(14,2),
  moneda           text not null default 'UYU',
  descripcion      text,
  invoice_id       uuid references invoices(id),  -- factura conciliada (1:1 simple)
  estado           text not null default 'sin_match'
                     check (estado in ('sin_match','conciliada','parcial')),
  extracto_periodo text,                          -- 'YYYY-MM' del extracto al que pertenece
  raw              jsonb,
  created_at       timestamptz not null default now()
);

-- FK circular invoices -> bank_transactions (se agrega después de crear ambas)
alter table invoices
  drop constraint if exists invoices_bank_transaction_fk;
alter table invoices
  add constraint invoices_bank_transaction_fk
  foreign key (bank_transaction_id) references bank_transactions(id) on delete set null;

-- ---------------------------------------------------------------------
-- Índices
-- ---------------------------------------------------------------------
create index if not exists idx_companies_dominio        on companies (lower(dominio_email));
create index if not exists idx_employees_phone          on employees (phone);
create index if not exists idx_employees_company        on employees (company_id);
create index if not exists idx_invoices_company         on invoices (company_id);
create index if not exists idx_invoices_fecha           on invoices (fecha);
create index if not exists idx_invoices_estado          on invoices (estado_conciliacion);
create index if not exists idx_invoices_categoria       on invoices (categoria_id);
create index if not exists idx_bank_tx_company          on bank_transactions (company_id);
create index if not exists idx_bank_tx_fecha            on bank_transactions (fecha);
create index if not exists idx_bank_tx_periodo          on bank_transactions (extracto_periodo);
-- Para el matching de conciliación (empresa + fecha + monto)
create index if not exists idx_invoices_match           on invoices (company_id, fecha, monto);
create index if not exists idx_bank_tx_match            on bank_transactions (company_id, fecha, monto);

-- ---------------------------------------------------------------------
-- Seed: categorías (borrador — se ajustan con el cliente)
-- ---------------------------------------------------------------------
insert into categories (nombre, descripcion, orden) values
  ('Combustible',                'Nafta, gasoil, peajes (Shell, Ancap, etc.)',        1),
  ('Alimentación / Restaurantes','Comidas, cafés, restaurantes, delivery',            2),
  ('Insumos de oficina',         'Supermercado, materiales y artículos para oficina', 3),
  ('Servicios y suscripciones',  'Software, SaaS, servicios profesionales',           4),
  ('Viajes y transporte',        'Taxis, pasajes, hospedaje, movilidad',              5)
on conflict (nombre) do nothing;

-- ---------------------------------------------------------------------
-- Row Level Security
-- Deny-by-default: se habilita RLS SIN políticas. El backend (n8n) se
-- conecta con la service_role key, que bypassa RLS. La anon key NO puede
-- acceder a estas tablas. Si en el futuro se expone un cliente público,
-- agregar políticas explícitas por tabla.
-- ---------------------------------------------------------------------
alter table companies         enable row level security;
alter table employees         enable row level security;
alter table categories        enable row level security;
alter table invoices          enable row level security;
alter table bank_transactions enable row level security;
