export const featureBoardCorrectionMigrationVersion = 20;
export const featureBoardCorrectionMigrationSql = `
CREATE TABLE community_board_correction_events (
 id TEXT PRIMARY KEY,
 predecessor_id TEXT NOT NULL UNIQUE REFERENCES community_board_submissions(id),
 successor_id TEXT NOT NULL UNIQUE REFERENCES community_board_submissions(id),
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
 CHECK(predecessor_id<>successor_id)
);
CREATE TRIGGER community_board_correction_immutable
BEFORE UPDATE ON community_board_correction_events
BEGIN SELECT RAISE(ABORT,'immutable_board_correction'); END;
`;
