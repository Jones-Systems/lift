import type { Migration } from './storage.js';

// Keep both FK-related replacements inside the migration runner's transaction, with foreign_keys ON.
export const sourcePrescriptionMigration: Migration = Object.freeze({ version: 19, sql: `
CREATE TABLE performed_sets_source_v19 (
 account_id TEXT NOT NULL, session_id TEXT NOT NULL, id TEXT NOT NULL,
 occurrence_id TEXT NOT NULL, set_number INTEGER NOT NULL CHECK(set_number BETWEEN 1 AND 100),
 revision INTEGER NOT NULL CHECK(revision >= 1), reps INTEGER, weight_kg REAL,
 status TEXT NOT NULL CHECK(status IN('draft','confirmed','voided')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, performance TEXT,
 PRIMARY KEY(account_id,session_id,id), UNIQUE(account_id,session_id,occurrence_id,set_number),
 FOREIGN KEY(account_id,session_id,occurrence_id) REFERENCES session_occurrences(account_id,session_id,id),
 CHECK(CASE WHEN performance IS NULL THEN
   reps IS NOT NULL AND reps BETWEEN 0 AND 100 AND weight_kg IS NOT NULL AND weight_kg BETWEEN 0 AND 500
   AND (status <> 'confirmed' OR reps > 0)
 WHEN json_valid(performance) THEN COALESCE(
   reps IS NULL AND weight_kg IS NULL AND json_type(performance) = 'object'
   AND json_extract(performance,'$.schema') = 'form.source-performance/v1'
   AND json_type(performance,'$.load') = 'object'
   AND json_extract(performance,'$.load.kind') = 'unspecified'
   AND json_extract(performance,'$.load.basis') = 'unknown'
   AND json_remove(json_extract(performance,'$.load'),'$.kind','$.basis') = '{}'
   AND CASE json_extract(performance,'$.kind')
     WHEN 'repetitions' THEN
       json_remove(performance,'$.schema','$.kind','$.load','$.reps') = '{}'
       AND json_type(performance,'$.reps') = 'integer'
       AND json_extract(performance,'$.reps') BETWEEN 0 AND 100
       AND (status <> 'confirmed' OR json_extract(performance,'$.reps') > 0)
     WHEN 'controlled-practice' THEN json_remove(performance,'$.schema','$.kind','$.load') = '{}'
     ELSE 0
   END, 0)
 ELSE 0 END)
);
CREATE TABLE set_revisions_source_v19 (
 account_id TEXT NOT NULL, session_id TEXT NOT NULL, set_id TEXT NOT NULL,
 revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), created_at TEXT NOT NULL,
 PRIMARY KEY(account_id,session_id,set_id,revision),
 FOREIGN KEY(account_id,session_id,set_id) REFERENCES performed_sets_source_v19(account_id,session_id,id)
);
INSERT INTO performed_sets_source_v19
 (account_id,session_id,id,occurrence_id,set_number,revision,reps,weight_kg,status,created_at,updated_at,performance)
 SELECT account_id,session_id,id,occurrence_id,set_number,revision,reps,weight_kg,status,created_at,updated_at,NULL
 FROM performed_sets;
INSERT INTO set_revisions_source_v19(account_id,session_id,set_id,revision,data,created_at)
 SELECT account_id,session_id,set_id,revision,data,created_at FROM set_revisions;
DROP TABLE set_revisions;
DROP TABLE performed_sets;
ALTER TABLE performed_sets_source_v19 RENAME TO performed_sets;
ALTER TABLE set_revisions_source_v19 RENAME TO set_revisions;
CREATE INDEX confirmed_sets ON performed_sets(account_id,status,session_id);
CREATE TRIGGER immutable_set_history BEFORE UPDATE ON set_revisions
 BEGIN SELECT RAISE(ABORT, 'immutable_set_history'); END;
` });
