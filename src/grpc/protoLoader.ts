import * as protoLoader from '@grpc/proto-loader';
import * as grpc from '@grpc/grpc-js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function resolveProtoPath(subPath: string): string {
  const candidates = [
    path.resolve(__dirname, '../../proto', subPath),
    path.resolve(process.cwd(), 'proto', subPath),
    path.resolve(process.cwd(), 'backend/proto', subPath),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Fallback to primary relative candidate
  return path.resolve(__dirname, '../../proto', subPath);
}

const defaultLoaderOptions: protoLoader.Options = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

export function loadProtoDefinition(subPath: string): any {
  const fullPath = resolveProtoPath(subPath);
  const packageDefinition = protoLoader.loadSync(fullPath, defaultLoaderOptions);
  return grpc.loadPackageDefinition(packageDefinition);
}
