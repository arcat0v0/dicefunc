import migrationSql from '../../migrations/001_initial_schema.sql?raw';

export async function applyInitialSchema(db: D1Database): Promise<void> {
  const statements = migrationSql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => db.prepare(s));

  if (statements.length > 0) {
    await db.batch(statements);
  }
}
