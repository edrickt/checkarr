import { openDb } from "./db.js";
import { resumeInterruptedScans } from "./services/scanner.js";
import { buildApp } from "./app.js";
import { HOST, PORT } from "./config.js";

const db = openDb();
resumeInterruptedScans(db);
const app = await buildApp(db);
try {
  await app.listen({ port: PORT, host: HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
