-- A voided invoice mustn't block reissuing that period's invoice (e.g. after a plan change during
-- the period before it, the old-price renewal is voided and opened again at the new price).
DROP INDEX invoices_one_per_period;
CREATE UNIQUE INDEX invoices_one_per_period ON invoices (subscription_id, period_start)
  WHERE kind = 'period' AND status <> 'void';
