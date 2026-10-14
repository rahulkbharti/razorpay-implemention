-- Starter catalog, using the Basic / Pro prices the demo had before plans moved into the
-- database. Change or replace all of it from the Admin tab.

INSERT INTO features (product_id, key, type, name, description, sort_order)
SELECT p.id, f.key, f.type, f.name, f.description, f.sort_order
FROM products p
CROSS JOIN (VALUES
  ('projects',          'limit',   'Projects',          'Projects a workspace can create', 1),
  ('team_members',      'limit',   'Team members',      'Users who can join a workspace', 2),
  ('api_calls_monthly', 'limit',   'API calls / month', 'Requests to the public API per billing month', 3),
  ('export_pdf',        'boolean', 'PDF export',        'Download reports as PDF', 4),
  ('custom_domain',     'boolean', 'Custom domain',     'Serve the workspace from your own domain', 5),
  ('sso',               'boolean', 'Single sign-on',    'Log in with Google Workspace or Okta', 6),
  ('priority_support',  'boolean', 'Priority support',  'Replies within 4 business hours', 7)
) AS f (key, type, name, description, sort_order)
WHERE p.key = 'default';

INSERT INTO plans (product_id, key, version, status, name, description, entitlements, sort_order, published_at)
SELECT p.id, v.key, 1, 'active', v.name, v.description, v.entitlements::jsonb, v.sort_order, now()
FROM products p
CROSS JOIN (VALUES
  ('free', 'Free', 'For trying things out',
   '{"features": {}, "limits": {"projects": 1, "team_members": 1, "api_calls_monthly": 1000}}', 1),
  ('basic', 'Basic', 'For small teams',
   '{"features": {"export_pdf": true}, "limits": {"projects": 10, "team_members": 5, "api_calls_monthly": 50000}}', 2),
  ('pro', 'Pro', 'For growing businesses',
   '{"features": {"export_pdf": true, "custom_domain": true, "sso": true, "priority_support": true},
     "limits": {"projects": -1, "team_members": 25, "api_calls_monthly": 500000}}', 3)
) AS v (key, name, description, entitlements, sort_order)
WHERE p.key = 'default';

INSERT INTO plan_prices (plan_id, period, amount)
SELECT pl.id, v.period, v.amount
FROM plans pl
JOIN (VALUES
  ('basic', 'monthly', 49900),
  ('basic', 'yearly', 499000),
  ('pro', 'monthly', 99900),
  ('pro', 'yearly', 999000)
) AS v (plan_key, period, amount) ON v.plan_key = pl.key;
