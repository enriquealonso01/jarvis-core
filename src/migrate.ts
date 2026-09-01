import { createPool, migrate } from "./db.js";

const pool = createPool();
await migrate(pool);
await pool.end();
