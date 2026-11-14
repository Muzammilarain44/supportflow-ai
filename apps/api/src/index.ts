import { loadEnv } from './env.js';
import { createApp } from './app.js';
import { logger } from './logger.js';

const env = loadEnv(); // fails fast with a clear message if required vars are missing
const app = createApp(env);
app.listen(env.PORT, () => logger.info(`SupportFlow API listening on port ${env.PORT}`));
