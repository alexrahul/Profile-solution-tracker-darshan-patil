-- Profile Solutions Dashboard v2.7.0
-- Accounts module: monthly financial summary (Sales Orders, Purchase Orders, Invoices).
-- Run this in the Supabase SQL Editor after upgrading from v2.6.
-- Safe to re-run.

BEGIN;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS accounts_data(
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  t_month VARCHAR(7) NOT NULL UNIQUE CHECK (t_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  sales_order_amount NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (sales_order_amount >= 0),
  purchase_order_amount NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (purchase_order_amount >= 0),
  invoice_amount NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (invoice_amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accounts_month ON accounts_data(t_month);

DROP TRIGGER IF EXISTS trg_accounts_updated_at ON accounts_data;
CREATE TRIGGER trg_accounts_updated_at
BEFORE UPDATE ON accounts_data
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
