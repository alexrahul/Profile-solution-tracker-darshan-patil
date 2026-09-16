-- Profile Solutions Dashboard v2.9.0
-- Replaces the Accounts module's data model. The v2.7 version tracked monthly
-- Sales Order / Purchase Order / Invoice totals (accounts_data). This version
-- tracks invoice-level Receivables and Payables with an aging/DSO dashboard
-- instead. accounts_data and calendar_data are untouched by this migration -
-- accounts_data is simply no longer used by the app; drop it yourself if you
-- don't want to keep that data.
-- Run this AFTER the v2.8 migration. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS receivables_data(
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_name VARCHAR(255) NOT NULL,
  invoice_date DATE NOT NULL,
  due_date DATE NOT NULL,
  invoice_amount NUMERIC(20,2) NOT NULL CHECK (invoice_amount >= 0),
  balance NUMERIC(20,2) CHECK (balance IS NULL OR balance >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payables_data(
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_name VARCHAR(255) NOT NULL,
  invoice_date DATE NOT NULL,
  due_date DATE NOT NULL,
  invoice_amount NUMERIC(20,2) NOT NULL CHECK (invoice_amount >= 0),
  balance NUMERIC(20,2) CHECK (balance IS NULL OR balance >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_receivables_date ON receivables_data(invoice_date);
CREATE INDEX IF NOT EXISTS idx_receivables_customer ON receivables_data(customer_name);
CREATE INDEX IF NOT EXISTS idx_payables_date ON payables_data(invoice_date);
CREATE INDEX IF NOT EXISTS idx_payables_vendor ON payables_data(vendor_name);

DROP TRIGGER IF EXISTS trg_receivables_updated_at ON receivables_data;
CREATE TRIGGER trg_receivables_updated_at
BEFORE UPDATE ON receivables_data
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_payables_updated_at ON payables_data;
CREATE TRIGGER trg_payables_updated_at
BEFORE UPDATE ON payables_data
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
