-- Accounts, workspaces (tenants) and our own subscription records.

-- The plan a workspace is on when it has no paid subscription.
ALTER TABLE products ADD COLUMN default_plan_key text NOT NULL DEFAULT 'free';

CREATE TABLE users (
  id            int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         text NOT NULL,
  password_hash text NOT NULL,
  name          text NOT NULL,
  phone         text, -- for payment reminders
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email ON users (lower(email));

-- A customer of the SaaS: a company or team. Plans and subscriptions belong to the tenant,
-- and every member of it gets the tenant's features.
CREATE TABLE tenants (
  id         int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id int NOT NULL REFERENCES products (id),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  tenant_id  int NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id    int NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX memberships_user ON memberships (user_id);

-- Only a hash of the cookie's token is stored, so a leaked table can't be used to log in.
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    int NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Our record of what a tenant pays for: the source of truth for access, whichever way the
-- money is collected.
--   auto:   Razorpay Subscription (mandate); Razorpay charges each cycle and webhooks keep this in sync
--   manual: the customer pays each cycle themselves (no mandate)
-- Status:  incomplete (checkout not finished) → active → past_due (payment late, still has access)
--          → halted (auto: all retries failed) / cancelled / expired
CREATE TABLE subscriptions (
  id                       int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id                int NOT NULL REFERENCES tenants (id),
  plan_id                  int NOT NULL REFERENCES plans (id),      -- the version bought; kept through renewals
  price_id                 int NOT NULL REFERENCES plan_prices (id),
  collection_method        text NOT NULL CHECK (collection_method IN ('auto', 'manual')),
  status                   text NOT NULL DEFAULT 'incomplete'
                           CHECK (status IN ('incomplete', 'active', 'past_due', 'halted', 'cancelled', 'expired')),
  razorpay_subscription_id text UNIQUE,
  current_period_start     timestamptz,
  current_period_end       timestamptz,
  cancel_at_period_end     boolean NOT NULL DEFAULT false,
  ended_at                 timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_tenant ON subscriptions (tenant_id, created_at DESC);
-- A tenant has at most one subscription giving access at a time.
CREATE UNIQUE INDEX subscriptions_one_live ON subscriptions (tenant_id) WHERE status IN ('active', 'past_due');
