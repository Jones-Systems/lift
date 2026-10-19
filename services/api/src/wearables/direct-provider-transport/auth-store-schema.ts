// Unnumbered source only. Root selects and installs this fragment in its existing database; adapters never execute it.
export const providerAuthStateTableSql = `CREATE TABLE wearable_provider_auth_state (
  record_key TEXT NOT NULL PRIMARY KEY CHECK(length(CAST(record_key AS BLOB)) BETWEEN 1 AND 32768),
  account_id TEXT NOT NULL REFERENCES form_accounts(id) CHECK(length(CAST(account_id AS BLOB)) BETWEEN 1 AND 8192),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),
  data TEXT NOT NULL CHECK(length(CAST(data AS BLOB)) BETWEEN 1 AND 1048576 AND json_valid(data)),
  CHECK(json_type(data) IS 'object'), CHECK(json_extract(data,'$.schema') IS 1),
  CHECK(json_extract(data,'$.key') IS record_key),
  CHECK(json_extract(data,'$.scope.accountId') IS account_id),
  CHECK(json_extract(data,'$.revision') IS revision)
)`;
export const providerAuthStateIndexSql = 'CREATE INDEX wearable_provider_auth_account ON wearable_provider_auth_state(account_id,record_key)';
export const providerAuthStateSql = providerAuthStateTableSql + ';\n' + providerAuthStateIndexSql + ';\n';
