export const bugIntakeOwnedTables = ['bug_intake_reports', 'bug_intake_keys', 'bug_intake_suppression'] as const;
export const bugIntakePurgeOrder = ['bug_intake_keys', 'bug_intake_reports', 'bug_intake_suppression'] as const;
// WS01 assigns the global migration version when registering this unmounted module.
export const bugIntakeMigrationSql = `
CREATE TABLE bug_intake_reports (
  account_id TEXT NOT NULL REFERENCES form_accounts(id), id TEXT NOT NULL,
  intent_hash TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), created_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('received','prepared','dispatch_unavailable','dispatch_unknown','dispatched')),
  dispatch_receipt TEXT,
  binding TEXT CHECK(binding IS NULL OR json_valid(binding)),
  PRIMARY KEY(account_id,id), UNIQUE(account_id,intent_hash)
);
CREATE TABLE bug_intake_keys (
  account_id TEXT NOT NULL, key TEXT NOT NULL, intent_hash TEXT NOT NULL, report_id TEXT NOT NULL,
  PRIMARY KEY(account_id,key),
  FOREIGN KEY(account_id,report_id) REFERENCES bug_intake_reports(account_id,id)
);
CREATE TABLE bug_intake_suppression (
  account_id TEXT PRIMARY KEY REFERENCES form_accounts(id), epoch INTEGER NOT NULL CHECK(epoch>=0)
);
`;
