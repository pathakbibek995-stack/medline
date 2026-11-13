CREATE TABLE auth_sessions (
 token_hash TEXT PRIMARY KEY NOT NULL,
 actor TEXT NOT NULL,
 email TEXT NOT NULL COLLATE NOCASE,
 name TEXT NOT NULL,
 expires_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX auth_sessions_email ON auth_sessions(email);
--> statement-breakpoint
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
