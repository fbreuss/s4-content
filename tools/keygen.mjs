// Generates an Ed25519 key pair for signing manifests.
//   node tools/keygen.mjs [name]
// Writes keys/<name>.private.pem and keys/<name>.public.pem (keys/ is git-ignored).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const name = process.argv[2] || 'signing';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'keys');
fs.mkdirSync(dir, { recursive: true });

const privPath = path.join(dir, `${name}.private.pem`);
const pubPath = path.join(dir, `${name}.public.pem`);
if (fs.existsSync(privPath)) {
  console.error(`${privPath} already exists, refusing to overwrite.`);
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
fs.writeFileSync(privPath, privPem, { mode: 0o600 });
fs.writeFileSync(pubPath, pubPem);

console.log(`Private key -> ${privPath}`);
console.log('  Paste the full content (incl. BEGIN/END lines) into the GitHub secret SIGNING_KEY');
console.log('  and keep a backup somewhere safe (password manager, USB stick).\n');
console.log(`Public key  -> ${pubPath}  (goes into the launcher)\n`);
console.log(pubPem);
