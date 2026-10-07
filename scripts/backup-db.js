#!/usr/bin/env node
/**
 * Sauvegarde MongoDB avec mongodump
 *
 * Écrit une archive compressée de toute la base dans backups/ (ou BACKUP_DIR)
 * et ne garde que les BACKUP_KEEP plus récentes (7 par défaut).
 * Nécessite mongodump (paquet mongodb-database-tools).
 *
 * Restaurer :
 *   mongorestore --uri "$MONGODB_URI" --gzip --archive=backups/<fichier> --drop
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups'));
const BACKUP_KEEP = Math.max(1, parseInt(process.env.BACKUP_KEEP, 10) || 7);
const PREFIX = 'randomizer-';
const SUFFIX = '.archive.gz';

function runMongodump(uri, archivePath) {
  // L'URI (et donc le mot de passe) passe par un fichier de configuration
  // lisible par nous seuls plutôt que par la ligne de commande, visible dans `ps`.
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mongodump-')), 'config.yml');
  fs.writeFileSync(configPath, `uri: ${JSON.stringify(uri)}\n`, { mode: 0o600 });

  return new Promise((resolve, reject) => {
    const child = spawn('mongodump', [`--config=${configPath}`, `--archive=${archivePath}`, '--gzip'], {
      stdio: ['ignore', 'inherit', 'inherit']
    });
    child.on('error', (error) => {
      reject(error.code === 'ENOENT' ? new Error('mongodump introuvable : installer mongodb-database-tools') : error);
    });
    child.on('close', (code) => {
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
      code === 0 ? resolve() : reject(new Error(`mongodump a échoué (code ${code})`));
    });
  });
}

function rotateBackups() {
  const archives = fs.readdirSync(BACKUP_DIR)
    .filter(name => name.startsWith(PREFIX) && name.endsWith(SUFFIX))
    .sort()
    .reverse();

  for (const name of archives.slice(BACKUP_KEEP)) {
    fs.unlinkSync(path.join(BACKUP_DIR, name));
    console.log(`🗑️  Supprimé : ${name}`);
  }
}

async function backup() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI manquant');
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  // Horodatage UTC triable : randomizer-2026-10-07T03-00-00Z.archive.gz
  const timestamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
  const archivePath = path.join(BACKUP_DIR, `${PREFIX}${timestamp}${SUFFIX}`);
  const partialPath = `${archivePath}.partial`;

  try {
    await runMongodump(uri, partialPath);
  } catch (error) {
    fs.rmSync(partialPath, { force: true });
    throw error;
  }
  fs.renameSync(partialPath, archivePath);

  const sizeMb = (fs.statSync(archivePath).size / 1e6).toFixed(1);
  console.log(`✅ Sauvegarde : ${archivePath} (${sizeMb} Mo)`);

  rotateBackups();
}

backup().catch((error) => {
  console.error('❌ Erreur lors de la sauvegarde :', error.message);
  process.exit(1);
});
