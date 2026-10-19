export const mascotPreferencesMigration = { version: 11, sql: `
UPDATE documents SET data=json_set(data,
 '$.mascot',COALESCE(json_extract(data,'$.mascot'),'scholarly'),
 '$.animationStyle',COALESCE(json_extract(data,'$.animationStyle'),'short')), revision=revision+1
 WHERE kind='preferences' AND (json_type(data,'$.mascot') IS NULL OR json_type(data,'$.animationStyle') IS NULL);
INSERT INTO document_revisions(account_id,kind,revision,data,created_at)
 SELECT account_id,kind,revision,data,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM documents
 WHERE kind='preferences' AND revision NOT IN
 (SELECT revision FROM document_revisions WHERE account_id=documents.account_id AND kind='preferences');
` } as const;
