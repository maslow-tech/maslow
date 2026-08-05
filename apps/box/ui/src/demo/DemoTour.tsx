import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { isDemo } from "./index";

/**
 * The guided tour for hosted-demo. It DRIVES the real dashboard — auto-
 * navigating between real routes on canned data — while a caption coach-mark
 * narrates each feature. The visitor can pause, step, or "explore on their own"
 * (which dismisses the tour and hands over the live UI). Renders only in demo
 * mode; a floating "Guided tour" button brings it back after dismissal.
 */

interface Stop {
  path: string;
  title: string;
  body: string;
}

const STOPS: Stop[] = [
  {
    path: "/",
    title: "One brain for the whole company",
    body: "Everything your company knows — accounts, people, products, deals, docs — in one place your team and your AI agents share. This is the home library: a shelf per database.",
  },
  {
    path: "/t/deal",
    title: "Every record, structured",
    body: "Each database is a real, typed table — sort, filter, or flip to a board. The brain defines its own schema as it learns what your company tracks.",
  },
  {
    path: "/o/6102322e-4ec7-4f7e-8bca-867a2c1bce4c",
    title: "Everything connects",
    body: "Open any object and you see its properties, the people and accounts attached to it, the work it drives, and every backlink pointing at it. The map shows its links at a glance — nothing is stranded.",
  },
  {
    path: "/graph",
    title: "See how it all relates",
    body: "A living map of the whole brain — connected objects pull into clusters. Drag a node, zoom, follow a thread. This is your company, drawn.",
  },
  {
    path: "/search?q=morning%20ember",
    title: "Find anything instantly",
    body: "Instant results as you type, then the deep pass ranks by meaning and connections — every hit shows HOW it was found: exact text, meaning, or a relationship trail.",
  },
  {
    path: "/timeline",
    title: "Every change, audited",
    body: "A complete activity log — who, and which AI agent, did what, when. Reads and writes alike. Nothing happens in the dark.",
  },
  {
    path: "/private",
    title: "Private when it needs to be",
    body: "Personal notes and sensitive facts stay yours — visible only to you and whoever you share them with, enforced in the database itself.",
  },
  {
    path: "/members",
    title: "Your team, your rules",
    body: "Owners, members, read-only viewers. Grant access, rotate tokens, revoke instantly. It runs in your cloud — the data never leaves.",
  },
  {
    path: "/",
    title: "Your AI agents work here",
    body: "Connect the brain to Claude and your agents read and write it through one endpoint — filing updates, answering from what the company knows, running named routines. This is their shared memory.",
  },
];

const STEP_MS = 7000;

function DemoTour() {
  const [on, setOn] = useState(true);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();
  const driving = useRef(false); // distinguishes tour navigation from user clicks

  // drive the dashboard to the current stop
  useEffect(() => {
    if (!on) return;
    const stop = STOPS[i]!;
    driving.current = true;
    navigate(stop.path);
    const t = setTimeout(() => (driving.current = false), 400);
    return () => clearTimeout(t);
  }, [i, on, navigate]);

  // auto-advance
  useEffect(() => {
    if (!on || !playing) return;
    const t = setTimeout(() => {
      setI((n) => {
        if (n + 1 >= STOPS.length) {
          setPlaying(false);
          return n;
        }
        return n + 1;
      });
    }, STEP_MS);
    return () => clearTimeout(t);
  }, [on, playing, i]);

  // if the visitor navigates on their own, step aside (hand over)
  useEffect(() => {
    if (!on || driving.current) return;
    const stop = STOPS[i];
    if (stop && location.pathname !== stop.path) {
      setPlaying(false);
      setOn(false);
    }
  }, [location.pathname, on, i]);

  if (!on) {
    return (
      <button
        className="demo-tour-fab"
        onClick={() => {
          setOn(true);
          setPlaying(true);
        }}
      >
        ▶ Guided tour
      </button>
    );
  }

  const stop = STOPS[i]!;
  const atEnd = i === STOPS.length - 1;

  return (
    <>
      <div className="demo-tour">
        <div className="demo-tour-step">
          {String(i + 1).padStart(2, "0")} / {String(STOPS.length).padStart(2, "0")}
        </div>
        <h3>{stop.title}</h3>
        <p>{stop.body}</p>
        <div className="demo-tour-row">
          <div className="demo-tour-ctrls">
            <button
              onClick={() => setI((n) => Math.max(0, n - 1))}
              disabled={i === 0}
              aria-label="Back"
            >
              ‹
            </button>
            <button onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play"}>
              {playing ? "❙❙" : "▶"}
            </button>
            <button
              onClick={() =>
                atEnd ? setOn(false) : setI((n) => Math.min(STOPS.length - 1, n + 1))
              }
              aria-label="Next"
            >
              ›
            </button>
            <div className="demo-tour-dots">
              {STOPS.map((_, n) => (
                <button
                  key={n}
                  className={n === i ? "on" : ""}
                  onClick={() => setI(n)}
                  aria-label={`Step ${n + 1}`}
                />
              ))}
            </div>
          </div>
          <button
            className="demo-tour-take"
            onClick={() => {
              setPlaying(false);
              setOn(false);
            }}
          >
            Explore on your own →
          </button>
        </div>
        {playing && (
          <div className="demo-tour-bar">
            <span key={i} style={{ animationDuration: `${STEP_MS}ms` }} />
          </div>
        )}
      </div>
      <style>{CSS}</style>
    </>
  );
}

/** Mounts the tour only in the demo build. */
export function DemoTourMount() {
  if (!isDemo()) return null;
  return <DemoTour />;
}

const CSS = `
.demo-tour {
  position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%);
  width: min(680px, calc(100vw - 40px)); z-index: 9999;
  background: color-mix(in srgb, var(--panel, #0e0e13) 92%, transparent);
  border: 1px solid var(--line, rgba(255,255,255,.14));
  box-shadow: 0 30px 80px -30px rgba(0,0,0,.75); padding: 16px 18px 18px;
  backdrop-filter: blur(12px);
}
.demo-tour-step { font-family: var(--font-mono, monospace); font-size: 11px; letter-spacing: .1em; color: var(--dim, #9aa0aa); }
.demo-tour h3 { font-size: 17px; letter-spacing: -.01em; margin: 3px 0 5px; color: var(--ink-strong, #fff); }
.demo-tour p { font-size: 13px; line-height: 1.5; color: var(--mut, #b8bcc4); margin: 0 0 12px; }
.demo-tour-row { display: flex; align-items: center; gap: 12px; justify-content: space-between; flex-wrap: wrap; }
.demo-tour-ctrls { display: flex; align-items: center; gap: 7px; }
.demo-tour-ctrls > button {
  width: 30px; height: 30px; border: 1px solid var(--line, rgba(255,255,255,.16));
  background: transparent; color: var(--ink, #e7e7ea); cursor: pointer; font-size: 12px;
}
.demo-tour-ctrls > button:hover:not(:disabled) { background: var(--hover, rgba(255,255,255,.08)); }
.demo-tour-ctrls > button:disabled { opacity: .3; cursor: default; }
.demo-tour-dots { display: flex; gap: 5px; margin-left: 6px; }
.demo-tour-dots button { width: 7px; height: 7px; padding: 0; border: 0; border-radius: 50%; background: var(--dim, rgba(255,255,255,.25)); cursor: pointer; }
.demo-tour-dots button.on { background: var(--ink-strong, #fff); }
.demo-tour-take { border: 0; background: var(--ink-strong, #fff); color: var(--ground, #0b0b0f); font-weight: 650; font-size: 12.5px; padding: 8px 14px; cursor: pointer; }
.demo-tour-take:hover { opacity: .88; }
.demo-tour-bar { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: rgba(255,255,255,.08); overflow: hidden; }
.demo-tour-bar span { display: block; height: 100%; background: linear-gradient(90deg,#8a6cff,#4aa8ff); animation: demoTourFill linear forwards; }
.demo-tour-fab {
  position: fixed; right: 18px; bottom: 18px; z-index: 9999;
  border: 1px solid var(--line, rgba(255,255,255,.16)); background: var(--panel, #14141a); color: var(--ink, #e7e7ea);
  padding: 9px 15px; font-size: 12.5px; cursor: pointer;
}
.demo-tour-fab:hover { background: var(--hover, rgba(255,255,255,.08)); }
@keyframes demoTourFill { from { width: 0; } to { width: 100%; } }
`;
