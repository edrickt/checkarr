import { openDb } from "./db.js";
import { resumeInterruptedScans } from "./services/scanner.js";
import { buildApp } from "./app.js";
import { getBindHost, PORT } from "./config.js";

const db = openDb();
resumeInterruptedScans(db);
const app = await buildApp(db);
try {
  // buildApp has already resolved the bind host from the local-broadcast
  // setting (an explicit HOST env var wins over it).
  await app.listen({ port: PORT, host: getBindHost() });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
