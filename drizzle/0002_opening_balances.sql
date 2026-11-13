ALTER TABLE bills ADD COLUMN is_opening_balance INTEGER NOT NULL DEFAULT 0 CHECK(is_opening_balance IN (0,1));
