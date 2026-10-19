import { registerHooks } from 'node:module';
import { createSourceResolver } from './source-resolution.mjs';

registerHooks({ resolve: createSourceResolver() });
