-- 009_bank_beneficiaries_and_settlements.sql
-- Single-Merchant Aggregator Settlement & Bank Beneficiary Financial Ledger
-- Primary Merchant: Olive Pizza Pvt. Ltd. (Master Razorpay Gateway & Direct POS Merchant)
-- Payouts to Franchisees & Delivery Partners are recorded here for reconciliation and statutory audits.

CREATE TABLE IF NOT EXISTS bank_beneficiaries (
  id VARCHAR(100) PRIMARY KEY, -- e.g. ben_fra_rajnandgaon_primary
  entity_type VARCHAR(50) NOT NULL, -- 'FRANCHISE' | 'DELIVERY_PARTNER' | 'OPERATOR'
  entity_id VARCHAR(100) NOT NULL, -- franchiseId or rider UID
  beneficiary_name VARCHAR(255) NOT NULL,
  account_number_encrypted TEXT NOT NULL, -- Encrypted / Vaulted
  account_number_masked VARCHAR(50) NOT NULL, -- e.g. '••••••••1234'
  ifsc_code VARCHAR(20) NOT NULL,
  bank_name VARCHAR(150),
  branch_name VARCHAR(150),
  account_type VARCHAR(50) DEFAULT 'CURRENT', -- 'CURRENT' | 'SAVINGS'
  upi_vpa VARCHAR(255),
  verification_status VARCHAR(50) DEFAULT 'PENDING_VERIFICATION', -- 'PENDING_VERIFICATION' | 'VERIFIED' | 'REJECTED'
  rejection_reason TEXT,
  verified_at TIMESTAMP WITH TIME ZONE,
  verified_by VARCHAR(255),
  is_active BOOLEAN DEFAULT true,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bank_beneficiaries_entity ON bank_beneficiaries(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_bank_beneficiaries_status ON bank_beneficiaries(verification_status);

CREATE TABLE IF NOT EXISTS payout_settlement_records (
  id VARCHAR(100) PRIMARY KEY, -- e.g. set_202610_fra_rajnandgaon
  settlement_reference VARCHAR(100) UNIQUE NOT NULL,
  beneficiary_id VARCHAR(100) REFERENCES bank_beneficiaries(id),
  entity_type VARCHAR(50) NOT NULL,
  entity_id VARCHAR(100) NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  gross_sales_paise BIGINT NOT NULL DEFAULT 0,
  platform_fee_paise BIGINT NOT NULL DEFAULT 0,
  tax_collected_paise BIGINT NOT NULL DEFAULT 0,
  net_payout_paise BIGINT NOT NULL DEFAULT 0,
  currency VARCHAR(10) DEFAULT 'INR',
  status VARCHAR(50) DEFAULT 'SCHEDULED', -- 'SCHEDULED' | 'PROCESSING' | 'SETTLED' | 'FAILED' | 'ON_HOLD'
  transaction_utr VARCHAR(100),
  failure_reason TEXT,
  settled_at TIMESTAMP WITH TIME ZONE,
  created_by VARCHAR(255),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_settlement_records_entity ON payout_settlement_records(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_settlement_records_status ON payout_settlement_records(status);
CREATE INDEX IF NOT EXISTS idx_settlement_records_period ON payout_settlement_records(period_start, period_end);

-- Audit log for bank detail changes and verification transitions
CREATE TABLE IF NOT EXISTS bank_audit_log (
  id BIGSERIAL PRIMARY KEY,
  beneficiary_id VARCHAR(100) NOT NULL,
  action VARCHAR(100) NOT NULL, -- 'REGISTERED' | 'VERIFIED' | 'REJECTED' | 'UPDATED' | 'DEACTIVATED'
  performed_by VARCHAR(255) NOT NULL,
  ip_address VARCHAR(100),
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bank_audit_log_beneficiary ON bank_audit_log(beneficiary_id);
