-- Per-workspace overrides, plan changes, and switching how a subscription is paid.

-- Features and limits that differ from the plan for one workspace (e.g. a negotiated deal). Same
-- shape as plans.entitlements, but every value here replaces the plan's, false and 0 included.
ALTER TABLE tenants ADD COLUMN overrides jsonb NOT NULL DEFAULT '{"features": {}, "limits": {}}';
ALTER TABLE tenants ADD COLUMN overrides_note text NOT NULL DEFAULT ''; -- why, e.g. "Annual deal, approved by Rahul"

-- A change to another plan or price that starts when the current period ends (a downgrade, or
-- monthly → yearly). Applied by the billing job at pending_change_at.
ALTER TABLE subscriptions ADD COLUMN pending_plan_id int REFERENCES plans (id);
ALTER TABLE subscriptions ADD COLUMN pending_price_id int REFERENCES plan_prices (id);
ALTER TABLE subscriptions ADD COLUMN pending_change_at timestamptz;

-- What an invoice bills: a 'period' (first or renewal) or an 'upgrade' (the prorated difference for
-- switching to a dearer plan now), and for which plan and price.
ALTER TABLE invoices ADD COLUMN kind text NOT NULL DEFAULT 'period' CHECK (kind IN ('period', 'upgrade'));
ALTER TABLE invoices ADD COLUMN plan_id int REFERENCES plans (id);
ALTER TABLE invoices ADD COLUMN price_id int REFERENCES plan_prices (id);
UPDATE invoices i SET plan_id = s.plan_id, price_id = s.price_id FROM subscriptions s WHERE s.id = i.subscription_id;
ALTER TABLE invoices ALTER COLUMN plan_id SET NOT NULL, ALTER COLUMN price_id SET NOT NULL;

-- Still one invoice per period, but an upgrade can be billed inside a period that's already paid.
ALTER TABLE invoices DROP CONSTRAINT invoices_subscription_id_period_start_key;
CREATE UNIQUE INDEX invoices_one_per_period ON invoices (subscription_id, period_start) WHERE kind = 'period';
