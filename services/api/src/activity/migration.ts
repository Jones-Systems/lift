export const activityMigrationVersion = 8 as const;
export const activityOwnedTables = [
  'activity_calendar', 'activity_state', 'activity_exercises', 'activity_exercise_revisions',
  'activity_plans', 'activity_plan_revisions', 'activity_schedules', 'activity_schedule_revisions',
  'activity_days', 'activity_day_revisions', 'activity_entries', 'activity_entry_revisions',
] as const;
export const activityPurgeOrder = [
  'activity_entry_revisions', 'activity_entries', 'activity_day_revisions', 'activity_days',
  'activity_schedule_revisions', 'activity_schedules', 'activity_plan_revisions', 'activity_plans',
  'activity_exercise_revisions', 'activity_exercises', 'activity_state', 'activity_calendar',
] as const;
export const activityMigrationSql = `
CREATE TABLE activity_state (
  account_id TEXT PRIMARY KEY REFERENCES form_accounts(id),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0)
);
CREATE TABLE activity_calendar (
  account_id TEXT PRIMARY KEY REFERENCES form_accounts(id),
  revision INTEGER NOT NULL CHECK(revision >= 1), time_zone TEXT NOT NULL,
  activation_date TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE activity_exercises (
  account_id TEXT NOT NULL REFERENCES form_accounts(id), id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1), retired INTEGER NOT NULL CHECK(retired IN (0,1)),
  data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(account_id,id)
);
CREATE TABLE activity_exercise_revisions (
  account_id TEXT NOT NULL, exercise_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1),
  data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(account_id,exercise_id,revision),
  FOREIGN KEY(account_id,exercise_id) REFERENCES activity_exercises(account_id,id)
);
CREATE TABLE activity_plans (
  account_id TEXT NOT NULL REFERENCES form_accounts(id), id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1), archived INTEGER NOT NULL CHECK(archived IN (0,1)),
  legacy_plan_id TEXT, legacy_plan_revision INTEGER CHECK(legacy_plan_revision >= 1),
  data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(account_id,id),
  CHECK((legacy_plan_id IS NULL) = (legacy_plan_revision IS NULL)),
  UNIQUE(account_id,legacy_plan_id,legacy_plan_revision)
);
CREATE TABLE activity_plan_revisions (
  account_id TEXT NOT NULL, plan_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1),
  data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(account_id,plan_id,revision),
  FOREIGN KEY(account_id,plan_id) REFERENCES activity_plans(account_id,id)
);
CREATE TABLE activity_schedules (
  account_id TEXT PRIMARY KEY REFERENCES form_accounts(id), id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1), data TEXT NOT NULL CHECK(json_valid(data)),
  UNIQUE(account_id,id)
);
CREATE TABLE activity_schedule_revisions (
  account_id TEXT NOT NULL, schedule_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1),
  effective_from TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(account_id,schedule_id,revision),
  FOREIGN KEY(account_id,schedule_id) REFERENCES activity_schedules(account_id,id)
);
CREATE TABLE activity_days (
  account_id TEXT NOT NULL REFERENCES form_accounts(id), local_date TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1), data TEXT NOT NULL CHECK(json_valid(data)),
  PRIMARY KEY(account_id,local_date)
);
CREATE TABLE activity_day_revisions (
  account_id TEXT NOT NULL, local_date TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1),
  data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(account_id,local_date,revision),
  FOREIGN KEY(account_id,local_date) REFERENCES activity_days(account_id,local_date)
);
CREATE TABLE activity_entries (
  account_id TEXT NOT NULL REFERENCES form_accounts(id), id TEXT NOT NULL,
  draft_id TEXT NOT NULL, draft_intent_hash TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1),
  local_date TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('recorded','voided')),
  data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(account_id,id), UNIQUE(account_id,draft_id)
);
CREATE TABLE activity_entry_revisions (
  account_id TEXT NOT NULL, entry_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1),
  data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(account_id,entry_id,revision),
  FOREIGN KEY(account_id,entry_id) REFERENCES activity_entries(account_id,id)
);
CREATE INDEX activity_entries_by_date ON activity_entries(account_id,local_date,id);
CREATE INDEX activity_exercises_active ON activity_exercises(account_id,retired,id);
CREATE INDEX activity_schedules_effective ON activity_schedule_revisions(account_id,effective_from,revision);
CREATE TRIGGER activity_immutable_exercise_revision BEFORE UPDATE ON activity_exercise_revisions
  BEGIN SELECT RAISE(ABORT,'activity_immutable_history'); END;
CREATE TRIGGER activity_immutable_plan_revision BEFORE UPDATE ON activity_plan_revisions
  BEGIN SELECT RAISE(ABORT,'activity_immutable_history'); END;
CREATE TRIGGER activity_immutable_schedule_revision BEFORE UPDATE ON activity_schedule_revisions
  BEGIN SELECT RAISE(ABORT,'activity_immutable_history'); END;
CREATE TRIGGER activity_immutable_day_revision BEFORE UPDATE ON activity_day_revisions
  BEGIN SELECT RAISE(ABORT,'activity_immutable_history'); END;
CREATE TRIGGER activity_immutable_entry_revision BEFORE UPDATE ON activity_entry_revisions
  BEGIN SELECT RAISE(ABORT,'activity_immutable_history'); END;
CREATE TRIGGER activity_fixed_calendar BEFORE UPDATE ON activity_calendar
  BEGIN SELECT RAISE(ABORT,'activity_fixed_calendar'); END;
CREATE TRIGGER activity_monotonic_retirement BEFORE UPDATE OF retired ON activity_exercises
  WHEN NEW.retired < OLD.retired BEGIN SELECT RAISE(ABORT,'activity_retirement_monotonic'); END;
`;
export const activityMigration = { version: activityMigrationVersion, sql: activityMigrationSql } as const;
