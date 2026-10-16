import { weakRules, creativeOf } from "@/lib/pause-weak";

// Ставит на паузу слабые объявления по списку из lib/pause-weak.ts.
// Открыть: https://<проект>.vercel.app/api/pause-weak?key=<REPORT_KEY>
//   — сначала предпросмотр, кнопка «Выключить» ставит на паузу.
// В каждой группе обязательно остаётся хотя бы одно работающее объявление.

export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Json = Record<string, any>;
const ON = ["ACTIVE", "PENDING_REVIEW", "IN_PROCESS", "WITH_ISSUES"];
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const key = process.env.REPORT_KEY;
  if (!key || url.searchParams.get("key") !== key) return new Response("Нет доступа", { status: 401 });
  const apply = url.searchParams.get("apply") === "1";
  const token = process.env.META_ACCESS_TOKEN || "";
  const graph = `${process.env.META_GRAPH_URL || "https://graph.facebook.com"}/${process.env.META_API_VERSION || "v23.0"}`;
  const raw = (process.env.META_AD_ACCOUNT_ID || "").trim();
  const account = raw.startsWith("act_") ? raw : `act_${raw}`;
  const enc = encodeURIComponent;

  const rows: Json[] = [];
  let error = "";
  let paused = 0;
  try {
    const ads: Json[] = [];
    let next: string | undefined = `${graph}/${account}/ads?fields=${enc("id,name,effective_status,adset_id,adset{name},campaign{name}")}&limit=200&access_token=${enc(token)}`;
    while (next) {
      const p: Json = await fetch(next, { cache: "no-store" }).then((r) => r.json());
      if (p.error) throw new Error(p.error.error_user_msg || p.error.message);
      ads.push(...(p.data ?? []));
      next = p.paging?.next;
    }
    // сколько работающих объявлений в каждой группе
    const liveInSet = new Map<string, number>();
    for (const a of ads) if (ON.includes(a.effective_status)) liveInSet.set(a.adset_id, (liveInSet.get(a.adset_id) ?? 0) + 1);

    for (const a of ads) {
      if (!ON.includes(a.effective_status)) continue;
      const camp = String(a.campaign?.name ?? "");
      const cr = creativeOf(String(a.name));
      const rule = weakRules.find((r) => camp.toUpperCase().startsWith(r.campaign.toUpperCase()) && r.creative === cr);
      if (!rule) continue;
      const row: Json = { ad: a.name, adSet: a.adset?.name, campaign: camp, why: rule.why };
      if ((liveInSet.get(a.adset_id) ?? 0) <= 1) {
        row.action = "оставлено: это последнее работающее объявление в группе";
        rows.push(row);
        continue;
      }
      if (apply) {
        try {
          const body = new URLSearchParams({ status: "PAUSED", access_token: token });
          const d = await fetch(`${graph}/${a.id}`, { method: "POST", body }).then((r) => r.json());
          if (d.error) throw new Error(d.error.error_user_msg || d.error.message);
          liveInSet.set(a.adset_id, (liveInSet.get(a.adset_id) ?? 1) - 1);
          paused++;
          row.action = "выключено";
        } catch (e) {
          row.error = (e as Error).message;
        }
      } else {
        liveInSet.set(a.adset_id, (liveInSet.get(a.adset_id) ?? 1) - 1);
        row.action = "будет выключено";
      }
      rows.push(row);
    }
  } catch (e) {
    error = (e as Error).message;
  }
  console.log(JSON.stringify({ apply, paused, rows, error }));

  const toPause = rows.filter((r) => r.action === "будет выключено").length;
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Котофей: слабые объявления</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:24px 16px;color:#13233a;background:#fff}.wrap{max-width:1000px;margin:0 auto}h1{font-size:22px;margin:0 0 8px}p{color:#55657c;font-size:14px}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #e3e9f1;vertical-align:top}thead th{background:#e8f1fb}
.btn{display:inline-block;background:#12305a;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600}.err{color:#8a1c0b}</style></head>
<body><div class="wrap"><h1>Выключение слабых объявлений</h1>
${error ? `<p class="err">${esc(error)}</p>` : ""}
${apply ? `<p>Выключено: <b>${paused}</b>.</p>` : toPause ? `<p>Это предпросмотр, ничего не изменено. Будет выключено: <b>${toPause}</b>.</p><p><a class="btn" href="?key=${enc(key)}&apply=1">Выключить</a></p>` : `<p><b>Подходящих работающих объявлений нет — всё уже выключено.</b></p>`}
<table><thead><tr><th>Объявление</th><th>Группа</th><th>Почему</th><th>Действие</th></tr></thead><tbody>
${rows.map((r) => `<tr><td>${esc(r.ad)}</td><td>${esc(r.adSet)}</td><td>${esc(r.why)}</td><td>${r.error ? `<span class="err">${esc(r.error)}</span>` : esc(r.action)}</td></tr>`).join("")}
</tbody></table></div></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
