-- Plans & entitlements catalog.
-- Everything carries product_id so this control panel can later serve several SaaS
-- products. For now there is a single 'default' product.

CREATE TABLE products (
  id         int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key        text NOT NULL UNIQUE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO products (key, name) VALUES ('default', 'My SaaS');

-- Every feature a plan can grant. Plans may only use keys defined here, so a typo in a
-- plan is rejected instead of silently granting nothing.
--   boolean: on / off          "custom_domain": true
--   limit:   a whole number    "projects": 10   (-1 = unlimited)
CREATE TABLE features (
  id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id  int NOT NULL REFERENCES products (id),
  key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  type        text NOT NULL CHECK (type IN ('boolean', 'limit')),
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, key)
);

-- Plans are versioned. A draft can be edited freely; publishing makes it 'active' (what new
-- customers buy) and locks its entitlements. To change them you publish a new version, and
-- the old one becomes 'archived' but keeps applying to the customers already on it.
CREATE TABLE plans (
  id           int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id   int NOT NULL REFERENCES products (id),
  key          text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  version      int NOT NULL CHECK (version > 0),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  -- {"features": {"custom_domain": true}, "limits": {"projects": 10}}
  -- Only what the plan grants is stored: a missing key means off / 0.
  entitlements jsonb NOT NULL DEFAULT '{"features": {}, "limits": {}}',
  is_public    boolean NOT NULL DEFAULT true, -- false: kept off the pricing page (custom deals)
  sort_order   int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (product_id, key, version)
);
CREATE UNIQUE INDEX plans_one_active ON plans (product_id, key) WHERE status = 'active';
CREATE UNIQUE INDEX plans_one_draft ON plans (product_id, key) WHERE status = 'draft';

-- What a plan version costs. Each row becomes one Razorpay plan, created on the first
-- subscribe. Razorpay plans can't be edited, so a price row is never changed either:
-- replacing it retires the old row, and customers already on it keep paying that amount.
-- A plan with no prices is free.
CREATE TABLE plan_prices (
  id               int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id          int NOT NULL REFERENCES plans (id) ON DELETE CASCADE,
  period           text NOT NULL CHECK (period IN ('monthly', 'yearly')),
  amount           int NOT NULL CHECK (amount >= 100), -- paise; Razorpay's minimum is 1 rupee
  currency         text NOT NULL DEFAULT 'INR',
  is_active        boolean NOT NULL DEFAULT true,
  razorpay_plan_id text UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX plan_prices_one_active ON plan_prices (plan_id, period) WHERE is_active;
