// Flakehound: reads JUnit XML reports from several CI runs, finds tests that both pass and fail, and says who owns each one.
import { useMemo, useRef, useState } from "react";
import { download, useStored } from "./lib/store";
import { Section, Stat, Stats } from "./ui/kit";

const T = "flakehound";
type Run = { id: string; name: string; results: { key: string; file: string; ok: boolean; secs: number; msg: string }[] };

function parseJUnit(xml: string, name: string): Run {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const results = [...doc.querySelectorAll("testcase")].map(tc => {
    const cls = tc.getAttribute("classname") ?? "", n = tc.getAttribute("name") ?? "";
    const failure = tc.querySelector("failure, error");
    const skipped = tc.querySelector("skipped");
    return skipped ? null : { key: `${cls} › ${n}`, file: tc.getAttribute("file") ?? cls.replace(/\./g, "/"), ok: !failure, secs: parseFloat(tc.getAttribute("time") ?? "0"), msg: failure?.getAttribute("message") ?? failure?.textContent?.slice(0, 160) ?? "" };
  }).filter(Boolean) as Run["results"];
  return { id: Math.random().toString(36).slice(2), name, results };
}
function sampleRuns(): Run[] {
  const tests = ["checkout › applies discount code", "checkout › rejects expired card", "auth › logs in with email", "auth › refreshes token after expiry", "search › returns results under 300ms", "cart › merges guest cart on login", "profile › uploads avatar", "orders › lists orders newest first"];
  const flaky: Record<string, number> = { "auth › refreshes token after expiry": 0.35, "search › returns results under 300ms": 0.25, "profile › uploads avatar": 0.1 };
  let s = 5; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  return Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, name: `main #${1840 + i}`, results: tests.map(t => { const [cls] = t.split(" › "); const ok = r() > (flaky[t] ?? 0) && !(t === "checkout › rejects expired card" && i >= 10); return { key: t, file: `tests/${cls}/${cls}.spec.ts`, ok, secs: 0.2 + r() * (t.includes("search") ? 0.6 : 0.2), msg: ok ? "" : t.includes("token") ? "Timeout: expected 200 but got 401" : t.includes("search") ? "Expected < 300ms, took 342ms" : "AssertionError" }; }) }));
}
const SAMPLE_OWNERS = `tests/auth/ @team-identity
tests/checkout/ @team-payments
tests/search/ @team-discovery
tests/profile/ @amira
* @platform`;

function owner(file: string, rules: string) {
  const lines = rules.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#")).map(l => l.split(/\s+/));
  let found = "";
  for (const [pat, ...owners] of lines) {
    const rx = new RegExp("^" + pat.replace(/^\//, "").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "§").replace(/\*/g, "[^/]*").replace(/§/g, ".*") + (pat.endsWith("/") ? ".*" : "(/.*)?$"));
    if (pat === "*" || rx.test(file)) found = owners.join(" "); // last matching rule wins, like GitHub
  }
  return found || "Nobody";
}

export default function Flakehound() {
  const [runs, setRuns] = useStored<Run[]>(T, "runs", sampleRuns());
  const [owners, setOwners] = useStored(T, "owners", SAMPLE_OWNERS);
  const [quarantine, setQuarantine] = useStored<string[]>(T, "quarantine", []);
  const [err, setErr] = useState("");
  const file = useRef<HTMLInputElement>(null);

  const stats = useMemo(() => {
    const m = new Map<string, { key: string; file: string; pass: number; fail: number; flips: number; last: boolean[]; msgs: string[]; secs: number[] }>();
    runs.forEach(run => run.results.forEach(r => {
      const x = m.get(r.key) ?? { key: r.key, file: r.file, pass: 0, fail: 0, flips: 0, last: [], msgs: [], secs: [] };
      if (x.last.length && x.last[x.last.length - 1] !== r.ok) x.flips++;
      x.last.push(r.ok); r.ok ? x.pass++ : x.fail++; if (r.msg) x.msgs.push(r.msg); x.secs.push(r.secs);
      m.set(r.key, x);
    }));
    return [...m.values()];
  }, [runs]);
  // Flaky: fails sometimes but not always, with at least two flips between pass and fail.
  const flaky = stats.filter(s => s.pass > 0 && s.fail > 0 && s.flips >= 2).sort((a, b) => b.fail / (b.pass + b.fail) - a.fail / (a.pass + a.fail));
  const broken = stats.filter(s => s.fail > 0 && s.last.slice(-2).every(x => !x) && !flaky.includes(s));
  const totalRuns = runs.length, redRuns = runs.filter(r => r.results.some(x => !x.ok)).length;
  const redBecauseFlaky = runs.filter(r => r.results.some(x => !x.ok) && r.results.filter(x => !x.ok).every(x => flaky.some(f => f.key === x.key))).length;

  const load = async (files: FileList | null) => {
    if (!files?.length) return;
    try { const parsed = await Promise.all([...files].map(async f => parseJUnit(await f.text(), f.name.replace(/\.xml$/, "")))); const good = parsed.filter(p => p.results.length); if (!good.length) throw new Error(); setRuns(runs.length && runs[0].id === "r0" ? good : [...runs, ...good]); setErr(""); }
    catch { setErr("Those files did not look like JUnit XML. Most test runners can write it (Jest, pytest, JUnit, Go with go-junit-report)."); }
  };

  return (
    <div className="stack">
      <Section title="Test health" aside={<><button className="btn small primary" onClick={() => file.current?.click()}>Add JUnit reports</button><input ref={file} type="file" accept=".xml,application/xml,text/xml" multiple hidden onChange={e => load(e.target.files)} /><button className="btn ghost small danger" onClick={() => setRuns([])}>Clear runs</button></>}>
        <Stats><Stat value={totalRuns} label="CI runs read" /><Stat value={stats.length} label="Tests" /><Stat value={flaky.length} label="Flaky" tone={flaky.length ? "bad" : "good"} /><Stat value={`${redRuns}`} label="Red builds" /><Stat value={redBecauseFlaky} label="Red only because of flakes" tone={redBecauseFlaky ? "warn" : undefined} /></Stats>
        {err && <p className="pill bad" style={{ marginTop: 10 }}>{err}</p>}
        <p className="note" style={{ marginTop: 10 }}>Download the test report artifact from your last 10 to 30 CI runs and drop them in. Nothing is uploaded anywhere.</p>
      </Section>
      <Section title="Flaky tests" aside={<button className="btn small" disabled={!flaky.length} onClick={() => download("flaky-tests.md", `# Flaky tests\n\n${flaky.map(f => `- [ ] \`${f.key}\` (${f.file}) fails ${Math.round((f.fail / (f.pass + f.fail)) * 100)}% of runs. Owner: ${owner(f.file, owners)}\n  - Example failure: ${f.msgs[0] ?? ""}`).join("\n")}`, "text/markdown")}>Export as issue checklist</button>}>
        {flaky.length === 0 ? <p className="empty-note">No flaky tests found in these runs.</p> : flaky.map(f => (
          <div key={f.key} className="fh-row">
            <div style={{ flex: 1, minWidth: 0 }}><strong>{f.key}</strong><p className="note">{f.file} · owner <b>{owner(f.file, owners)}</b></p><p className="note fh-msg">{f.msgs[0]}</p></div>
            <div className="fh-strip" aria-label="Recent results">{f.last.slice(-20).map((ok, i) => <i key={i} className={ok ? "ok" : "no"} />)}</div>
            <span className="pill bad">{Math.round((f.fail / (f.pass + f.fail)) * 100)}% fail</span>
            <button className={"btn small" + (quarantine.includes(f.key) ? "" : " primary")} onClick={() => setQuarantine(quarantine.includes(f.key) ? quarantine.filter(x => x !== f.key) : [...quarantine, f.key])}>{quarantine.includes(f.key) ? "Quarantined" : "Quarantine"}</button>
          </div>))}
      </Section>
      {broken.length > 0 && <Section title="Genuinely broken (failing in the latest runs)">{broken.map(b => <div key={b.key} className="fh-row"><strong style={{ flex: 1 }}>{b.key}</strong><span className="note">{owner(b.file, owners)}</span><div className="fh-strip">{b.last.slice(-20).map((ok, i) => <i key={i} className={ok ? "ok" : "no"} />)}</div></div>)}</Section>}
      <div className="grid2">
        <Section title="Code owners">
          <label className="field"><span>Paste your CODEOWNERS file (or write path and owner lines)</span><textarea id="fh-own" className="input" rows={7} value={owners} onChange={e => setOwners(e.target.value)} style={{ fontFamily: "var(--mono)", fontSize: 13 }} /></label>
        </Section>
        <Section title="Quarantine list">
          {quarantine.length === 0 ? <p className="empty-note">Quarantined tests appear here, ready to paste into your skip list.</p> : <>
            <pre className="fh-pre">{quarantine.join("\n")}</pre>
            <button className="btn small" onClick={() => download("quarantine.txt", quarantine.join("\n"), "text/plain")}>Download list</button>
          </>}
        </Section>
      </div>
      <style>{`.fh-row{display:flex;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);flex-wrap:wrap}.fh-msg{font-family:var(--mono);font-size:12px}.fh-strip{display:flex;gap:2px}.fh-strip i{width:7px;height:22px;border-radius:2px}.fh-strip .ok{background:var(--good)}.fh-strip .no{background:var(--bad)}
      .fh-pre{background:var(--sunk);padding:10px;border-radius:8px;font-size:13px;white-space:pre-wrap;margin:0 0 10px}`}</style>
    </div>
  );
}
