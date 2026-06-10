"use client";

import { useEffect, useState } from "react";

function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/* Embeds a live Metabase question. Fetches a server-signed URL from /api/metabase/embed
 * (the secret stays on the server) and renders it in an iframe. Re-signs every 8 minutes
 * so the 10-minute token never expires on a long-open page. */
export function MetabasePanel({
  question,
  params,
  height = 600,
}: {
  question: number;
  params?: Record<string, string>;
  height?: number;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const paramsKey = params ? JSON.stringify(params) : "";

  useEffect(() => {
    let alive = true;
    const load = () => {
      const merged = { ...(params ?? {}), TZ: params?.TZ || browserTz() };
      const qs = new URLSearchParams({ question: String(question), ...merged });
      fetch(`/api/metabase/embed?${qs.toString()}`)
        .then(async (r) => {
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
          return data as { url: string };
        })
        .then((d) => {
          if (alive) {
            setUrl(d.url);
            setError(null);
          }
        })
        .catch((e) => {
          if (alive) setError(String(e?.message ?? e));
        });
    };
    load();
    const timer = setInterval(load, 8 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question, paramsKey]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-[#fecaca] bg-[#fef2f2] px-6 py-12 text-center">
        <p className="text-[13px] font-bold text-[#991b1b]">Couldn’t load live data</p>
        <p className="max-w-[480px] text-[12px] text-[#b91c1c]">{error}</p>
        <p className="mt-1 text-[11px] text-[#9ca3af]">
          Set <b>METABASE_SITE_URL</b> + <b>METABASE_SECRET_KEY</b> in <b>.env.local</b>, then restart the dev server.
        </p>
      </div>
    );
  }

  if (!url) {
    return (
      <div className="flex items-center justify-center rounded-xl bg-[#fafafa]" style={{ height }}>
        <span className="flex items-center gap-2 text-[12px] text-[#9ca3af]">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-[#d8caff] border-t-[#813fed]" />
          Loading live data…
        </span>
      </div>
    );
  }

  return (
    <iframe
      src={url}
      title={`Metabase question ${question}`}
      className="w-full rounded-xl bg-white"
      style={{ height, border: 0 }}
    />
  );
}
