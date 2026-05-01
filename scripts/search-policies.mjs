import process from "node:process";
import { withClient } from "./lib/db.mjs";

const query = process.argv.slice(2).join(" ").trim();
const limit = Number.parseInt(process.env.SEARCH_LIMIT ?? "8", 10);

if (!query) {
  console.error("Usage: npm run search -- <query>");
  process.exit(1);
}

await withClient(async (client) => {
  const { rows } = await client.query(
    `
    with q as (
      select websearch_to_tsquery('english', $1) as tsq
    )
    select c.id as chunk_id,
           d.title,
           r.source_path,
           c.heading_path,
           c.chunk_index,
           ts_rank_cd(c.search_text, q.tsq) as lexical_score,
           left(regexp_replace(c.text, '\\s+', ' ', 'g'), 700) as snippet
    from chunks c
    join q on true
    join documents d on d.id = c.document_id
    join document_revisions r on r.id = c.document_revision_id
    where c.search_text @@ q.tsq
    order by lexical_score desc, d.title asc, c.chunk_index asc
    limit $2
    `,
    [query, limit]
  );

  console.log(JSON.stringify({ query, results: rows }, null, 2));
});
