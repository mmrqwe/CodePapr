import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const loaderPath = path.resolve(__dirname, './resolve-extension-loader.mjs');

register(pathToFileURL(loaderPath).href, pathToFileURL('./'));
