ALTER TABLE bills ADD COLUMN discount_paisa INTEGER NOT NULL DEFAULT 0 CHECK(discount_paisa >= 0 AND discount_paisa <= 1000000000000);
