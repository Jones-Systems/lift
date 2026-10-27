import type { Migration } from '../storage.js';

export const lifecycleEvidenceOwnedTables = Object.freeze(['account_deletion_evidence_operations', 'account_deletion_evidence'] as const);
const identifier = (column: string) => `${column} TEXT NOT NULL CHECK(length(${column}) BETWEEN 1 AND 256 AND ${column} NOT GLOB '*[^A-Za-z0-9_.:-]*')`;
const digest = (column: string) => `${column} TEXT NOT NULL CHECK(length(${column})=64 AND ${column} NOT GLOB '*[^a-f0-9]*')`;
const counter = (column: string, minimum = 0) => `${column} INTEGER NOT NULL CHECK(typeof(${column})='integer' AND ${column} BETWEEN ${minimum} AND 9007199254740991)`;

export const lifecycleEvidenceSchemaObjects = Object.freeze([
  { type: 'table', name: lifecycleEvidenceOwnedTables[0], sql: `CREATE TABLE account_deletion_evidence_operations (
    ${identifier('request_id')} REFERENCES account_deletion_requests(id),
    ${identifier('operation_id')}, ${identifier('account_id')} REFERENCES form_accounts(id),
    ${identifier('auth_user_id')}, ${counter('lifecycle_epoch', 1)}, ${counter('suppression_sequence', 1)},
    purpose TEXT NOT NULL CHECK(purpose='local_purge'), ${digest('scope_digest')}, ${digest('proof_digest')},
    ${identifier('policy_version')}, ${counter('created_at_ms')},
    PRIMARY KEY(request_id,operation_id))` },
  { type: 'table', name: lifecycleEvidenceOwnedTables[1], sql: `CREATE TABLE account_deletion_evidence (
    ${identifier('request_id')}, ${identifier('operation_id')}, ${identifier('evidence_id')}, ${identifier('attempt_id')},
    ${identifier('category')}, ${digest('target_digest')},
    fact_kind TEXT NOT NULL CHECK(fact_kind IN('local_purge_readback','provider_revocation_acknowledgment','backup_disposition','observation')),
    result TEXT NOT NULL CHECK(result IN('qualifying','unknown','pending','unavailable','retained','not_qualifying','conflicting')),
    ${counter('observed_at_ms')}, ${identifier('database_generation')},
    schema_cohort TEXT NOT NULL CHECK(schema_cohort='lifecycle-evidence-v1'), ${digest('schema_digest')},
    ${identifier('authority_id')}, ${digest('authority_schema_digest')}, ${counter('suppression_sequence', 1)},
    ${counter('suppression_floor', 1)}, ${digest('suppression_head')}, ${counter('witness_revision')},
    ${identifier('policy_version')},
    payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) BETWEEN 1 AND 16384 AND json_valid(payload)),
    ${digest('payload_digest')}, PRIMARY KEY(request_id,operation_id,evidence_id),
    FOREIGN KEY(request_id,operation_id) REFERENCES account_deletion_evidence_operations(request_id,operation_id))` },
  { type: 'index', name: 'deletion_evidence_request_generation_category', sql: 'CREATE INDEX deletion_evidence_request_generation_category ON account_deletion_evidence(request_id,database_generation,category)' },
  ...lifecycleEvidenceOwnedTables.flatMap(table => ['update', 'delete'].map(effect => ({ type: 'trigger',
    name: `${table}_no_${effect}`, sql: `CREATE TRIGGER ${table}_no_${effect} BEFORE ${effect.toUpperCase()} ON ${table} BEGIN SELECT RAISE(ABORT, 'lifecycle_evidence_immutable'); END` }))),
].map(object => Object.freeze(object)));
export const lifecycleEvidenceMigrationSql = lifecycleEvidenceSchemaObjects.map(object => object.sql + ';').join('\n');
export const sourceLifecycleEvidenceMigration: Readonly<Migration> = Object.freeze({ version: 24, sql: lifecycleEvidenceMigrationSql });
