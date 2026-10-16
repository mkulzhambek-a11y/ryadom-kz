// Тексты всех работающих объявлений, сгруппированные по одинаковому тексту. Только чтение.
// Открывается в браузере: https://<проект>.vercel.app/api/ad-texts?key=<REPORT_KEY>
// &format=txt — скачать одним текстовым файлом.

export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Json = Record<string, any>;

const LIVE = ["ACTIVE", "PENDING_REVIEW", "IN_PROCESS", "WITH_ISSUES"];
const isOld = (n: string) => /^\s*(AW|LID)\b/i.test(n) || /taplink|kaspi\s*magazin/i.test(n);
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// Все тексты креатива: основной текст, заголовки, описания (и все варианты в asset_feed_spec)
function textsOf(c: Json): { kind: string; text: string }[] {
  const out: { kind: string; text: string }[] = [];
  const add = (kind: string, t: unknown) => {
    if (typeof t === "string" && t.trim()) out.push({ kind, text: t.trim() });
  };
  const oss = c.object_story_spec ?? {};
  const ld = oss.link_data ?? {};
  const vd = oss.video_data ?? {};
  add("Текст", ld.message);
  add("Текст", vd.message);
  add("Текст", oss.photo_data?.caption);
  add("Заголовок", ld.name);
  add("Заголовок", vd.title);
  add("Описание", ld.description);
  add("Описание", vd.link_description);
  for (const a of ld.child_attachments ?? []) {
    add("Заголовок карточки", a.name);
    add("Описание карточки", a.description);
  }
  const afs = c.asset_feed_spec ?? {};
  for (const b of afs.bodies ?? []) add("Текст (вариант)", b.text);
  for (const t of afs.titles ?? []) add("Заголовок (вариант)", t.text);
  for (const d of afs.descriptions ?? []) add("Описание (вариант)", d.text);
  if (!out.length) add("Текст", c.body);
  // одинаковые тексты внутри одного креатива не дублируем
  return out.filter((x, i) => out.findIndex((y) => y.kind.replace(/ \(вариант\)/, "") === x.kind.replace(/ \(вариант\)/, "") && y.text === x.text) === i);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const key = process.env.REPORT_KEY;
  if (!key || url.searchParams.get("key") !== key) return new Response("Нет доступа", { status: 401 });

  const token = process.env.META_ACCESS_TOKEN || "";
  const version = process.env.META_API_VERSION || "v23.0";
  const graph = `${process.env.META_GRAPH_URL || "https://graph.facebook.com"}/${version}`;
  const raw = (process.env.META_AD_ACCOUNT_ID || "").trim();
  const account = raw.startsWith("act_") ? raw : `act_${raw}`;
  const enc = encodeURIComponent;
  const withOld = url.searchParams.get("all") === "1";

  const ads: Json[] = [];
  let error = "";
  try {
    let next: string | undefined =
      `${graph}/${account}/ads?fields=${enc(
        "id,name,effective_status,campaign{name},adset{name},creative{id,object_story_spec,asset_feed_spec,body,title,source_instagram_media_id,effective_instagram_media_id,instagram_permalink_url,call_to_action_type}",
      )}&limit=100&access_token=${enc(token)}`;
    while (next) {
      const page: Json = await fetch(next, { cache: "no-store" }).then((r) => r.json());
      if (page.error) throw new Error(page.error.error_user_msg || page.error.message);
      ads.push(...(page.data ?? []));
      next = page.paging?.next;
    }
  } catch (e) {
    error = (e as Error).message;
  }

  // текст → объявления
  const groups = new Map<string, { kind: string; text: string; ads: Json[] }>();
  const posts: Json[] = [];
  for (const ad of ads) {
    if (!LIVE.includes(ad.effective_status)) continue;
    if (!withOld && isOld(String(ad.campaign?.name ?? ""))) continue;
    const c = ad.creative ?? {};
    if (!c.object_story_spec && !c.asset_feed_spec && (c.source_instagram_media_id || c.effective_instagram_media_id)) {
      posts.push(ad);
      continue;
    }
    for (const t of textsOf(c)) {
      const k = `${t.kind}\u0000${t.text}`;
      if (!groups.has(k)) groups.set(k, { ...t, ads: [] });
      groups.get(k)!.ads.push(ad);
    }
  }
  const list = [...groups.values()].sort((a, b) => b.ads.length - a.ads.length);
  const adLabel = (a: Json) => `${a.name} (${a.campaign?.name ?? ""} / ${a.adset?.name ?? ""})`;

  if (url.searchParams.get("format") === "txt") {
    const lines: string[] = [];
    list.forEach((g, i) => {
      lines.push(`=== №${i + 1} · ${g.kind} · объявлений: ${g.ads.length} ===`, g.text, "", "Где используется:", ...g.ads.map((a) => " - " + adLabel(a)), "", "");
    });
    if (posts.length) lines.push("=== Объявления из готовых постов Instagram (текст — в самом посте) ===", ...posts.map((a) => ` - ${adLabel(a)} ${a.creative?.instagram_permalink_url ?? ""}`));
    return new Response("﻿" + lines.join("\n"), {
      headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": 'attachment; filename="kotofey-ad-texts.txt"' },
    });
  }

  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Котофей: тексты объявлений</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:24px 16px;color:#13233a;background:#fff}
.wrap{max-width:900px;margin:0 auto}h1{font-size:22px;margin:0 0 6px}p{color:#55657c;font-size:14px;margin:4px 0}
.card{border:1px solid #dfe6ef;border-radius:10px;padding:14px 16px;margin:14px 0}.k{font-size:13px;color:#2969b1;font-weight:600}
pre{white-space:pre-wrap;font:15px/1.5 system-ui,sans-serif;margin:8px 0;background:#f6f9fc;padding:10px;border-radius:6px}
details{font-size:13px;color:#55657c}.err{background:#fff3f0;border:1px solid #f3b4a8;padding:10px;border-radius:8px;color:#8a1c0b}a{color:#2969b1}</style></head>
<body><div class="wrap"><h1>Тексты объявлений</h1>
<p>Работающие объявления${withOld ? " всех кампаний" : " кампаний LEAD"}. Одинаковые тексты собраны вместе. Всего уникальных текстов: ${list.length}.</p>
<p><a href="?key=${enc(key)}&format=txt${withOld ? "&all=1" : ""}">Скачать одним файлом</a> · ${withOld ? `<a href="?key=${enc(key)}">только LEAD</a>` : `<a href="?key=${enc(key)}&all=1">включая старые кампании</a>`}</p>
${error ? `<div class="err">${esc(error)}</div>` : ""}
${list
  .map(
    (g, i) => `<div class="card"><div class="k">№${i + 1} · ${esc(g.kind)} · объявлений: ${g.ads.length}</div><pre>${esc(g.text)}</pre>
<details><summary>Где используется</summary>${g.ads.map((a) => esc(adLabel(a))).join("<br>")}</details></div>`,
  )
  .join("")}
${posts.length ? `<div class="card"><div class="k">Объявления из готовых постов Instagram — текст в самом посте, правится в Instagram</div><p>${posts.map((a) => `${esc(adLabel(a))} ${a.creative?.instagram_permalink_url ? `<a href="${esc(a.creative.instagram_permalink_url)}">пост</a>` : ""}`).join("<br>")}</p></div>` : ""}
</div></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
