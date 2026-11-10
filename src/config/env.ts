import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Authoritative Single .env Resolver for Olive Pizza Backend
const candidatePaths = [
  path.resolve(__dirname, '../../.env'), // <repo>/backend/.env
  path.resolve(process.cwd(), 'backend/.env'),
  path.resolve(process.cwd(), '.env'),
];

let loadedPath: string | null = null;
for (const p of candidatePaths) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    loadedPath = p;
    break;
  }
}

if (!loadedPath) {
  dotenv.config();
}

export const ENV_LOADED_FROM = loadedPath;
