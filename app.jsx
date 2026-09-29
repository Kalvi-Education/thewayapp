// Ask The Way: describe a real situation, get an answer grounded in the 94 active
// pages of The Kalvium Way, with every page one click away.
//
// Two stages, both in the browser via the public, origin-limited inference endpoint:
//   1. clarity gate: the whole conversation plus title/one-line/phase metadata for
//      the 94 active ways. The model returns JSON saying whether it can answer yet and
//      which slugs are relevant.
//   2. answer: only when stage 1 says the situation is clear. The Markdown of the
//      chosen pages is fetched, frontmatter stripped, and the answer is grounded in
//      those pages alone.
//
// Only the public active pages leave the browser. Chat history remains in the tab.
//
// Routes: #/ landing · #/ask chat · #/way/<slug> opens the page drawer over either.

import React, { useState, useEffect, useMemo, useRef, useCallback, useId } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ mangle: false, headerIds: false });

// ---------- pure helpers (region: pure) ----------
// test.mjs evaluates everything between these markers, so keep it free of JSX,
// imports and browser globals.

const MODEL = "openai-codex/gpt-6-luna";
const INFERENCE_ENDPOINT = "https://keyproxy-hjxpr2mqoa-el.a.run.app/v1/chat/completions";
// Public browser key, restricted and budgeted upstream. Never treat it as a secret.
const PUBLIC_KEY = "sk-kp-public-lmtSEzAQHukVrS8qetOdGMTVUZShR1BG";
const REGISTRY_URL = "book/registry.json";

// A way ships only if it is active and has a page file.
function activeWays(registry) {
  if (!registry || !Array.isArray(registry.ways)) return [];
  return registry.ways.filter((w) => !w.disposition && !!w.file);
}

// The compact public catalogue is the only registry data the model sees.
function catalogueFor(ways) {
  return ways.map((w) => ({
    slug: w.slug,
    title: w.displayTitle || w.title,
    way: w.way || "",
    phase: w.phase,
  }));
}

function catalogueLines(catalogue) {
  return catalogue.map((c) => `${c.slug} | ${c.title}`).join("\n");
}

// FNV-1a. Same slug, same art, on every machine and every reload.
function hashSlug(slug) {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Four predictable picks per UTC day. Scoring every slug with the date gives us a
// stable daily sample without storing state or depending on the visitor's timezone.
function dailyWays(ways, dateKey, count = 4) {
  return [...ways]
    .sort((a, b) => {
      const delta = hashSlug(`${dateKey}:${a.slug}`) - hashSlug(`${dateKey}:${b.slug}`);
      return delta || a.slug.localeCompare(b.slug);
    })
    .slice(0, count);
}

// Deterministic pastel art: two hues, a sweep angle, three soft blobs.
function artFor(slug) {
  const h = hashSlug(slug);
  const pick = (shift, mod) => (h >>> shift) % mod;
  const hueA = h % 360;
  const hueB = (hueA + 40 + pick(7, 120)) % 360;
  const angle = pick(11, 180);
  const blobs = [0, 1, 2].map((i) => ({
    cx: 12 + ((h >>> (i * 5 + 3)) % 78),
    cy: 12 + ((h >>> (i * 7 + 5)) % 78),
    r: 16 + ((h >>> (i * 3 + 9)) % 26),
    hue: (hueA + 60 * (i + 1) + pick(i + 13, 90)) % 360,
    opacity: 0.28 + ((h >>> (i * 4 + 2)) % 18) / 100,
  }));
  return {
    angle,
    from: `hsl(${hueA} 45% 90%)`,
    to: `hsl(${hueB} 40% 82%)`,
    blobs: blobs.map((b) => ({ ...b, fill: `hsl(${b.hue} 50% 86%)` })),
  };
}

function stripFrontmatter(text) {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(text || "");
  return m ? text.slice(m[0].length) : text || "";
}

// The drawer supplies the page title in its fixed header. Remove the same H1
// from the Markdown body so the document has one title and keeps every other line.
function stripLeadingTitle(text) {
  return String(text || "").replace(/^\s*#\s+[^\n]+\n+/, "");
}

// Hash routing. #/ landing · #/ask chat · #/way/<slug> drawer over either.
function routeFrom(hash) {
  const raw = String(hash || "").replace(/^#\/?/, "");
  let parts;
  try {
    parts = raw.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return { view: "landing", slug: null };
  }
  if (parts[0] === "way" && parts[1]) return { view: "way", slug: parts[1] };
  if (parts[0] === "ask") return { view: "ask", slug: null };
  return { view: "landing", slug: null };
}

function hashFor(view, slug) {
  if (view === "way") return `#/way/${encodeURIComponent(slug)}`;
  return view === "ask" ? "#/ask" : "#/";
}

// Models sometimes wrap JSON in a code fence even when asked not to.
function parseJsonReply(raw) {
  const text = String(raw || "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  const body = fenced ? fenced[1] : text;
  try {
    return JSON.parse(body);
  } catch {
    const first = body.indexOf("{");
    const last = body.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(body.slice(first, last + 1));
    throw new Error("The model replied with something other than JSON.");
  }
}

// The clarity gate. Stage 2 runs only when the model says the situation is clear
// and at least one returned slug is a real active way.
function resolveStage(triage, allowedSlugs) {
  const allowed = allowedSlugs instanceof Set ? allowedSlugs : new Set(allowedSlugs || []);
  const rawQuestions = Array.isArray(triage && triage.questions) ? triage.questions : [];
  const questions = rawQuestions
    .filter((q) => typeof q === "string" && q.trim())
    .map((q) => q.trim())
    .slice(0, 1);
  const slugs = (Array.isArray(triage && triage.slugs) ? triage.slugs : [])
    .filter((s) => typeof s === "string" && allowed.has(s))
    .slice(0, 3);

  const clear = triage && triage.contextIsClear === true;
  if (!clear) {
    return questions.length
      ? { mode: "clarify", questions, slugs: [] }
      : {
          mode: "clarify",
          questions: ["What part of the situation would you like help with?"],
          slugs: [],
        };
  }
  if (!slugs.length) return { mode: "nomatch", questions: [], slugs: [] };
  return { mode: "answer", questions: [], slugs };
}

function clarifySystemPrompt(catalogue) {
  return [
    "You are kalvium's handbook assistant. Route the conversation to The Kalvium Way pages.",
    "Answer when you can give useful advice from the book. Do not ask for details that would only make the answer more specific. If a missing fact would materially change the advice, ask ONE plain, natural question; do not answer yet. Never ask for something already said in the chat.",
    "If clear, choose one to three relevant slugs, most relevant first, and no questions. Copy slugs exactly. If nothing applies, return no slugs. If clarification is needed, return exactly one question and no slugs. No suggested answers or defaults.",
    "Catalogue (slug | title):",
    catalogueLines(catalogue),
  ].join("\n");
}

function answerSystemPrompt() {
  return [
    "You are kalvium's handbook assistant. Speak to a Kalvium colleague like a senior mentor, using only the supplied pages of The Kalvium Way for facts and advice.",
    "Respond to the latest message in the context of the whole chat. Give the first useful action and a concrete reason. Say plainly when the pages cannot establish something. Do not invent facts, processes, comparisons or policy.",
    "Write two or three short conversational paragraphs in plain active language. No headings, page-title openings, source-by-source summary, slogans, aphorisms, jargon, formal conclusions or AI-report phrases. The UI displays the pages separately, so do not list them. Keep the reply brief, usually under 120 words.",
    "End EVERY answer with exactly one short, natural follow-up question that helps you give the next useful step. Base it on this chat; never repeat a question the reader has already answered. Put the question at the end of the last paragraph. No text after it.",
  ].join("\n");
}

const CLARIFY_FORMAT = "Return only a JSON object with contextIsClear (boolean), questions (array of strings), and slugs (array of strings). No Markdown fences.";


// ---------- end pure helpers (region: pure) ----------

// ---------- model calls ----------

async function callModel({ system, messages, json, signal }) {
  let res;
  try {
    res = await fetch(INFERENCE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${PUBLIC_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        reasoning_effort: "medium",
        messages: [
          { role: "system", content: json ? `${system}\n\n${CLARIFY_FORMAT}` : system },
          ...messages,
        ],
      }),
      signal,
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new Error("The inference request did not go through. Check your connection.");
  }
  if (!res.ok) {
    if (res.status === 429) throw new Error("The service is busy or its limit was reached. Try again later.");
    if (res.status === 401 || res.status === 403 || res.status === 404)
      throw new Error("The inference service denied this request. Use the public site or check its access policy.");
    throw new Error(`The inference service returned an error (${res.status}).`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim())
    throw new Error("The model returned an empty answer. Send it again.");
  return text.trim();
}

function turnsToMessages(messages) {
  return messages
    .filter((m) => m.text && (m.role === "user" || m.kind === "answer" || m.kind === "clarify"))
    .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.text }));
}

// ---------- small shared pieces ----------

function Markdown({ text, className = "" }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text || ""), { USE_PROFILES: { html: true } }),
    [text],
  );
  return (
    <article
      className={`prose max-w-none ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function WayArt({ slug, className = "" }) {
  const art = useMemo(() => artFor(slug), [slug]);
  const instance = useId().replace(/:/g, "");
  const id = `art-${slug}-${instance}`;
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <defs>
        <linearGradient id={`${id}-g`} gradientTransform={`rotate(${art.angle} 0.5 0.5)`}>
          <stop offset="0%" stopColor={art.from} />
          <stop offset="100%" stopColor={art.to} />
        </linearGradient>
        <filter id={`${id}-b`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
      </defs>
      <rect width="100" height="100" fill={`url(#${id}-g)`} />
      <g filter={`url(#${id}-b)`}>
        {art.blobs.map((b, i) => (
          <circle key={i} cx={b.cx} cy={b.cy} r={b.r} fill={b.fill} opacity={b.opacity} />
        ))}
      </g>
    </svg>
  );
}

function WayCard({ way, onOpen, compact = false }) {
  const open = (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onOpen(way.slug);
  };

  if (compact) {
    return (
      <a
        href={hashFor("way", way.slug)}
        onClick={open}
        className="group ui-border flex min-h-11 items-stretch overflow-hidden rounded-lg border bg-base-100 hover:border-base-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary transition"
      >
        <div className="w-1.5 shrink-0 overflow-hidden">
          <WayArt slug={way.slug} className="h-full w-full" />
        </div>
        <span className="font-display text-sm font-medium leading-snug px-3 py-2.5">
          {way.displayTitle || way.title}
        </span>
      </a>
    );
  }

  return (
    <a
      href={hashFor("way", way.slug)}
      onClick={open}
      className="tile group ui-border block h-full min-h-24 overflow-hidden rounded-lg border bg-base-100 hover:border-base-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary transition"
    >
      <div className="h-2 overflow-hidden">
        <WayArt slug={way.slug} className="h-full w-full" />
      </div>
      <div className="p-3">
        <h3 className="font-display text-sm font-medium leading-snug">
          {way.displayTitle || way.title}
        </h3>
      </div>
    </a>
  );
}

// ---------- way drawer ----------

function WayDrawer({ way, onClose }) {
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  const [state, setState] = useState({ body: null, err: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setState({ body: null, err: null });
    fetch(way.file)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.text();
      })
      .then(
        (t) =>
          live && setState({ body: stripLeadingTitle(stripFrontmatter(t)), err: null }),
      )
      .catch(() =>
        live &&
        setState({ body: null, err: "This page did not load. The file may have moved." }),
      );
    return () => {
      live = false;
    };
  }, [way.slug, way.file, attempt]);

  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current && closeRef.current.focus();
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      if (previous && previous.focus) previous.focus();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="absolute inset-0 bg-base-content/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        className="drawer-panel relative h-full w-full sm:w-[34rem] lg:w-[40rem] bg-base-100 shadow-2xl flex flex-col"
      >
        <div className="ui-border shrink-0 border-b">
          <div className="h-3 overflow-hidden">
            <WayArt slug={way.slug} className="w-full h-full" />
          </div>
          <div className="p-5 pb-4 flex items-start gap-4">
            <div className="min-w-0">
              <div className="secondary-text text-[11px] uppercase tracking-wide mb-1">
                Phase {way.phase}
              </div>
              <h1 id="drawer-title" className="font-display text-2xl font-semibold leading-tight">
                {way.displayTitle || way.title}
              </h1>
            </div>
            <button
              ref={closeRef}
              onClick={onClose}
              className="btn btn-sm btn-ghost btn-circle ml-auto shrink-0"
              aria-label="Close this page"
            >
              ✕
            </button>
          </div>
        </div>
        <div
          className="flex-1 overflow-y-auto p-5 pt-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-primary"
          tabIndex="0"
          aria-label={`Read ${way.displayTitle || way.title}`}
        >
          {way.way && (
            <p className="secondary-text accent-border font-display text-lg italic mb-6 border-l-4 pl-4 leading-snug">
              {way.way}
            </p>
          )}
          {state.err && (
            <div className="alert alert-error">
              <span>{state.err}</span>
              <button className="btn btn-sm" onClick={() => setAttempt((a) => a + 1)}>
                Try again
              </button>
            </div>
          )}
          {state.body === null && !state.err && (
            <div className="space-y-3" aria-busy="true" aria-label="Loading this page">
              <div className="skeleton h-4 w-3/4" />
              <div className="skeleton h-4 w-full" />
              <div className="skeleton h-4 w-5/6" />
              <div className="skeleton h-4 w-2/3" />
            </div>
          )}
          {state.body !== null && <Markdown text={state.body} />}
        </div>
      </div>
    </div>
  );
}

// ---------- composer ----------

function Composer({ value, setValue, onSubmit, busy, inputRef }) {
  useEffect(() => {
    if (!value && inputRef && inputRef.current) {
      inputRef.current.style.height = "";
      inputRef.current.style.overflowY = "hidden";
    }
  }, [value, inputRef]);

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSubmit();
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="ui-border flex min-h-14 items-end gap-2 bg-base-100 border rounded-[1.75rem] shadow-sm focus-within:border-base-content focus-within:shadow-md transition p-2"
    >
      <label className="sr-only" htmlFor="situation">
        Ask your query
      </label>
      <textarea
        id="situation"
        ref={inputRef}
        rows={1}
        value={value}
        onChange={(e) => {
          const el = e.currentTarget;
          setValue(el.value);
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
          el.style.overflowY = el.scrollHeight > 160 ? "auto" : "hidden";
        }}
        onKeyDown={onKeyDown}
        placeholder="Ask your query"
        className="query-input flex-1 bg-transparent resize-none outline-none px-3 py-2 max-h-40 text-base"
      />
      {(busy || value.trim()) && (
        <button
          type="submit"
          className="btn btn-neutral btn-circle btn-sm shrink-0 mb-0.5"
          disabled={busy || !value.trim()}
          aria-label="Ask"
        >
          {busy ? <span className="loading loading-spinner loading-xs" /> : "↑"}
        </button>
      )}
    </form>
  );
}

// ---------- landing ----------

function Landing({ ways, onOpen, onAsk, draft, setDraft, busy, inputRef }) {
  const [showAll, setShowAll] = useState(false);
  const dayKey = new Date().toISOString().slice(0, 10);
  const orderedWays = useMemo(() => {
    const featured = dailyWays(ways, dayKey);
    const featuredSlugs = new Set(featured.map((way) => way.slug));
    return [...featured, ...ways.filter((way) => !featuredSlugs.has(way.slug))];
  }, [ways, dayKey]);
  const visibleWays = showAll ? orderedWays : orderedWays.slice(0, 4);

  return (
    <div className="relative min-h-screen bg-base-100 px-4 sm:px-6">
      <section className="mx-auto max-w-2xl pt-20 text-center sm:pt-[20vh]">
        <h1 className="font-display text-4xl font-semibold lowercase tracking-tight sm:text-5xl">
          ask <span className="wordmark-accent">the way</span>
        </h1>
        <div className="mt-8 text-left">
          <Composer
            value={draft}
            setValue={setDraft}
            onSubmit={onAsk}
            busy={busy}
            inputRef={inputRef}
          />
        </div>
      </section>

      <section aria-labelledby="explore-ways" className="mx-auto mt-10 max-w-5xl pb-24">
        <div className="mx-auto mb-8 flex max-w-xs items-center gap-4">
          <span className="ui-divider h-px flex-1" />
          <h2 id="explore-ways" className="quiet-label text-xs font-normal lowercase">
            or explore
          </h2>
          <span className="ui-divider h-px flex-1" />
        </div>
        <div id="way-grid" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {visibleWays.map((way) => (
            <WayCard key={way.slug} way={way} onOpen={onOpen} />
          ))}
        </div>
        {!showAll && (
          <div className="mt-6 flex justify-center">
            <button
              type="button"
              className="btn btn-outline btn-sm"
              aria-controls="way-grid"
              onClick={() => setShowAll(true)}
            >
              Show all
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------- chat ----------

function StageNote({ stage }) {
  const label = stage === "clarify" ? "Reading the ways" : "Reading the pages";
  return (
    <div className="secondary-text flex items-center gap-3 text-sm" aria-live="polite">
      <span className="loading loading-dots loading-sm" />
      {label}
    </div>
  );
}

function Message({ message, waysBySlug, onOpen, onRetry }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] sm:max-w-[75%] bg-base-200 text-base-content rounded-2xl rounded-br-md px-4 py-3 whitespace-pre-wrap">
          {message.text}
        </div>
      </div>
    );
  }

  const cards = (message.slugs || []).map((s) => waysBySlug.get(s)).filter(Boolean);

  return (
    <div className="max-w-[92%] sm:max-w-[80%]">
      {message.kind === "error" ? (
        <div className="alert alert-error items-start">
          <span>{message.text}</span>
          {onRetry && (
            <button className="btn btn-sm" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      ) : message.kind === "clarify" ? (
        <p className="py-3">{message.text}</p>
      ) : (
        <Markdown text={message.text} className="chat-prose" />
      )}
      {cards.length > 0 && (
        <div className="mt-3">
          <div className="quiet-label text-xs mb-2">pages</div>
          <div className="grid gap-2">
            {cards.map((w) => (
              <WayCard key={w.slug} way={w} onOpen={onOpen} compact />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Chat({
  messages,
  stage,
  draft,
  setDraft,
  onAsk,
  onOpen,
  onRetry,
  waysBySlug,
  inputRef,
}) {
  const logRef = useRef(null);
  useEffect(() => {
    const latest = messages[messages.length - 1];
    if (!latest || !logRef.current) return;
    const node = logRef.current.querySelector(`[data-message-id="${latest.id}"]`);
    node && node.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [messages]);

  return (
    <div className="flex flex-col h-[calc(100dvh-3rem)]">
      <div className="flex-1 overflow-y-auto">
        <div
          ref={logRef}
          className="max-w-2xl mx-auto px-4 sm:px-6 py-8 space-y-7"
          role="log"
          aria-live="polite"
          aria-label="Conversation"
        >
          {messages.map((m) => (
            <div key={m.id} data-message-id={m.id} className="scroll-mt-4">
              <Message
                message={m}
                waysBySlug={waysBySlug}
                onOpen={onOpen}
                onRetry={m.kind === "error" ? onRetry : null}
              />
            </div>
          ))}
          {stage && <StageNote stage={stage} />}
        </div>
      </div>
      <div className="shrink-0 bg-base-100">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-3">
          <Composer
            value={draft}
            setValue={setDraft}
            onSubmit={onAsk}
            busy={!!stage}
            inputRef={inputRef}
          />
        </div>
      </div>
    </div>
  );
}

// ---------- app ----------

let messageId = 0;
const nextId = () => `m${++messageId}`;

function App() {
  const [registry, setRegistry] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [route, setRoute] = useState(() => routeFrom(location.hash));
  const [base, setBase] = useState(() => {
    const r = routeFrom(location.hash);
    return r.view === "ask" ? "ask" : "landing";
  });
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [stage, setStage] = useState(null); // null | "clarify" | "answer"
  const drawerPushedRef = useRef(false);
  const messagesRef = useRef([]);
  const requestRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    let live = true;
    setLoadErr(null);
    fetch(REGISTRY_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data) => live && setRegistry(data))
      .catch(
        () =>
          live &&
          setLoadErr(
            "The book did not load. Serve this folder over http, for example: python3 -m http.server 8000",
          ),
      );
    return () => {
      live = false;
    };
  }, [loadAttempt]);

  useEffect(() => {
    const onHash = () => {
      const r = routeFrom(location.hash);
      setRoute(r);
      if (r.view !== "way") {
        setBase(r.view);
        drawerPushedRef.current = false;
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const ways = useMemo(() => activeWays(registry), [registry]);
  const waysBySlug = useMemo(() => new Map(ways.map((w) => [w.slug, w])), [ways]);
  const catalogue = useMemo(() => catalogueFor(ways), [ways]);
  const allowedSlugs = useMemo(() => new Set(ways.map((w) => w.slug)), [ways]);

  const goto = useCallback((view) => {
    setBase(view);
    setRoute({ view, slug: null });
    history.replaceState(null, "", hashFor(view, null));
  }, []);

  const openWay = useCallback((slug) => {
    drawerPushedRef.current = true;
    location.hash = hashFor("way", slug);
  }, []);

  const closeWay = useCallback(() => {
    if (drawerPushedRef.current) {
      drawerPushedRef.current = false;
      history.back();
      return;
    }
    setRoute({ view: base, slug: null });
    history.replaceState(null, "", hashFor(base, null));
  }, [base]);

  const replaceMessages = useCallback((next) => {
    messagesRef.current = next;
    setMessages(next);
  }, []);

  const push = useCallback((message) => {
    const next = [...messagesRef.current, { id: nextId(), ...message }];
    messagesRef.current = next;
    setMessages(next);
  }, []);

  const run = useCallback(
    async (turns) => {
      if (requestRef.current) return;
      const controller = new AbortController();
      const token = { controller };
      requestRef.current = token;
      const messages = turnsToMessages(turns);
      setStage("clarify");
      try {
        const triageRaw = await callModel({
          system: clarifySystemPrompt(catalogue),
          messages,
          json: true,
          signal: controller.signal,
        });
        if (requestRef.current !== token) return;
        const decision = resolveStage(parseJsonReply(triageRaw), allowedSlugs);

        if (decision.mode === "clarify") {
          const text = decision.questions[0];
          push({ role: "assistant", kind: "clarify", text, questions: decision.questions });
          return;
        }
        if (decision.mode === "nomatch") {
          push({
            role: "assistant",
            kind: "answer",
            text:
              "I cannot find a page in The Kalvium Way that speaks closely enough to this. What part of your work at Kalvium would you like to explore instead?",
            slugs: [],
          });
          return;
        }

        setStage("answer");
        const pages = await Promise.all(
          decision.slugs.map(async (slug) => {
            const way = waysBySlug.get(slug);
            const res = await fetch(way.file, { signal: controller.signal });
            if (!res.ok) throw new Error("page");
            return `## Page: ${way.displayTitle || way.title}\nslug: ${slug}\n\n${stripFrontmatter(
              await res.text(),
            ).trim()}`;
          }),
        ).catch((error) => {
          if (error && error.name === "AbortError") throw error;
          throw new Error("A page of the book did not load. Send it again.");
        });

        const pageContext = `The pages of The Kalvium Way that apply to this situation:\n\n${pages.join(
          "\n\n---\n\n",
        )}`;
        const answer = await callModel({
          system: answerSystemPrompt(),
          messages: [
            ...messages,
            { role: "user", content: `${pageContext}\n\nAnswer the situation above using only these pages.` },
          ],
          signal: controller.signal,
        });
        if (requestRef.current !== token) return;
        push({ role: "assistant", kind: "answer", text: answer, slugs: decision.slugs });
      } catch (e) {
        if (!e || e.name !== "AbortError") {
          push({
            role: "assistant",
            kind: "error",
            text: (e && e.message) || "Something went wrong. Send it again.",
          });
        }
      } finally {
        if (requestRef.current === token) {
          requestRef.current = null;
          setStage(null);
        }
      }
    },
    [catalogue, allowedSlugs, waysBySlug, push],
  );

  const send = useCallback(
    (text) => {
      const trimmed = String(text || "").trim();
      if (!trimmed || stage || requestRef.current) return;
      const turn = { id: nextId(), role: "user", text: trimmed };
      const next = [...messagesRef.current, turn];
      replaceMessages(next);
      run(next);
      setDraft("");
      if (base !== "ask") goto("ask");
    },
    [stage, run, base, goto, replaceMessages],
  );

  const retry = useCallback(() => {
    if (requestRef.current) return;
    const kept = messagesRef.current.filter((m) => m.kind !== "error");
    replaceMessages(kept);
    if (kept.some((m) => m.role === "user")) run(kept);
  }, [run, replaceMessages]);


  const way = route.view === "way" ? waysBySlug.get(route.slug) : null;
  const missingWay = route.view === "way" && registry && !way;

  if (loadErr) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="font-display text-2xl font-semibold lowercase mb-2">
            ask <span className="wordmark-accent">the way</span>
          </h1>
          <div className="alert alert-error justify-center mb-4">
            <span>{loadErr}</span>
          </div>
          <button className="btn btn-primary" onClick={() => setLoadAttempt((a) => a + 1)}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!registry) {
    return (
      <div className="min-h-screen flex items-center justify-center" aria-busy="true">
        <span className="loading loading-dots loading-lg" aria-label="Loading the book" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-base-100">
      {base === "ask" && (
        <header className="ui-border sticky top-0 z-30 h-12 border-b bg-base-100/95 backdrop-blur">
          <div className="mx-auto flex h-full max-w-2xl items-center px-4 sm:px-6">
            <h1 className="contents">
            <a
              href="#/"
              onClick={(e) => {
                e.preventDefault();
                goto("landing");
              }}
              className="font-display text-base font-semibold lowercase"
            >
              ask <span className="wordmark-accent">the way</span>
            </a>
            </h1>
          </div>
        </header>
      )}

      <main>
        {base === "ask" && messages.length > 0 ? (
          <Chat
            messages={messages}
            stage={stage}
            draft={draft}
            setDraft={setDraft}
            onAsk={() => send(draft)}
            onOpen={openWay}
            onRetry={retry}
            waysBySlug={waysBySlug}
            inputRef={inputRef}
          />
        ) : (
          <Landing
            ways={ways}
            onOpen={openWay}
            onAsk={() => send(draft)}
            draft={draft}
            setDraft={setDraft}
            busy={!!stage}
            inputRef={inputRef}
          />
        )}
      </main>

      {way && <WayDrawer way={way} onClose={closeWay} />}
      {missingWay && (
        <div className="fixed inset-x-0 bottom-6 flex justify-center px-4 z-40">
          <div className="alert alert-warning max-w-md">
            <span>That page is not part of the book. Browse the {ways.length} ways instead.</span>
            <button className="btn btn-sm" onClick={() => goto("landing")}>
              Browse
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
