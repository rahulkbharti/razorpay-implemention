-- Manual renewal (pay each cycle without a mandate) and free trials.

-- Days of free trial a new subscriber gets (0 = none). Not an entitlement, so it can change on
-- a published version; it only affects people who subscribe afterwards.
ALTER TABLE plans ADD COLUMN trial_days int NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 365);
UPDATE plans SET trial_days = 14 WHERE key IN ('basic', 'pro') AND status = 'active';

-- 'trialing': free trial, with access. current_period_end is when the trial ends.
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_status_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('incomplete', 'trialing', 'active', 'past_due', 'halted', 'cancelled', 'expired'));
ALTER TABLE subscriptions ADD COLUMN trial_end timestamptz; -- set once a trial was given; one per workspace
DROP INDEX subscriptions_one_live;
CREATE UNIQUE INDEX subscriptions_one_live ON subscriptions (tenant_id) WHERE status IN ('trialing', 'active', 'past_due');

CREATE FUNCTION billing_interval(period text) RETURNS interval
  LANGUAGE sql IMMUTABLE
  AS $$ SELECT CASE period WHEN 'monthly' THEN interval '1 month' WHEN 'yearly' THEN interval '1 year' END $$;

-- What a manual subscription owes for one billing period. The first one is paid in Checkout
-- (a Razorpay order); renewals get a Razorpay payment link that the reminders point to.
-- Autopay invoices live in Razorpay instead.
CREATE TABLE invoices (
  id                       int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subscription_id          int NOT NULL REFERENCES subscriptions (id),
  tenant_id                int NOT NULL REFERENCES tenants (id),
  amount                   int NOT NULL,
  currency                 text NOT NULL DEFAULT 'INR',
  period_start             timestamptz NOT NULL, -- final once paid (a late payment starts the period that day)
  period_end               timestamptz NOT NULL,
  due_at                   timestamptz NOT NULL,
  status                   text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'void')),
  razorpay_order_id        text UNIQUE,
  razorpay_payment_link_id text UNIQUE,
  payment_link_url         text,
  razorpay_payment_id      text UNIQUE,
  paid_at                  timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, period_start) -- one invoice per period, however often the job runs
);
CREATE INDEX invoices_open ON invoices (due_at) WHERE status = 'open';

-- Which reminders went out, so each is sent once.
CREATE TABLE invoice_reminders (
  invoice_id int NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  kind       text NOT NULL, -- 'due_in_7', 'due_in_3', 'due_in_1', 'due_today'
  sent_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invoice_id, kind)
);
