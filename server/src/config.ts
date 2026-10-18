import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const APP_NAME = process.env.APP_NAME || 'Exam Readiness Engine';
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(here, '..', 'data'));
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const CLIENT_DIST = path.resolve(here, '..', '..', 'client', 'dist');
export const PORT = Number(process.env.PORT || 3001);
export const IS_PROD = process.env.NODE_ENV === 'production';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
