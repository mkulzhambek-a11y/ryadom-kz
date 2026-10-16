import { NextResponse } from "next/server";
import { adCities } from "@/lib/store-addresses";
import { budgetPlan as plan } from "@/lib/budget-plan";
import { weatherCities, baseFor } from "@/lib/weather-budget";

// Ставит минимальный дневной расход группам приоритетных магазинов на время плана
// и снимает его после окончания. Запускается каждое утро после скрипта погоды; повторный запуск безопасен.
// Ручной запуск: Vercel → Settings → Cron Jobs → /api/budget-plan → Run.

export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Json = Record<string, any>;

const isOld = (n: string) => /^\s*(AW|LID)\b/i.test(n) || /taplink|kaspi\s*magazin/i.test(n);

function storeOf(name: string): string | undefined {
  const n = name.toLowerCase().trim();
  let best: string | undefined;
  let len = 0;
  for (const c of adCities)
    for (const s of c.stores)
      for (const key of [s.id, ...(s.aliases ?? [])])
        if (n.startsWith(key) && key.length > len) {
          best = s.id;
          len = key.length;
        }
  return best;
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const token = process.env.META_ACCESS_TOKEN || "";
  const version = process.env.META_API_VERSION || "v23.0";
  const graph = `${process.env.META_GRAPH_URL || "https://graph.facebook.com"}/${version}`;
  const offset = Number(process.env.META_CURRENCY_OFFSET || 100);
  const raw = (process.env.META_AD_ACCOUNT_ID || "").trim();
  const account = raw.startsWith("act_") ? raw : `act_${raw}`;
  const enc = encodeURIComponent;
  const finish = (body: Json, status = 200) => {
    console.log(JSON.stringify(body));
    return NextResponse.json(body, { status });
  };
  if (!token || !raw) return finish({ error: "нет META_ACCESS_TOKEN или META_AD_ACCOUNT_ID" }, 500);

  const today = process.env.BUDGET_PLAN_TODAY || new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
  const daysAfterEnd = (Date.parse(today) - Date.parse(plan.to)) / 86400000;
  let mode: "set" | "clear" | "none";
  if (today < plan.from) mode = "none";
  else if (today <= plan.to) mode = "set";
  else if (daysAfterEnd <= 7) mode = "clear";
  else mode = "none";
  if (mode === "none") {
    return finish({ today, plan: `${plan.from}…${plan.to}`, action: today < plan.from ? `план начнётся ${plan.from}, сейчас ничего не меняю` : "план давно закончился, ничего не меняю" });
  }

  const get = async (u: string): Promise<Json> => {
    const d = await fetch(u, { cache: "no-store" }).then((r) => r.json());
    if (d.error) throw new Error(d.error.error_user_msg || d.error.message);
    return d;
  };
  const getAll = async (u: string) => {
    const out: Json[] = [];
    let next: string | undefined = u;
    while (next) {
      const p: Json = await get(next);
      out.push(...(p.data ?? []));
      next = p.paging?.next;
    }
    return out;
  };
  const post = async (id: string, params: Record<string, string>) => {
    const body = new URLSearchParams({ ...params, access_token: token });
    const d = await fetch(`${graph}/${id}`, { method: "POST", body }).then((r) => r.json());
    if (d.error) throw new Error(d.error.error_user_msg || d.error.message);
    return d;
  };

  const report: Json[] = [];
  try {
    // Группы приоритетных магазинов в активных кампаниях LEAD
    const sets = await getAll(
      `${graph}/${account}/adsets?fields=${enc("id,name,effective_status,daily_min_spend_target,campaign{id,name}")}&limit=200&access_token=${enc(token)}`,
    );
    const wanted = new Map(plan.stores.map((s) => [s.store, s]));
    const targets = sets.filter((s) => !isOld(String(s.campaign?.name ?? "")) && wanted.has(storeOf(String(s.name)) ?? "") && s.effective_status === "ACTIVE");

    // Средний расход за базовую неделю
    const baseDays = (Date.parse(plan.baselineTo) - Date.parse(plan.baselineFrom)) / 86400000 + 1;
    const ins = await getAll(
      `${graph}/${account}/insights?level=adset&fields=${enc("adset_id,spend")}&time_range=${enc(JSON.stringify({ since: plan.baselineFrom, until: plan.baselineTo }))}&limit=500&access_token=${enc(token)}`,
    );
    const avg = new Map(ins.map((r) => [String(r.adset_id), Number(r.spend ?? 0) / baseDays]));

    // Бюджет кампании на сегодня — из настроек погоды
    const campBase = new Map<string, number>();
    for (const c of weatherCities) for (const t of c.campaigns) campBase.set(t.id, baseFor(t, today).base);

    // Желаемые минимумы, с ограничением по доле бюджета кампании
    const byCamp = new Map<string, { set: Json; want: number; avg: number; extra: number; note: string }[]>();
    for (const s of targets) {
      const st = wanted.get(storeOf(String(s.name))!)!;
      const a = avg.get(String(s.id)) ?? 0;
      const list = byCamp.get(s.campaign.id) ?? [];
      list.push({ set: s, want: st.minUsd ?? a + (st.extraUsd ?? 0), avg: a, extra: st.extraUsd ?? 0, note: st.note });
      byCamp.set(s.campaign.id, list);
    }

    for (const [campId, list] of byCamp) {
      const budget = campBase.get(campId);
      const sum = list.reduce((x, i) => x + i.want, 0);
      const limit = budget ? budget * plan.maxShareOfCampaign : Infinity;
      const k = sum > limit ? limit / sum : 1;
      for (const i of list) {
        const row: Json = {
          campaign: i.set.campaign.name,
          adSet: i.set.name,
          adSetId: i.set.id,
          store: i.note,
          campaignBudget: budget,
          baselineAvgPerDay: Math.round(i.avg * 100) / 100,
          extra: i.extra,
        };
        const current = Number(i.set.daily_min_spend_target ?? 0);
        try {
          if (mode === "set") {
            const minUsd = Math.round(i.want * k);
            const minor = String(minUsd * offset);
            row.minSpendPerDay = minUsd;
            if (k < 1) row.warning = `сумма минимумов урезана до ${Math.round(plan.maxShareOfCampaign * 100)}% бюджета кампании`;
            if (String(current) === minor) row.action = "без изменений";
            else {
              await post(i.set.id, { daily_min_spend_target: minor });
              row.action = "минимум расхода установлен";
            }
          } else {
            if (!current) row.action = "минимума нет — ничего не делаю";
            else {
              await post(i.set.id, { daily_min_spend_target: "0" });
              row.action = "план закончился — минимум снят";
            }
          }
        } catch (e) {
          row.error = (e as Error).message;
        }
        report.push(row);
      }
    }
    const found = new Set(targets.map((s) => storeOf(String(s.name))));
    for (const s of plan.stores) if (!found.has(s.store)) report.push({ store: s.note, warning: "не нашёл активную группу этого магазина в кампаниях LEAD (название группы должно начинаться с " + s.store + ")" });
  } catch (e) {
    return finish({ today, mode, error: (e as Error).message, report }, 500);
  }
  return finish({ today, mode, plan: `${plan.from}…${plan.to}`, report });
}
