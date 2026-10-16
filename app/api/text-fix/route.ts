import { fixText, isKzAd } from "@/lib/text-fix";

// Исправляет тексты работающих объявлений кампаний LEAD (правила — в lib/text-fix.ts).
// Открыть в браузере: https://<проект>.vercel.app/api/text-fix?key=<REPORT_KEY>
//   — сначала показывает, что поменяется, ничего не меняя;
//   — кнопка «Применить» создаёт креативы с новым текстом и ставит их в объявления.
// Повторный запуск безопасен: уже исправленные объявления пропускаются.

export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Json = Record<string, any>;

const LIVE = ["ACTIVE", "PENDING_REVIEW", "IN_PROCESS", "WITH_ISSUES"];
const TIME_BUDGET_MS = 40_000;
const STANDARD_PARTS = ["image_touchups", "image_brightness_and_contrast", "image_templates", "text_optimizations", "inline_comment", "enhance_cta"];
const isOld = (n: string) => /^\s*(AW|LID)\b/i.test(n) || /taplink|kaspi\s*magazin/i.test(n);
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// Применяет fixText ко всем текстам креатива; возвращает копию и признак изменений
function rewrite(c: Json, kzFirst: boolean): { oss?: Json; afs?: Json; changed: boolean; before: string; after: string } {
  let changed = false;
  let before = "";
  let after = "";
  const f = (t: unknown) => {
    if (typeof t !== "string" || !t.trim()) return t;
    const n = fixText(t, kzFirst);
    if (n !== t) {
      changed = true;
      if (!before) {
        before = t;
        after = n;
      }
    }
    return n;
  };
  const oss = c.object_story_spec ? JSON.parse(JSON.stringify(c.object_story_spec)) : undefined;
  if (oss?.link_data) oss.link_data.message = f(oss.link_data.message);
  if (oss?.video_data) oss.video_data.message = f(oss.video_data.message);
  if (oss?.photo_data) oss.photo_data.caption = f(oss.photo_data.caption);
  const afs = c.asset_feed_spec ? JSON.parse(JSON.stringify(c.asset_feed_spec)) : undefined;
  for (const b of afs?.bodies ?? []) b.text = f(b.text);
  return { oss, afs, changed, before, after };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const key = process.env.REPORT_KEY;
  if (!key || url.searchParams.get("key") !== key) return new Response("Нет доступа", { status: 401 });
  const apply = url.searchParams.get("apply") === "1";

  const token = process.env.META_ACCESS_TOKEN || "";
  const version = process.env.META_API_VERSION || "v23.0";
  const graph = `${process.env.META_GRAPH_URL || "https://graph.facebook.com"}/${version}`;
  const raw = (process.env.META_AD_ACCOUNT_ID || "").trim();
  const account = raw.startsWith("act_") ? raw : `act_${raw}`;
  const enc = encodeURIComponent;
  const post = async (path: string, params: Json) => {
    const body = new URLSearchParams({ access_token: token });
    for (const [k, v] of Object.entries(params)) body.set(k, typeof v === "string" ? v : JSON.stringify(v));
    const d = await fetch(`${graph}/${path}`, { method: "POST", body }).then((r) => r.json());
    if (d.error) throw new Error(d.error.error_user_msg || d.error.message);
    return d;
  };

  const started = Date.now();
  const rows: Json[] = [];
  const samples = new Map<string, { before: string; after: string; ads: string[] }>();
  const sum = { checked: 0, toFix: 0, fixed: 0, ok: 0, errors: 0, remaining: 0 };
  let error = "";

  try {
    const ads: Json[] = [];
    let next: string | undefined =
      `${graph}/${account}/ads?fields=${enc("id,name,effective_status,campaign{name},creative{id,name,object_story_spec,asset_feed_spec,degrees_of_freedom_spec,url_tags}")}&limit=100&access_token=${enc(token)}`;
    while (next) {
      const p: Json = await fetch(next, { cache: "no-store" }).then((r) => r.json());
      if (p.error) throw new Error(p.error.error_user_msg || p.error.message);
      ads.push(...(p.data ?? []));
      next = p.paging?.next;
    }
    const made = new Map<string, string>(); // старый креатив + порядок → новый креатив
    for (const ad of ads) {
      if (!LIVE.includes(ad.effective_status) || isOld(String(ad.campaign?.name ?? ""))) continue;
      const c = ad.creative ?? {};
      if (!c.object_story_spec && !c.asset_feed_spec) continue; // готовые посты Instagram не трогаем
      sum.checked++;
      const kzFirst = isKzAd(String(ad.name));
      const r = rewrite(c, kzFirst);
      if (!r.changed) {
        sum.ok++;
        continue;
      }
      sum.toFix++;
      const sk = r.before + "\u0000" + kzFirst;
      if (!samples.has(sk)) samples.set(sk, { before: r.before, after: r.after, ads: [] });
      samples.get(sk)!.ads.push(ad.name);
      if (!apply) continue;
      if (Date.now() - started > TIME_BUDGET_MS) {
        sum.remaining++;
        continue;
      }
      try {
        const mk = `${c.id}|${kzFirst}`;
        let newId = made.get(mk);
        if (!newId) {
          const copy: Json = { name: `${String(c.name ?? ad.name).slice(0, 200)} · текст ${new Date().toISOString().slice(0, 10)}` };
          if (r.oss) {
            if (r.oss.link_data?.image_hash) delete r.oss.link_data.picture;
            if (r.oss.video_data?.image_hash) delete r.oss.video_data.image_url;
            if (r.oss.photo_data?.image_hash) delete r.oss.photo_data.url;
            for (const a of r.oss.link_data?.child_attachments ?? []) if (a?.image_hash) delete a.picture;
            copy.object_story_spec = r.oss;
          }
          if (r.afs) {
            for (const i of r.afs.images ?? []) if (i?.hash) delete i.url;
            for (const v of r.afs.videos ?? []) if (v?.thumbnail_hash) delete v.thumbnail_url;
            copy.asset_feed_spec = r.afs;
          }
          if (c.url_tags) copy.url_tags = c.url_tags;
          const feats: Json = {};
          for (const [k, v] of Object.entries<Json>(c.degrees_of_freedom_spec?.creative_features_spec ?? {})) {
            if (k === "standard_enhancements") STANDARD_PARTS.forEach((p) => (feats[p] = { enroll_status: "OPT_OUT" }));
            else if (v?.enroll_status) feats[k] = { enroll_status: "OPT_OUT" };
          }
          if (Object.keys(feats).length) copy.degrees_of_freedom_spec = { creative_features_spec: feats };
          copy.contextual_multi_ads = { enroll_status: "OPT_OUT" };
          newId = String((await post(`${account}/adcreatives`, copy)).id);
          made.set(mk, newId);
        }
        await post(ad.id, { creative: { creative_id: newId } });
        sum.fixed++;
        rows.push({ ad: ad.name, action: "текст исправлен" });
      } catch (e) {
        sum.errors++;
        rows.push({ ad: ad.name, error: (e as Error).message });
      }
    }
  } catch (e) {
    error = (e as Error).message;
  }
  console.log(JSON.stringify({ apply, sum, rows, error }));

  const link = (extra = "") => `?key=${enc(key)}${extra}`;
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Котофей: исправление текстов</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:24px 16px;color:#13233a;background:#fff}.wrap{max-width:1100px;margin:0 auto}
h1{font-size:22px;margin:0 0 8px}p{color:#55657c;font-size:14px;margin:6px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:700px){.grid{grid-template-columns:1fr}}pre{white-space:pre-wrap;font:14px/1.45 system-ui,sans-serif;margin:0;padding:10px;border-radius:6px}
.b{background:#fff3f0}.a{background:#eefaf1}.card{border:1px solid #dfe6ef;border-radius:10px;padding:14px;margin:14px 0}.k{font-size:13px;font-weight:600;color:#2969b1;margin-bottom:8px}
.btn{display:inline-block;background:#12305a;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600}.err{background:#fff3f0;border:1px solid #f3b4a8;padding:10px;border-radius:8px;color:#8a1c0b}</style></head>
<body><div class="wrap"><h1>Исправление текстов объявлений</h1>
${error ? `<div class="err">${esc(error)}</div>` : ""}
<p>Проверено объявлений: ${sum.checked}. Уже в порядке: ${sum.ok}. ${apply ? `Исправлено: ${sum.fixed}. Ошибок: ${sum.errors}.` : `Нужно исправить: ${sum.toFix}.`}</p>
${apply && sum.remaining ? `<p><b>Не успел ещё ${sum.remaining} — обновите страницу, чтобы продолжить.</b></p>` : ""}
${!apply && sum.toFix ? `<p>Это предпросмотр, в кабинете пока ничего не изменилось.</p><p><a class="btn" href="${link("&apply=1")}">Применить исправления</a></p>` : ""}
${!sum.toFix && !error ? `<p><b>Все тексты уже исправлены.</b></p>` : ""}
${rows.filter((r) => r.error).map((r) => `<div class="err">${esc(r.ad)}: ${esc(r.error)}</div>`).join("")}
${[...samples.values()]
  .map(
    (s) => `<div class="card"><div class="k">Объявлений: ${s.ads.length} — ${esc(s.ads.slice(0, 4).join(", "))}${s.ads.length > 4 ? " …" : ""}</div>
<div class="grid"><div><p>Было</p><pre class="b">${esc(s.before)}</pre></div><div><p>Станет</p><pre class="a">${esc(s.after)}</pre></div></div></div>`,
  )
  .join("")}
</div></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
