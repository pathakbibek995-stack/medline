CREATE TABLE staff_access (
 email TEXT PRIMARY KEY NOT NULL COLLATE NOCASE,
 name TEXT NOT NULL DEFAULT '',
 role TEXT CHECK(role IS NULL OR role IN ('admin','worker')),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','revoked')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 updated_by TEXT,
 CHECK(status <> 'approved' OR role IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE access_audit (
 id TEXT PRIMARY KEY NOT NULL,
 email TEXT NOT NULL,
 role TEXT,
 status TEXT NOT NULL,
 actor TEXT NOT NULL,
 created_at TEXT NOT NULL
);
