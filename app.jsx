// Ask The Way: describe a real situation, get an answer grounded in the 94 active
// pages of The Kalvium Way, with every page one click away.
//
// Two stages, both in the browser with the visitor's own Gemini key:
//   1. clarity gate: the whole conversation plus title/one-line/phase metadata for
//      the 94 active ways. Gemini returns JSON saying whether it can answer yet and
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

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const GEMINI_KEY_HEADER = "x-goog-api-key";
const KEY_STORAGE_NAME = "geminiKey";
const AI_STUDIO_KEYS_URL = "https://aistudio.google.com/api-keys";
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
  return catalogue
    .map((c) => `- ${c.slug} | P${c.phase} | ${c.title} | ${c.way}`)
    .join("\n");
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

// Gemini sometimes wraps JSON in a code fence even when asked not to.
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
    .filter((q) => q && typeof q.question === "string" && q.question.trim())
    .map((q) => ({
      question: String(q.question).trim(),
      fallback: String((q && q.default) || "").trim(),
      why: String((q && q.why) || "").trim(),
    }))
    .filter((q) => q.fallback);
  const slugs = (Array.isArray(triage && triage.slugs) ? triage.slugs : [])
    .filter((s) => typeof s === "string" && allowed.has(s))
    .slice(0, 3);

  const clear = triage && triage.contextIsClear === true;
  if (!clear) {
    return questions.length
      ? { mode: "clarify", questions, slugs: [] }
      : {
          mode: "clarify",
          questions: [
            {
              question: "What is the situation, and who is involved?",
              fallback: "A campus mentor deciding what to do next with one student.",
              why: "",
            },
          ],
          slugs: [],
        };
  }
  if (!slugs.length) return { mode: "nomatch", questions: [], slugs: [] };
  return { mode: "answer", questions: [], slugs };
}

// Fixed reply for "use the defaults", so the next turn carries the defaults forward.
function defaultsReply(questions) {
  const lines = (questions || [])
    .filter((q) => q.fallback)
    .map((q) => `${q.question} ${q.fallback}`);
  return lines.length
    ? `Use the defaults.\n${lines.join("\n")}`
    : "Use the defaults and answer with what you have.";
}

// Shared language rules for grounded, direct prose. Both stages carry them,
// because clarifying questions ship to a reader too.
const VOICE_RULES = [
  "Write as a thoughtful Kalvium colleague speaking to another colleague.",
  "Use simple, direct language. Use 'we' and 'our' for Kalvium's responsibilities and standards.",
  "Prefer verbs and specific actions to abstract concepts.",
  "No em dashes or en dashes. Use commas, full stops, colons or brackets.",
  "No aphorisms, slogans, polished contrasts, abstract-noun equations, generic praise, filler, cliches or tidy moral endings.",
  "Keep one main idea in each sentence. Do not combine a claim, a reason and a source attribution in one sentence.",
  "Do not say 'according to the page', 'as described in', 'as stated in' or 'as mentioned in'. Source cards appear under the answer.",
  "Do not summarise each source in turn. Build one coherent response around one primary Way.",
  "The pages control the facts, not the sentence shape. Explain their mechanism in your own ordinary sentences.",
  "Do not quote or lightly paraphrase a memorable line from a page as if it explains itself.",
  "Never begin a summary with 'This Way'. Name the belief directly.",
  "Gloss any Kalvium term or jargon on first use, or use the ordinary word.",
  "No performative honesty, false emphasis, unsupported absolutes, meta-commentary or defensive denials.",
  "Every recommendation needs its reasoning beside it. Every verdict needs a reason.",
  "Use a real anecdote from a supplied page when it makes the action clearer. Never invent one.",
  "Claim only what the supplied pages support. Do not invent policy, numbers, names, processes or page titles.",
  "Before returning, remove any sentence that sounds crafted to be quotable or sounds like an AI report.",
  "Kalvium always has a capital K.",
];

const GROUNDING_RULES = [
  "Answer only from the Kalvium Way pages supplied in this message.",
  "The pages are the whole of what you know about Kalvium. If they do not cover part of the situation, say which part is not covered and stop there.",
  "Do not invent policy, numbers, names, processes or page titles.",
  "Do not claim more certainty than the pages carry.",
];

function clarifySystemPrompt(catalogue) {
  return [
    "You route questions about working at Kalvium to the right pages of The Kalvium Way, a public handbook of 94 pages written primarily for Kalvium employees.",
    "",
    "You do two things and nothing else:",
    "1. Decide whether the situation is clear enough to answer well.",
    "2. Choose the few pages that speak to it.",
    "",
    "Set contextIsClear to false only when an ambiguity would change the advice, for example when the answer differs by who is involved, what has already been tried, or what outcome the person wants. Everyday missing detail is not a reason to ask.",
    "When you set it to false: give at most three questions, each with a specific default a reasonable reader would accept, and fill 'why' only when the question could surprise the person asking. Leave 'why' empty otherwise. Do not answer the situation in that turn, and do not offer partial advice with the questions.",
    "When you set it to true: return between one and three slugs from the catalogue below, most relevant first, and leave questions empty. The first slug must be the primary Way that should lead the answer.",
    "Copy slugs exactly as written. Never invent a slug. If nothing in the catalogue is close, return an empty slug list with contextIsClear true.",
    "If the conversation already answered your earlier questions, or the person said to use the defaults, set contextIsClear to true and choose pages.",
    "",
    "Language rules for the questions you write:",
    ...VOICE_RULES.map((r) => `- ${r}`),
    "",
    "Catalogue, one line each as slug | phase | title | what the way says:",
    catalogueLines(catalogue),
  ].join("\n");
}

function answerSystemPrompt() {
  return [
    "You answer a Kalvium employee's real situation using only the supplied pages of The Kalvium Way.",
    "",
    "Grounding:",
    ...GROUNDING_RULES.map((r) => `- ${r}`),
    "- The first supplied page is the primary Way. Other supplied pages may support it.",
    "- Do not add a document name, policy, process, consequence or interpretation that is absent from the pages.",
    "- If the pages leave an operational detail open, ask about it rather than filling the gap.",
    "",
    "Write a concise Markdown answer. Guide the reader through it in this order:",
    "- Begin with the exact title of the primary Way. Do not call it 'our primary Way' and do not write 'This Way asks us'.",
    "- Summarise what it asks of us and why in one or two plain sentences.",
    "- Apply it to the situation. Start with the first useful action, use 'we', and include our side of the responsibility where it matters.",
    "- End with one short, practical question that would let you give the next, more specific step. The question must be one sentence under 25 words. Ask only one question and stop there.",
    "",
    "Use short Markdown headings if they help the reader scan. Prefer 'The Kalvium Way', 'In this situation' and 'One question' over formal labels such as 'Our Primary Way', 'Applying the Way' or 'Next Step'.",
    "Aim for 120 to 170 words and never exceed 190 words. Do not add a conclusion or source summary.",
    "",
    "Before returning, privately check every sentence. Rewrite the answer if it contains any of these phrases: 'This Way', 'according to', 'as described in', 'as stated in', 'as mentioned in', 'industry-ready', 'core skill', 'crucial', 'transformation', 'tight feedback loop', 'hold the line', 'signals that', 'silence reads as permission', 'violation seen and let pass', 'becomes the new standard', or 'check that the schedule is holding up its end'.",
    "",
    "Language rules:",
    ...VOICE_RULES.map((r) => `- ${r}`),
    "",
    "Sentence-shape examples:",
    "Bad: 'According to the page on feedback, feedback should be provided immediately, which is crucial for growth.'",
    "Better: 'Give the feedback while the event is still fresh. We can talk about the exact decision and what needs to change next time.'",
    "Bad: 'Before holding a student to the schedule, however, check that the schedule is holding up its end.'",
    "Better: 'While we should hold the student to the schedule, let us also make sure our schedule is set up well and that we follow it consistently.'",
    "Bad: 'Silence signals that punctuality is optional and undermines student transformation.'",
    "Better: 'Speak to the students the same day. If we ignore repeated lateness, they have no reason to believe the timing matters.'",
  ].join("\n");
}

const CLARIFY_SCHEMA = {
  type: "OBJECT",
  properties: {
    contextIsClear: { type: "BOOLEAN" },
    questions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          question: { type: "STRING" },
          default: { type: "STRING" },
          why: { type: "STRING" },
        },
        required: ["question", "default"],
      },
    },
    slugs: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["contextIsClear", "questions", "slugs"],
};


// ---------- end pure helpers (region: pure) ----------

// ---------- model calls ----------

async function callGemini({ apiKey, system, contents, json, signal, temperature }) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: json
      ? {
          temperature: temperature ?? 0.2,
          responseMimeType: "application/json",
          responseSchema: CLARIFY_SCHEMA,
        }
      : { temperature: temperature ?? 0.2 },
  };
  let res;
  try {
    res = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", [GEMINI_KEY_HEADER]: apiKey },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new Error("The request to Google did not go through. Check your connection.");
  }
  if (!res.ok) {
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new Error(
        "Google rejected the key. Check that it is a Gemini API key and that it is still active.",
      );
    }
    if (res.status === 429) {
      throw new Error("The key hit its rate limit. Wait a moment and send it again.");
    }
    throw new Error(`Google returned an error (${res.status}).`);
  }
  const data = await res.json();
  const blocked = data.promptFeedback && data.promptFeedback.blockReason;
  if (blocked) throw new Error("Google blocked the request. Try rewording the situation.");
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content
    ? data.candidates[0].content.parts || []
    : []
  )
    .map((p) => p.text || "")
    .join("")
    .trim();
  if (!parts) throw new Error("Google returned an empty answer. Send it again.");
  return parts;
}

function turnsToContents(messages) {
  return messages
    .filter((m) => m.text && (m.role === "user" || m.kind === "answer" || m.kind === "clarify"))
    .map((m) => ({ role: m.role === "user" ? "user" : "model", parts: [{ text: m.text }] }));
}

// ---------- small shared pieces ----------

function useKey() {
  const [key, setKey] = useState(() => {
    try {
      return localStorage.getItem(KEY_STORAGE_NAME) || "";
    } catch {
      return "";
    }
  });
  const save = useCallback((value) => {
    try {
      localStorage.setItem(KEY_STORAGE_NAME, value);
    } catch {
      /* private mode: the key stays in memory for this tab */
    }
    setKey(value);
  }, []);
  const clear = useCallback(() => {
    try {
      localStorage.removeItem(KEY_STORAGE_NAME);
    } catch {
      /* nothing stored */
    }
    setKey("");
  }, []);
  return { key, save, clear };
}

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

// ---------- key dialog ----------

function KeyDialog({ currentKey, onSave, onClear, onClose }) {
  const [value, setValue] = useState(currentKey || "");
  const inputRef = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    const previous = document.activeElement;
    inputRef.current && inputRef.current.focus();
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll(
        'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
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

  const submit = (e) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed) onSave(trimmed);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-base-content/40" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="key-title"
        aria-describedby="key-desc"
        className="relative w-full max-h-[100dvh] overflow-y-auto sm:max-w-lg bg-base-100 rounded-t-2xl sm:rounded-2xl shadow-2xl"
      >
        <form onSubmit={submit} className="p-6">
          <h2 id="key-title" className="font-display text-xl font-semibold mb-2">
            Add your Gemini API key
          </h2>
          <div id="key-desc" className="secondary-text text-sm space-y-2 mb-4">
            <p>
              Ask The Way runs in this browser tab. Your situation and the text of the relevant
              Kalvium Way pages go straight from here to Google, using your key. No application
              server sits in between.
            </p>
            <p>
              A key held in a browser cannot be kept secret: any script on this page can read it.
              Use a free-tier key, and remove it here when you are done. It is stored in this
              browser only, under <code>{KEY_STORAGE_NAME}</code>, and never appears in the address
              bar.
            </p>
            <p>
              <a
                className="link link-primary"
                href={AI_STUDIO_KEYS_URL}
                target="_blank"
                rel="noreferrer noopener"
              >
                Get a key from Google AI Studio
              </a>
              , then paste it below.
            </p>
          </div>
          <label className="form-control w-full">
            <span className="label-text mb-1">Gemini API key</span>
            <input
              ref={inputRef}
              type="password"
              autoComplete="off"
              spellCheck="false"
              name="gemini-api-key"
              className="input input-bordered ui-border w-full font-mono text-sm"
              placeholder="AIza..."
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          <div className="mt-5 flex flex-wrap gap-2 justify-end">
            {currentKey && (
              <button type="button" className="btn btn-ghost text-error" onClick={onClear}>
                Remove key
              </button>
            )}
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!value.trim()}>
              {currentKey ? "Update key" : "Save key"}
            </button>
          </div>
        </form>
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

function Landing({ ways, onOpen, onAsk, draft, setDraft, busy, inputRef, onKey }) {
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
      <button
        className="btn btn-xs btn-ghost absolute right-3 top-3 text-base-content/80 sm:right-6 sm:top-5"
        onClick={onKey}
        aria-label="Gemini API key settings"
      >
        key
      </button>

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

function Message({ message, waysBySlug, onOpen, onDefaults, onRetry }) {
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
        <div className="ui-border rounded-2xl rounded-bl-md border bg-base-100 px-4 py-3">
          <p className="secondary-text text-sm mb-3">
            A few details would change the answer:
          </p>
          <ol className="space-y-3">
            {message.questions.map((q, i) => (
              <li key={i}>
                <p className="font-medium">{q.question}</p>
                {q.fallback && (
                  <p className="secondary-text text-sm">Default: {q.fallback}</p>
                )}
                {q.why && <p className="secondary-text text-sm">Asking because {q.why}</p>}
              </li>
            ))}
          </ol>
          <button className="btn btn-sm btn-ghost mt-4" onClick={() => onDefaults(message)}>
            Use the defaults
          </button>
        </div>
      ) : (
        <Markdown text={message.text} className="prose-sm sm:prose-base" />
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
  onDefaults,
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
                onDefaults={onDefaults}
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
  const [keyDialog, setKeyDialog] = useState(false);
  const { key, save, clear } = useKey();

  const pendingRef = useRef(null); // text held while the key dialog is open
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

  // apiKey is passed in rather than read from state: the first ask resumes right
  // after the key dialog saves, before the state update has landed.
  const run = useCallback(
    async (turns, apiKey) => {
      if (requestRef.current) return;
      const controller = new AbortController();
      const token = { controller };
      requestRef.current = token;
      const contents = turnsToContents(turns);
      setStage("clarify");
      try {
        const triageRaw = await callGemini({
          apiKey,
          system: clarifySystemPrompt(catalogue),
          contents,
          json: true,
          signal: controller.signal,
        });
        if (requestRef.current !== token) return;
        const decision = resolveStage(parseJsonReply(triageRaw), allowedSlugs);

        if (decision.mode === "clarify") {
          const text = decision.questions
            .map((q) => `${q.question} (default: ${q.fallback})`)
            .join("\n");
          push({ role: "assistant", kind: "clarify", text, questions: decision.questions });
          return;
        }
        if (decision.mode === "nomatch") {
          push({
            role: "assistant",
            kind: "answer",
            text:
              "No page in The Kalvium Way covers this closely enough for me to answer from the book. Ask about something the book speaks to, such as feedback, campus rhythm, student growth or how decisions get made, and I will point you at the pages.",
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
        const answer = await callGemini({
          apiKey,
          system: answerSystemPrompt(),
          contents: [
            ...contents,
            {
              role: "user",
              parts: [{ text: `${pageContext}\n\nAnswer the situation above using only these pages.` }],
            },
          ],
          signal: controller.signal,
          temperature: 0.15,
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
      if (!key) {
        pendingRef.current = trimmed;
        setKeyDialog(true);
        return;
      }
      const turn = { id: nextId(), role: "user", text: trimmed };
      const next = [...messagesRef.current, turn];
      replaceMessages(next);
      run(next, key);
      setDraft("");
      if (base !== "ask") goto("ask");
    },
    [key, stage, run, base, goto, replaceMessages],
  );

  const retry = useCallback(() => {
    if (requestRef.current) return;
    const kept = messagesRef.current.filter((m) => m.kind !== "error");
    replaceMessages(kept);
    if (kept.some((m) => m.role === "user")) run(kept, key);
  }, [run, key, replaceMessages]);

  const onSaveKey = useCallback(
    (value) => {
      if (requestRef.current) requestRef.current.controller.abort();
      save(value);
      setKeyDialog(false);
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) {
        const turn = { id: nextId(), role: "user", text: pending };
        const next = [...messagesRef.current, turn];
        replaceMessages(next);
        run(next, value);
        setDraft("");
        goto("ask");
      }
    },
    [save, goto, run, replaceMessages],
  );


  const applyDefaults = useCallback(
    (message) => send(defaultsReply(message.questions)),
    [send],
  );

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
            <button
              className="btn btn-xs btn-ghost ml-auto text-base-content/80"
              onClick={() => setKeyDialog(true)}
              aria-label="Gemini API key settings"
            >
              key
            </button>
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
            onDefaults={applyDefaults}
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
            onKey={() => setKeyDialog(true)}
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
      {keyDialog && (
        <KeyDialog
          currentKey={key}
          onSave={onSaveKey}
          onClear={() => {
            if (requestRef.current) requestRef.current.controller.abort();
            clear();
            pendingRef.current = null;
            setKeyDialog(false);
          }}
          onClose={() => {
            pendingRef.current = null;
            setKeyDialog(false);
          }}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
