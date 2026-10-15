-- A small demo of the product itself, to show plan limits and features being enforced
-- (see workspace.js): projects count against the "projects" limit, and a custom domain needs
-- the "custom_domain" feature.

CREATE TABLE projects (
  id         int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  int NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_tenant ON projects (tenant_id);

-- Kept when a downgrade turns the feature off (it just stops working), so it works again on upgrade.
ALTER TABLE tenants ADD COLUMN custom_domain text;
CREATE UNIQUE INDEX tenants_custom_domain ON tenants (lower(custom_domain));
