export const progressComparisonOwnedTables = ['progress_comparison_identities', 'progress_comparison_identity_revisions'] as const;
export const progressComparisonPurgeOrder = ['progress_comparison_identity_revisions', 'progress_comparison_identities'] as const;
// WS01 assigns the global migration version and composes this fragment on the canonical account database.
export const progressComparisonMigrationSql = `
CREATE TABLE progress_comparison_identities (
 account_id TEXT NOT NULL REFERENCES form_accounts(id), id TEXT NOT NULL,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('session','activity')), source_id TEXT NOT NULL, item_id TEXT NOT NULL,
 source_revision INTEGER NOT NULL CHECK(source_revision>=1), revision INTEGER NOT NULL CHECK(revision>=1),
 status TEXT NOT NULL CHECK(status IN ('confirmed','withdrawn')),
 data TEXT CHECK(data IS NULL OR json_valid(data)), updated_at TEXT NOT NULL,
 PRIMARY KEY(account_id,id), UNIQUE(account_id,source_kind,source_id,item_id),
 CHECK((status='confirmed' AND data IS NOT NULL) OR (status='withdrawn' AND data IS NULL))
);
CREATE TABLE progress_comparison_identity_revisions (
 account_id TEXT NOT NULL, identity_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1),
 source_revision INTEGER NOT NULL CHECK(source_revision>=1), action TEXT NOT NULL CHECK(action IN ('confirm','withdraw')),
 recorded_at TEXT NOT NULL, PRIMARY KEY(account_id,identity_id,revision),
 FOREIGN KEY(account_id,identity_id) REFERENCES progress_comparison_identities(account_id,id)
);
`;
