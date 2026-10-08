ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'GOODS';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_option TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant TEXT NOT NULL DEFAULT '{}';
ALTER TABLE orders ALTER COLUMN subtotal TYPE BIGINT, ALTER COLUMN fee TYPE BIGINT, ALTER COLUMN total TYPE BIGINT, ALTER COLUMN discount TYPE BIGINT;
ALTER TABLE payments ALTER COLUMN amount TYPE BIGINT;

UPDATE products
SET product_type=CASE
  WHEN lower(COALESCE(name,'')) LIKE '%thread%' OR lower(COALESCE(name,'')) LIKE '%needle%' OR lower(COALESCE(name,'')) LIKE '%zipper%' OR lower(COALESCE(name,'')) LIKE '%button%' OR lower(COALESCE(name,'')) LIKE '%tape%' OR lower(COALESCE(name,'')) LIKE '%chalk%' OR lower(COALESCE(name,'')) LIKE '%elastic%' OR lower(COALESCE(name,'')) LIKE '%fabric%' OR lower(COALESCE(name,'')) LIKE '%scissor%' OR lower(COALESCE(name,'')) LIKE '%bobbin%' OR lower(COALESCE(name,'')) LIKE '%bead%' OR lower(COALESCE(name,'')) LIKE '%sequin%' OR lower(COALESCE(name,'')) LIKE '%trimming%' THEN 'GOODS'
  WHEN lower(COALESCE(category,'')) LIKE '%drink%' OR lower(COALESCE(category,'')) LIKE '%juice%' OR lower(COALESCE(category,'')) LIKE '%water%' THEN 'DRINK'
  WHEN lower(COALESCE(category,'')) LIKE '%cloth%' OR lower(COALESCE(category,'')) LIKE '%fashion%' OR lower(COALESCE(category,'')) LIKE '%apparel%' OR lower(COALESCE(category,'')) LIKE '%wear%' OR lower(COALESCE(category,'')) LIKE '%maza%' OR lower(COALESCE(category,'')) LIKE '%mata%' OR lower(COALESCE(category,'')) LIKE '%yara%' OR lower(COALESCE(category,'')) LIKE '%riguna%' OR lower(COALESCE(category,'')) LIKE '%baby%' OR lower(COALESCE(category,'')) LIKE '%kids%' THEN 'CLOTHING'
  ELSE 'GOODS'
END;
