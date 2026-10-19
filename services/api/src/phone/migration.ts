// Root assigns the ordered migration version and owns its backup/application.
export const phoneMigrationSql = `
  ALTER TABLE "user" ADD COLUMN phoneNumber TEXT;
  ALTER TABLE "user" ADD COLUMN phoneNumberVerified INTEGER CHECK(phoneNumberVerified IN(0,1));
  CREATE UNIQUE INDEX auth_phone_subject ON "user"(phoneNumber);
  CREATE TABLE phone_challenges (
    id TEXT PRIMARY KEY, phone TEXT NOT NULL, binding_hash TEXT NOT NULL, start_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK(status IN('sending','pending','checking','consumed','failed','unknown')),
    provider_sid TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    last_send_at INTEGER NOT NULL, send_count INTEGER NOT NULL DEFAULT 1 CHECK(send_count BETWEEN 1 AND 3),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 3),
    approved_at INTEGER, auth_user_id TEXT REFERENCES "user"(id)
  );
  CREATE INDEX phone_challenge_phone ON phone_challenges(phone,created_at);
  CREATE TABLE phone_operations (
    challenge_id TEXT NOT NULL REFERENCES phone_challenges(id), operation TEXT NOT NULL CHECK(operation IN('start','resend','check')),
    key TEXT NOT NULL, intent_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN('claimed','done','rejected','unknown')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(challenge_id,operation,key)
  );
`;
