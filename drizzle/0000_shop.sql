CREATE TABLE medicines (
 id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
 mrp_paisa INTEGER NOT NULL CHECK(mrp_paisa > 0 AND mrp_paisa <= 1000000000),
 quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0 AND quantity <= 1000000000),
 created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE operations (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_id TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE stock_purchases (
 id TEXT PRIMARY KEY, medicine_id TEXT NOT NULL REFERENCES medicines(id), medicine_name TEXT NOT NULL,
 quantity INTEGER NOT NULL CHECK(quantity > 0 AND quantity <= 1000000), cost_paisa INTEGER NOT NULL CHECK(cost_paisa >= 0 AND cost_paisa <= 1000000000000),
 purchase_date TEXT NOT NULL, created_at TEXT NOT NULL, actor TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE bills (
 id TEXT PRIMARY KEY, patient_name TEXT NOT NULL, disease TEXT NOT NULL DEFAULT '',
 total_paisa INTEGER NOT NULL DEFAULT 0 CHECK(total_paisa >= 0 AND total_paisa <= 1000000000000),
 paid_paisa INTEGER NOT NULL DEFAULT 0 CHECK(paid_paisa >= 0 AND paid_paisa <= total_paisa), created_at TEXT NOT NULL, actor TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE bill_items (
 id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES bills(id), medicine_id TEXT NOT NULL REFERENCES medicines(id),
 medicine_name TEXT NOT NULL, mrp_paisa INTEGER NOT NULL CHECK(mrp_paisa > 0),
 quantity INTEGER NOT NULL CHECK(quantity > 0 AND quantity <= 1000000), UNIQUE(bill_id, medicine_id)
);
--> statement-breakpoint
CREATE TABLE payments (
 id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES bills(id), amount_paisa INTEGER NOT NULL CHECK(amount_paisa > 0 AND amount_paisa <= 1000000000000),
 created_at TEXT NOT NULL, actor TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX bills_created ON bills(created_at);
--> statement-breakpoint
CREATE INDEX bills_patient ON bills(patient_name COLLATE NOCASE);
--> statement-breakpoint
CREATE INDEX payments_created ON payments(created_at);
--> statement-breakpoint
CREATE INDEX payments_bill ON payments(bill_id);
--> statement-breakpoint
CREATE INDEX purchases_date ON stock_purchases(purchase_date);
--> statement-breakpoint
CREATE TRIGGER receive_stock AFTER INSERT ON stock_purchases BEGIN
 UPDATE medicines SET quantity = quantity + NEW.quantity WHERE id = NEW.medicine_id;
END;
--> statement-breakpoint
CREATE TRIGGER sell_stock BEFORE INSERT ON bill_items BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM medicines WHERE id = NEW.medicine_id AND quantity >= NEW.quantity AND mrp_paisa = NEW.mrp_paisa) THEN RAISE(ABORT, 'INSUFFICIENT_STOCK_OR_PRICE_CHANGED') END;
 UPDATE medicines SET quantity = quantity - NEW.quantity WHERE id = NEW.medicine_id;
 UPDATE bills SET total_paisa = total_paisa + NEW.mrp_paisa * NEW.quantity WHERE id = NEW.bill_id;
END;
--> statement-breakpoint
CREATE TRIGGER collect_payment BEFORE INSERT ON payments BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM bills WHERE id = NEW.bill_id AND total_paisa - paid_paisa >= NEW.amount_paisa) THEN RAISE(ABORT, 'OVERPAYMENT') END;
 UPDATE bills SET paid_paisa = paid_paisa + NEW.amount_paisa WHERE id = NEW.bill_id;
END;
