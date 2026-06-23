-- =====================================================================
-- Migración 002: memoria de conversación del bot de WhatsApp
-- =====================================================================
create table if not exists wa_sessions (
  phone            text primary key,                 -- solo dígitos (igual que employees.phone)
  company_id       uuid references companies(id) on delete set null,
  history          jsonb not null default '[]'::jsonb,  -- mensajes Anthropic (role/content)
  draft_invoice_id uuid references invoices(id) on delete set null,  -- factura en curso
  updated_at       timestamptz not null default now()
);

comment on table wa_sessions is 'Memoria de conversación del bot de WhatsApp por teléfono. history = mensajes Anthropic; draft_invoice_id = factura en curso (estado=revision).';

alter table wa_sessions enable row level security;
