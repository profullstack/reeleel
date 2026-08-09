import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { all, execute, get, globalDb, parseJson } from './db.js';
import { ReelEelError, invalidInput, notFound } from './errors.js';
import { newId, nowIso } from './ids.js';
import { modelStorePath } from './layout.js';
import type { ModelRecord } from './types.js';

interface ModelRow {
  id: string;
  name: string;
  version: string;
  sport: string;
  architecture: string;
  classes_json: string;
  runtime: string;
  license: string;
  path: string | null;
  checksum: string | null;
  dataset_version: string | null;
  metrics_json: string;
  installed_at: string;
  updated_at: string;
}

const toModel = (row: ModelRow): ModelRecord => ({
  id: row.id,
  name: row.name,
  version: row.version,
  sport: row.sport,
  architecture: row.architecture,
  classes: parseJson<string[]>(row.classes_json, []),
  runtime: row.runtime,
  license: row.license,
  path: row.path,
  checksum: row.checksum,
  datasetVersion: row.dataset_version,
  metrics: parseJson<Record<string, number>>(row.metrics_json, {}),
  installedAt: row.installed_at,
  updatedAt: row.updated_at,
});

export const sha256 = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

export interface AddModelInput {
  name: string;
  version: string;
  sport: string;
  /** Weights file. Copied into the model store unless `link` is set. */
  file?: string;
  link?: boolean;
  architecture?: string;
  classes?: string[];
  runtime?: string;
  /**
   * Required by the PRD's license policy: a FOSS framework does not make its
   * weights redistributable, so every registered model states its own license.
   */
  license?: string;
  datasetVersion?: string;
  metrics?: Record<string, number>;
}

export const addModel = async (input: AddModelInput): Promise<ModelRecord> => {
  if (input.name.trim().length === 0) throw invalidInput('Model name cannot be empty.');
  if (input.version.trim().length === 0) throw invalidInput('Model version cannot be empty.');

  let storedPath: string | null = null;
  let checksum: string | null = null;

  if (input.file !== undefined) {
    const source = path.resolve(input.file);
    if (!existsSync(source) || !statSync(source).isFile()) {
      throw new ReelEelError('MODEL_MISSING', `${source} does not exist.`);
    }
    checksum = sha256(source);

    if (input.link === true) {
      storedPath = source;
    } else {
      const store = path.join(modelStorePath(), input.sport, `${input.name}-${input.version}`);
      mkdirSync(store, { recursive: true });
      storedPath = path.join(store, path.basename(source));
      copyFileSync(source, storedPath);
    }
  }

  const db = await globalDb();
  const clash = await get<{ id: string }>(
    db,
    'SELECT id FROM models WHERE name = ? AND version = ?',
    [input.name, input.version],
  );
  if (clash !== undefined) {
    throw new ReelEelError(
      'CONFLICT',
      `Model ${input.name}@${input.version} is already registered.`,
      { hint: `Update it instead: reeleel models update ${input.name}@${input.version} …` },
    );
  }

  const id = newId('mdl');
  const timestamp = nowIso();
  await execute(
    db,
    `INSERT INTO models
       (id, name, version, sport, architecture, classes_json, runtime, license,
        path, checksum, dataset_version, metrics_json, installed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name,
      input.version,
      input.sport,
      input.architecture ?? 'unknown',
      JSON.stringify(input.classes ?? []),
      input.runtime ?? 'onnx',
      input.license ?? 'unknown',
      storedPath,
      checksum,
      input.datasetVersion ?? null,
      JSON.stringify(input.metrics ?? {}),
      timestamp,
      timestamp,
    ],
  );

  const row = await get<ModelRow>(db, 'SELECT * FROM models WHERE id = ?', [id]);
  if (row === undefined) throw notFound('Model', id);
  return toModel(row);
};

export interface ListModelsOptions {
  sport?: string;
}

export const listModels = async (options: ListModelsOptions = {}): Promise<ModelRecord[]> => {
  const db = await globalDb();
  const where = options.sport === undefined ? '' : 'WHERE sport = ?';
  const params = options.sport === undefined ? [] : [options.sport];
  const rows = await all<ModelRow>(
    db,
    `SELECT * FROM models ${where} ORDER BY sport, name, version`,
    params,
  );
  return rows.map(toModel);
};

/** Accepts `id`, `name`, or `name@version`. Bare names take the newest version. */
export const getModel = async (reference: string): Promise<ModelRecord> => {
  const models = await listModels();
  const byId = models.find((model) => model.id === reference);
  if (byId !== undefined) return byId;

  const [name, version] = reference.split('@');
  const matches = models.filter(
    (model) => model.name === name && (version === undefined || model.version === version),
  );
  if (matches.length === 0) throw notFound('Model', reference);

  const newest = matches.sort((a, b) => b.installedAt.localeCompare(a.installedAt))[0];
  if (newest === undefined) throw notFound('Model', reference);
  return newest;
};

export interface ModelUpdate {
  license?: string;
  architecture?: string;
  runtime?: string;
  classes?: string[];
  datasetVersion?: string | null;
  metrics?: Record<string, number>;
  path?: string;
}

export const updateModel = async (
  reference: string,
  patch: ModelUpdate,
): Promise<ModelRecord> => {
  const model = await getModel(reference);

  let nextPath = model.path;
  let checksum = model.checksum;
  if (patch.path !== undefined) {
    nextPath = path.resolve(patch.path);
    if (!existsSync(nextPath)) {
      throw new ReelEelError('MODEL_MISSING', `${nextPath} does not exist.`);
    }
    checksum = sha256(nextPath);
  }

  const db = await globalDb();
  await execute(
    db,
    `UPDATE models
       SET license = ?, architecture = ?, runtime = ?, classes_json = ?,
           dataset_version = ?, metrics_json = ?, path = ?, checksum = ?, updated_at = ?
     WHERE id = ?`,
    [
      patch.license ?? model.license,
      patch.architecture ?? model.architecture,
      patch.runtime ?? model.runtime,
      JSON.stringify(patch.classes ?? model.classes),
      patch.datasetVersion === undefined ? model.datasetVersion : patch.datasetVersion,
      JSON.stringify(patch.metrics ?? model.metrics),
      nextPath,
      checksum,
      nowIso(),
      model.id,
    ],
  );

  const row = await get<ModelRow>(db, 'SELECT * FROM models WHERE id = ?', [model.id]);
  if (row === undefined) throw notFound('Model', model.id);
  return toModel(row);
};

export interface RemoveModelOptions {
  /** Also delete the weights from the model store. */
  purge?: boolean;
}

export const removeModel = async (
  reference: string,
  options: RemoveModelOptions = {},
): Promise<ModelRecord> => {
  const model = await getModel(reference);
  const db = await globalDb();
  await execute(db, 'DELETE FROM models WHERE id = ?', [model.id]);

  if (options.purge === true && model.path !== null && existsSync(model.path)) {
    // Only delete weights we copied into our own store.
    if (model.path.startsWith(modelStorePath())) {
      rmSync(path.dirname(model.path), { recursive: true, force: true });
    }
  }
  return model;
};

export interface ModelVerification {
  model: ModelRecord;
  ok: boolean;
  reason?: string;
}

/** Confirms the weights are still present and unmodified. */
export const verifyModel = async (reference: string): Promise<ModelVerification> => {
  const model = await getModel(reference);
  if (model.path === null) {
    return { model, ok: false, reason: 'No weights file is registered for this model.' };
  }
  if (!existsSync(model.path)) {
    return { model, ok: false, reason: `Weights missing at ${model.path}.` };
  }
  if (model.checksum !== null && sha256(model.path) !== model.checksum) {
    return { model, ok: false, reason: 'Checksum mismatch — the weights file changed on disk.' };
  }
  return { model, ok: true };
};
