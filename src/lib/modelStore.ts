import { getDb } from '@/lib/db';

export interface SunoModel {
  id: string;
  name: string;
  external_key: string;
  major_version: number;
  description: string;
  is_default_free_model: boolean;
  is_default_model: boolean;
  can_use: boolean;
  badges: string[];
  capabilities: string[];
  features: string[];
}

export interface ModelSnapshot {
  updatedAt: string;
  models: SunoModel[];
}

interface ModelRow {
  external_key: string;
  model_id: string;
  name: string;
  major_version: number;
  description: string;
  is_default_free_model: number;
  is_default_model: number;
  can_use: number;
  badges: string;
  capabilities: string;
  features: string;
  updated_at: string;
}

function rowToModel(row: ModelRow): SunoModel {
  return {
    id: row.model_id,
    name: row.name,
    external_key: row.external_key,
    major_version: row.major_version as number,
    description: row.description,
    is_default_free_model: row.is_default_free_model === 1,
    is_default_model: row.is_default_model === 1,
    can_use: row.can_use === 1,
    badges: JSON.parse(row.badges),
    capabilities: JSON.parse(row.capabilities),
    features: JSON.parse(row.features),
  };
}

export async function loadModels(): Promise<void> {
  await getDb();
}

export async function getModelsSnapshot(): Promise<ModelSnapshot> {
  const db = await getDb();
  const rows = db.prepare('SELECT * FROM models').all() as ModelRow[];
  const kvRow = db.prepare("SELECT value FROM kv WHERE key = ?").get(['models_updated_at']) as { value: string } | undefined;
  return {
    updatedAt: kvRow?.value ?? '',
    models: rows.map(rowToModel),
  };
}

export async function saveModels(rawModels: any[]): Promise<{ added: string[]; removed: string[] }> {
  const db = await getDb();
  const now = new Date().toISOString();

  const prev = db.prepare('SELECT external_key, name FROM models').all() as { external_key: string; name: string }[];
  const prevKeys = new Set(prev.map(m => m.external_key));

  const next: SunoModel[] = rawModels.map(m => ({
    id: m.id,
    name: m.name,
    external_key: m.external_key,
    major_version: m.major_version ?? 0,
    description: m.description ?? '',
    is_default_free_model: !!m.is_default_free_model,
    is_default_model: !!m.is_default_model,
    can_use: !!m.can_use,
    badges: m.badges ?? [],
    capabilities: m.capabilities ?? [],
    features: m.features ?? [],
  }));

  const nextKeys = new Set(next.map(m => m.external_key));
  const added = next.filter(m => !prevKeys.has(m.external_key)).map(m => m.name);
  const removed = prev.filter(m => !nextKeys.has(m.external_key)).map(m => m.name);

  const upsertSql = `
    INSERT INTO models (external_key, model_id, name, major_version, description,
      is_default_free_model, is_default_model, can_use, badges, capabilities, features, updated_at)
    VALUES (@external_key, @model_id, @name, @major_version, @description,
      @is_default_free_model, @is_default_model, @can_use, @badges, @capabilities, @features, @updated_at)
    ON CONFLICT(external_key) DO UPDATE SET
      model_id = excluded.model_id, name = excluded.name,
      major_version = excluded.major_version, description = excluded.description,
      is_default_free_model = excluded.is_default_free_model,
      is_default_model = excluded.is_default_model, can_use = excluded.can_use,
      badges = excluded.badges, capabilities = excluded.capabilities,
      features = excluded.features, updated_at = excluded.updated_at
  `;

  db.transaction(() => {
    for (const m of prev) {
      if (!nextKeys.has(m.external_key)) {
        db.prepare('DELETE FROM models WHERE external_key = ?').run([m.external_key]);
      }
    }
    for (const m of next) {
      db.prepare(upsertSql).run({
        external_key: m.external_key,
        model_id: m.id,
        name: m.name,
        major_version: m.major_version,
        description: m.description,
        is_default_free_model: m.is_default_free_model ? 1 : 0,
        is_default_model: m.is_default_model ? 1 : 0,
        can_use: m.can_use ? 1 : 0,
        badges: JSON.stringify(m.badges),
        capabilities: JSON.stringify(m.capabilities),
        features: JSON.stringify(m.features),
        updated_at: now,
      });
    }
    db.prepare(`
      INSERT INTO kv (key, value) VALUES ('models_updated_at', @value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run({ value: now });
  })();

  return { added, removed };
}
