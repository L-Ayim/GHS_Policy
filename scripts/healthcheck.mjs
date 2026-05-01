import { withClient } from "./lib/db.mjs";

await withClient(async (client) => {
  const result = await client.query("select now() as now, current_database() as database");
  console.log(JSON.stringify(result.rows[0], null, 2));
});
