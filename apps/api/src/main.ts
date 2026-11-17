/** [DevOps] API entry point. */
import { Logger } from '@nestjs/common';
import { createApp } from './bootstrap';
import { loadConfig } from './common/config';

async function main() {
  const cfg = loadConfig();
  const app = await createApp(cfg);
  await app.listen(cfg.PORT);
  new Logger('Main').log(`Mapema API (${cfg.APP_ENV}) listening on :${cfg.PORT}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
