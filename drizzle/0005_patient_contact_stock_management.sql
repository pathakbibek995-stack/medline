ALTER TABLE bills ADD COLUMN contact_number TEXT NOT NULL DEFAULT '' CHECK(length(contact_number)<=40);
--> statement-breakpoint
ALTER TABLE bills ADD COLUMN additional_charge_paisa INTEGER NOT NULL DEFAULT 0 CHECK(additional_charge_paisa>=0 AND additional_charge_paisa<=1000000000000);
--> statement-breakpoint
ALTER TABLE medicines ADD COLUMN deleted_at TEXT;
--> statement-breakpoint
CREATE TABLE stock_changes (
 id TEXT PRIMARY KEY,
 medicine_id TEXT NOT NULL REFERENCES medicines(id),
 action TEXT NOT NULL CHECK(action IN ('update','delete')),
 name TEXT NOT NULL,
 mrp_paisa INTEGER NOT NULL CHECK(mrp_paisa>0 AND mrp_paisa<=1000000000),
 quantity INTEGER NOT NULL CHECK(quantity>=0 AND quantity<=1000000000),
 expected_name TEXT NOT NULL,
 expected_mrp_paisa INTEGER NOT NULL,
 expected_quantity INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 actor TEXT NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER apply_stock_change BEFORE INSERT ON stock_changes BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM medicines WHERE id=NEW.medicine_id AND deleted_at IS NULL AND name=NEW.expected_name COLLATE BINARY AND mrp_paisa=NEW.expected_mrp_paisa AND quantity=NEW.expected_quantity) THEN RAISE(ABORT,'STOCK_CHANGED') END;
 UPDATE medicines SET name=NEW.name,mrp_paisa=NEW.mrp_paisa,quantity=CASE WHEN NEW.action='delete' THEN 0 ELSE NEW.quantity END,deleted_at=CASE WHEN NEW.action='delete' THEN NEW.created_at ELSE NULL END WHERE id=NEW.medicine_id;
END;
--> statement-breakpoint
DROP TRIGGER sell_stock;
--> statement-breakpoint
CREATE TRIGGER sell_stock BEFORE INSERT ON bill_items BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM medicines WHERE id=NEW.medicine_id AND deleted_at IS NULL AND quantity>=NEW.quantity AND mrp_paisa=NEW.mrp_paisa) THEN RAISE(ABORT,'INSUFFICIENT_STOCK_OR_PRICE_CHANGED') END;
 UPDATE medicines SET quantity=quantity-NEW.quantity WHERE id=NEW.medicine_id;
 UPDATE bills SET total_paisa=total_paisa+NEW.mrp_paisa*NEW.quantity WHERE id=NEW.bill_id;
END;
