import { spawnSync } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'wrangler.jsonc');
const deployConfigPath = path.join(root, '.wrangler.deploy.jsonc');
const databaseName = 'tv013-db';
const bucketName = 'tv013-media';

function run(args, { capture = false } = {}) {
  const result = spawnSync('npx', ['--no-install', 'wrangler', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit'
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture) process.stderr.write(result.stderr);
    throw new Error(`wrangler ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}.`);
  }

  return capture ? result.stdout : '';
}

function parseJson(output, description) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`Could not read JSON from Wrangler while ${description}.`);
  }
}

async function findOrCreateDatabase() {
  const databases = parseJson(run(['d1', 'list', '--json'], { capture: true }), 'listing D1 databases');
  if (!Array.isArray(databases)) throw new Error('Wrangler returned an unexpected D1 database list.');

  const existing = databases.find((database) => database.name === databaseName);
  if (existing?.uuid) {
    console.log(`Using D1 database "${databaseName}".`);
    return existing.uuid;
  }

  console.log(`Creating D1 database "${databaseName}"...`);
  const output = run(['d1', 'create', databaseName], { capture: true });
  process.stdout.write(output);
  const id = output.match(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i)?.[0];
  if (!id) throw new Error(`Wrangler did not return the ID for D1 database "${databaseName}".`);
  return id;
}

function hasBucket(output) {
  return output.split(/\r?\n/).some((line) => line.trim().split(/\s+/).includes(bucketName));
}

async function ensureBucket() {
  const buckets = run(['r2', 'bucket', 'list'], { capture: true });
  if (hasBucket(buckets)) {
    console.log(`Using R2 bucket "${bucketName}".`);
    return;
  }

  console.log(`Creating R2 bucket "${bucketName}"...`);
  run(['r2', 'bucket', 'create', bucketName]);
}

async function main() {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const d1 = config.d1_databases?.find((binding) => binding.binding === 'DB');
  if (!d1) throw new Error('wrangler.jsonc must define the D1 binding "DB".');

  const databaseId = await findOrCreateDatabase();
  await ensureBucket();

  d1.database_id = databaseId;
  await writeFile(deployConfigPath, `${JSON.stringify(config, null, 2)}\n`);

  try {
    run(['d1', 'migrations', 'apply', databaseName, '--remote', '--force', '--config', deployConfigPath]);
    run(['deploy', '--config', deployConfigPath]);
  } finally {
    await rm(deployConfigPath, { force: true });
  }
}

main().catch((error) => {
  console.error(`[Cloudflare deploy] ${error.message}`);
  process.exitCode = 1;
});
