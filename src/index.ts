interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * NIH Supplements
 *
 * Two NIH sources, both from the Office of Dietary Supplements (ODS):
 *   1. ODS fact sheets (ods.od.nih.gov/api) — plain-language + clinician-level
 *      write-ups on vitamins, minerals, and a handful of botanicals: uses,
 *      whether they work, safety, interactions with medications, references.
 *   2. DSLD (api.ods.od.nih.gov/dsld) — the Dietary Supplement Label Database:
 *      what's actually printed on a specific product's label (brand,
 *      ingredients, amounts, claims), not the science.
 * Plus one bounded extractor over NCCIH's "Herbs at a Glance" pages for the
 * many popular herbs (turmeric, ginkgo, echinacea, garlic, ginseng, ...) that
 * ODS itself has no fact sheet for — ODS's own botanical-background page
 * links OUT to NCCIH for exactly these, so a caller asking for one of them
 * gets pointed at the right tool instead of a bare "not found".
 *
 * German Commission E (the other named source in this build's scope doc,
 * docs/herbal-sources-scope.md §2) is NOT ingested here: the ABC English
 * translation on herbalgram.org is a copyrighted 1998/2000 work with no reuse
 * terms on the page. Reference it by URL if you need to point someone at it;
 * do not scrape or mirror its text.
 *
 * TRAP (verified 2026-09-07, filed as fleet task #1356): the ODS fact-sheet
 * API returns real XML on a fresh call with a browser User-Agent, but a rapid
 * second call from the same client comes back HTTP 200 with an HTML bot-check
 * page instead — same status code, completely different (and useless) body.
 * `spacedFetch` below treats ANY html/doctype-shaped body from ODS as that
 * bot-check, never as data, caches successful responses per isolate, and
 * floors the gap between our own outbound calls so normal traffic doesn't
 * trigger it in the first place.
 *
 * There is no ODS endpoint that lists every fact sheet (the obvious one 403s,
 * and the sitemap carries no fact-sheet URLs), so the ~45-topic inventory
 * below is bundled by hand from ODS's own public list page
 * (ods.od.nih.gov/factsheets/list-all/), read once on 2026-09-07. Same for
 * the 56-herb NCCIH "Herbs at a Glance" index. Re-scrape by hand if NIH adds
 * a new topic; there's no live index to diff against.
 *
 * hosting-claims-ok: this file quotes NIH's own URLs throughout to attribute
 * every fact and label to its federal source, which is the required form, not
 * an exception to it.
 */


// A browser UA is load-bearing here, not cosmetic: the bare Workers UA (or no
// UA at all) is what ODS's bot-check keys off first. Chosen deliberately —
// see the file header trap note.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Fetch layer: per-isolate cache + a floor between outbound calls ───────
//
// Both defenses exist for the same trap (see file header). The cache means a
// warm isolate mostly never calls ODS twice for the same fact sheet; the
// floor means that when it does have to, it isn't "rapid" from ODS's point of
// view. Shared across all three upstreams this pack calls (ODS fact sheets,
// DSLD, NCCIH) — none of them are rate-generous, and none of them need to be
// hit more than once every few hundred milliseconds by us.
const CACHE_TTL_MS = 60 * 60 * 1000; // fact sheets/labels change on the order of months, not minutes
const MIN_GAP_MS = 700;

interface CacheEntry {
  at: number;
  body: string;
  ok: true;
}

const cache = new Map<string, CacheEntry>();
let lastCallAt = 0;

/**
 * Fetch `url` with the shared UA, cache, and pacing above.
 *
 * `expectHtml` distinguishes the two ways this pack reads a body: ODS
 * (fact-sheet XML) and DSLD (JSON) never legitimately return HTML, so an
 * HTML-shaped body from either IS the bot-check and is thrown as such. NCCIH
 * pages ARE HTML, so that check is skipped there.
 */
async function spacedFetch(
  url: string,
  upstreamName: string,
  opts: { expectHtml: boolean },
): Promise<string> {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.body;

  const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCallAt = Date.now();

  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, Accept: '*/*' } }, upstreamName);
  const body = await res.text();

  if (!res.ok) {
    const summary = summarizeErrorBody(body);
    throw new Error(`${upstreamName}: HTTP ${res.status}${summary ? ` — ${summary}` : ''}`);
  }

  if (!opts.expectHtml) {
    const head = body.trimStart().slice(0, 300).toLowerCase();
    if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
      throw new Error(
        `upstream_down: ${upstreamName} answered HTTP 200 with an HTML page instead of the expected data. ` +
          "This is NIH ODS's bot-check challenge, not a missing fact sheet or label — it fires on rapid " +
          'repeated calls from the same client, not on any argument you passed. Wait a few seconds and retry ' +
          'the exact same call unchanged.',
      );
    }
  }

  if (!body.trim()) {
    throw new Error(`upstream_down: ${upstreamName} answered HTTP ${res.status} with an empty body.`);
  }

  cache.set(url, { at: Date.now(), body, ok: true });
  return body;
}

// ── Text helpers ───────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  reg: '®',
  trade: '™',
  copy: '©',
  deg: '°',
  eacute: 'é',
  uuml: 'ü',
  micro: 'µ',
  frac12: '½',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z0-9]+);/g, (m, name) => (NAMED_ENTITIES[name] !== undefined ? NAMED_ENTITIES[name] : m));
}

/** Strip tags AND the content of <script>/<style> (which plain tag-stripping
 *  would otherwise dump inline as text), then decode entities and collapse
 *  whitespace. */
function htmlToPlainText(raw: string): string {
  const noScripts = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const noTags = noScripts.replace(/<[^>]+>/g, ' ');
  return decodeEntities(noTags).replace(/\s+/g, ' ').trim();
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ── ODS fact sheet XML ──────────────────────────────────────────────────────

function xmlField(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m ? m[1] : null;
}

function xmlBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

interface FactsheetSection {
  heading: string;
  text: string;
}

interface FactsheetReference {
  ref_id: string | null;
  citation: string;
  pmid: string | null;
}

interface ParsedFactsheet {
  fsid: string | null;
  title: string;
  reviewed: string | null;
  source_url: string | null;
  sections: FactsheetSection[];
  references: FactsheetReference[];
}

/**
 * The XML's <Content> element is one HTML-entity-encoded blob with <h2>
 * section headings and <h3> sub-headings inside. Workers have no DOMParser,
 * so split on <h2> boundaries with a plain string scan rather than a DOM walk
 * (same approach the edgar pack uses for Form 4 XML, which has the same
 * no-DOMParser constraint).
 */
function parseFactsheet(xml: string): ParsedFactsheet {
  const fsid = xmlField(xml, 'FSID');
  const reviewed = xmlField(xml, 'Reviewed');
  const sourceUrl = xmlField(xml, 'URL');
  const title = decodeEntities((xmlField(xml, 'Title') ?? '').trim());
  const contentHtml = decodeEntities(xmlField(xml, 'Content') ?? '');

  const sections: FactsheetSection[] = [];
  const parts = contentHtml.split(/<h2[^>]*>/i);
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const closeIdx = chunk.search(/<\/h2>/i);
    if (closeIdx === -1) continue;
    const heading = htmlToPlainText(chunk.slice(0, closeIdx));
    const text = htmlToPlainText(chunk.slice(closeIdx + 5));
    if (heading || text) sections.push({ heading, text });
  }

  const references: FactsheetReference[] = [];
  for (const block of xmlBlocks(xml, 'EndNote')) {
    const citationRaw = xmlField(block, 'Reference');
    if (!citationRaw) continue;
    const citation = decodeEntities(citationRaw.trim());
    const refId = xmlField(block, 'RefID');
    const pmidRaw = xmlField(block, 'PMID');
    const pmid = pmidRaw && pmidRaw.trim() ? pmidRaw.trim() : null;
    references.push({ ref_id: refId ? refId.trim() : null, citation, pmid });
  }

  return { fsid: fsid ? fsid.trim() : null, title, reviewed: reviewed ? reviewed.trim() : null, source_url: sourceUrl ? sourceUrl.trim() : null, sections, references };
}

// ── Bundled ODS fact sheet inventory ────────────────────────────────────────
//
// ~45 topics, read by hand from https://ods.od.nih.gov/factsheets/list-all/
// on 2026-09-07 — no live index exists to fetch this from at call time (the
// obvious list endpoint 403s; the sitemap carries no fact-sheet URLs). A
// `consumerSlug`/`professionalSlug` of `null` means ODS does not publish a
// fact sheet at that reading level for the topic at all (e.g. Black Cohosh:
// professional only). Almost every topic uses the SAME resourcename for both
// levels — `readinglevel` is a separate query param — but two topics
// ("Dietary Supplements in the Time of COVID-19" and, functionally, the
// Chromium page) use a different slug per level, which is why this is a
// struct per topic rather than one shared slug.
interface OdsTopic {
  name: string;
  consumerSlug: string | null;
  professionalSlug: string | null;
}

const ODS_TOPICS: OdsTopic[] = [
  { name: 'Ashwagandha: Is it helpful for stress, anxiety, or sleep?', consumerSlug: 'Ashwagandha', professionalSlug: 'Ashwagandha' },
  { name: 'Biotin', consumerSlug: 'Biotin', professionalSlug: 'Biotin' },
  { name: 'Black Cohosh', consumerSlug: null, professionalSlug: 'BlackCohosh' },
  { name: 'Boron', consumerSlug: 'Boron', professionalSlug: 'Boron' },
  { name: 'Botanical Dietary Supplements - Background Information', consumerSlug: 'BotanicalBackground', professionalSlug: null },
  { name: 'Calcium', consumerSlug: 'Calcium', professionalSlug: 'Calcium' },
  { name: 'Carnitine', consumerSlug: 'Carnitine', professionalSlug: 'Carnitine' },
  { name: 'Choline', consumerSlug: 'Choline', professionalSlug: 'Choline' },
  { name: 'Chromium', consumerSlug: 'chromium', professionalSlug: 'Chromium' },
  { name: 'Copper', consumerSlug: 'Copper', professionalSlug: 'Copper' },
  { name: 'Dietary Supplements: Background Information', consumerSlug: 'DietarySupplements', professionalSlug: null },
  { name: 'Dietary Supplements in the Time of COVID-19', consumerSlug: 'DietarySupplementsInTheTimeOfCOVID19', professionalSlug: 'COVID19' },
  { name: 'Summary of Evidence-Based Ephedra Review', consumerSlug: null, professionalSlug: 'EphedraandEphedrine' },
  { name: 'Dietary Supplements for Exercise and Athletic Performance', consumerSlug: 'ExerciseAndAthleticPerformance', professionalSlug: 'ExerciseAndAthleticPerformance' },
  { name: 'Fluoride', consumerSlug: 'Fluoride', professionalSlug: 'Fluoride' },
  { name: 'Folate', consumerSlug: 'Folate', professionalSlug: 'Folate' },
  { name: 'Dietary Supplements for Immune Function and Infectious Diseases', consumerSlug: 'ImmuneFunction', professionalSlug: 'ImmuneFunction' },
  { name: 'Iodine', consumerSlug: 'Iodine', professionalSlug: 'Iodine' },
  { name: 'Iron', consumerSlug: 'Iron', professionalSlug: 'Iron' },
  { name: 'Multivitamin/mineral Supplements', consumerSlug: 'MVMS', professionalSlug: 'MVMS' },
  { name: 'Magnesium', consumerSlug: 'Magnesium', professionalSlug: 'Magnesium' },
  { name: 'Manganese', consumerSlug: 'Manganese', professionalSlug: 'Manganese' },
  { name: 'Molybdenum', consumerSlug: 'Molybdenum', professionalSlug: 'Molybdenum' },
  { name: 'Niacin', consumerSlug: 'Niacin', professionalSlug: 'Niacin' },
  { name: 'Omega-3 Fatty Acids', consumerSlug: 'Omega3FattyAcids', professionalSlug: 'Omega3FattyAcids' },
  { name: 'Pantothenic Acid', consumerSlug: 'PantothenicAcid', professionalSlug: 'PantothenicAcid' },
  { name: 'Phosphorus', consumerSlug: 'Phosphorus', professionalSlug: 'Phosphorus' },
  { name: 'Potassium', consumerSlug: 'Potassium', professionalSlug: 'Potassium' },
  { name: 'Dietary Supplements and Life Stages: Pregnancy', consumerSlug: null, professionalSlug: 'Pregnancy' },
  { name: 'Dietary Supplements for Primary Mitochondrial Disorders', consumerSlug: null, professionalSlug: 'PrimaryMitochondrialDisorders' },
  { name: 'Probiotics', consumerSlug: 'Probiotics', professionalSlug: 'Probiotics' },
  { name: 'Riboflavin', consumerSlug: 'Riboflavin', professionalSlug: 'Riboflavin' },
  { name: 'Selenium', consumerSlug: 'Selenium', professionalSlug: 'Selenium' },
  { name: 'Thiamin', consumerSlug: 'Thiamin', professionalSlug: 'Thiamin' },
  { name: 'Valerian', consumerSlug: null, professionalSlug: 'Valerian' },
  { name: 'Vitamin A', consumerSlug: 'VitaminA', professionalSlug: 'VitaminA' },
  { name: 'Vitamin B12', consumerSlug: 'VitaminB12', professionalSlug: 'VitaminB12' },
  { name: 'Vitamin B6', consumerSlug: 'VitaminB6', professionalSlug: 'VitaminB6' },
  { name: 'Vitamin C', consumerSlug: 'VitaminC', professionalSlug: 'VitaminC' },
  { name: 'Vitamin D', consumerSlug: 'VitaminD', professionalSlug: 'VitaminD' },
  { name: 'Vitamin E', consumerSlug: 'VitaminE', professionalSlug: 'VitaminE' },
  { name: 'Vitamin K', consumerSlug: 'VitaminK', professionalSlug: 'VitaminK' },
  { name: 'Dietary Supplements: What You Need to Know', consumerSlug: 'WYNTK', professionalSlug: null },
  { name: 'Dietary Supplements for Weight Loss', consumerSlug: 'WeightLoss', professionalSlug: 'WeightLoss' },
  { name: 'Zinc', consumerSlug: 'Zinc', professionalSlug: 'Zinc' },
];

function resolveTopic(query: string): OdsTopic | undefined {
  const q = normalize(query);
  const exact = ODS_TOPICS.find(
    (t) => normalize(t.name) === q || (t.consumerSlug && normalize(t.consumerSlug) === q) || (t.professionalSlug && normalize(t.professionalSlug) === q),
  );
  if (exact) return exact;
  return ODS_TOPICS.find(
    (t) => normalize(t.name).includes(q) || (t.consumerSlug && normalize(t.consumerSlug).includes(q)) || (t.professionalSlug && normalize(t.professionalSlug).includes(q)),
  );
}

// ── NCCIH "Herbs at a Glance" (stop-rule item) ──────────────────────────────
//
// STOP-RULE OUTCOME (checked 2026-09-07, per task #1356): no JSON-LD or
// __NEXT_DATA__ on these pages, and no XHR/API was found — but every <h2> in
// the content body carries a stable `id` attribute
// (background / how-much-do-we-know / what-have-we-learned /
// what-do-we-know-about-safety / keep-in-mind / for-more-information /
// key-references), verified IDENTICAL and in the same order across 5 pages
// (ashwagandha, echinacea, garlic, ginkgo, turmeric). That is exactly the
// "sections are stable" condition the scope doc's stop-rule required, so the
// bounded prose extractor below is IN, scoped to the ~56 herbs on NCCIH's own
// index page (nccih.nih.gov/health/herbsataglance), bundled the same way as
// the ODS inventory above since NCCIH has no fact-sheet-list API either.
const NCCIH_SECTION_LABELS: Record<string, string> = {
  background: 'Background',
  'how-much-do-we-know': 'How Much Do We Know?',
  'what-have-we-learned': 'What Have We Learned?',
  'what-do-we-know-about-safety': 'What Do We Know About Safety?',
  'keep-in-mind': 'Keep In Mind',
  'for-more-information': 'For More Information',
  'key-references': 'Key References',
};

interface NccihHerb {
  slug: string;
  name: string;
}

const NCCIH_HERBS: NccihHerb[] = [
  { slug: 'acai', name: 'Acai' },
  { slug: 'aloe-vera', name: 'Aloe Vera' },
  { slug: 'ashwagandha', name: 'Ashwagandha' },
  { slug: 'asian-ginseng', name: 'Asian Ginseng' },
  { slug: 'astragalus', name: 'Astragalus' },
  { slug: 'bilberry', name: 'Bilberry' },
  { slug: 'bitter-orange', name: 'Bitter Orange' },
  { slug: 'black-cohosh', name: 'Black Cohosh' },
  { slug: 'boswellia', name: 'Boswellia' },
  { slug: 'bromelain', name: 'Bromelain' },
  { slug: 'butterbur', name: 'Butterbur' },
  { slug: 'cats-claw', name: "Cat's Claw" },
  { slug: 'chamomile', name: 'Chamomile' },
  { slug: 'chasteberry', name: 'Chasteberry' },
  { slug: 'cinnamon', name: 'Cinnamon' },
  { slug: 'cranberry', name: 'Cranberry' },
  { slug: 'dandelion', name: 'Dandelion' },
  { slug: 'echinacea', name: 'Echinacea' },
  { slug: 'elderberry', name: 'Elderberry' },
  { slug: 'ephedra', name: 'Ephedra' },
  { slug: 'european-mistletoe', name: 'European Mistletoe' },
  { slug: 'evening-primrose-oil', name: 'Evening Primrose Oil' },
  { slug: 'fenugreek', name: 'Fenugreek' },
  { slug: 'feverfew', name: 'Feverfew' },
  { slug: 'flaxseed-and-flaxseed-oil', name: 'Flaxseed and Flaxseed Oil' },
  { slug: 'garcinia-cambogia', name: 'Garcinia Cambogia' },
  { slug: 'garlic', name: 'Garlic' },
  { slug: 'ginger', name: 'Ginger' },
  { slug: 'ginkgo', name: 'Ginkgo' },
  { slug: 'goldenseal', name: 'Goldenseal' },
  { slug: 'grape-seed-extract', name: 'Grape Seed Extract' },
  { slug: 'green-tea', name: 'Green Tea' },
  { slug: 'hawthorn', name: 'Hawthorn' },
  { slug: 'hoodia', name: 'Hoodia' },
  { slug: 'horse-chestnut', name: 'Horse Chestnut' },
  { slug: 'kava', name: 'Kava' },
  { slug: 'lavender', name: 'Lavender' },
  { slug: 'licorice-root', name: 'Licorice Root' },
  { slug: 'milk-thistle', name: 'Milk Thistle' },
  { slug: 'mugwort', name: 'Mugwort' },
  { slug: 'noni', name: 'Noni' },
  { slug: 'passionflower', name: 'Passionflower' },
  { slug: 'peppermint-oil', name: 'Peppermint Oil' },
  { slug: 'pomegranate', name: 'Pomegranate' },
  { slug: 'red-clover', name: 'Red Clover' },
  { slug: 'rhodiola', name: 'Rhodiola' },
  { slug: 'sage', name: 'Sage' },
  { slug: 'saw-palmetto', name: 'Saw Palmetto' },
  { slug: 'soy', name: 'Soy' },
  { slug: 'st-johns-wort', name: "St. John's Wort" },
  { slug: 'tea-tree-oil', name: 'Tea Tree Oil' },
  { slug: 'thunder-god-vine', name: 'Thunder God Vine' },
  { slug: 'turmeric', name: 'Turmeric' },
  { slug: 'valerian', name: 'Valerian' },
  { slug: 'white-mulberry-leaf', name: 'White Mulberry Leaf' },
  { slug: 'yohimbe', name: 'Yohimbe' },
];

function resolveHerb(query: string): NccihHerb | undefined {
  const q = normalize(query);
  return (
    NCCIH_HERBS.find((h) => normalize(h.name) === q || normalize(h.slug) === q) ??
    NCCIH_HERBS.find((h) => normalize(h.name).includes(q) || normalize(h.slug).includes(q))
  );
}

interface NccihSection {
  id: string;
  label: string;
  text: string;
}

function parseNccihSections(html: string): NccihSection[] {
  const heads: { id: string; endIndex: number }[] = [];
  const re = /<h2 id="([a-z0-9-]+)"[^>]*>[\s\S]*?<\/h2>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    heads.push({ id: m[1], endIndex: re.lastIndex });
  }
  const sections: NccihSection[] = [];
  for (let i = 0; i < heads.length; i++) {
    const { id, endIndex } = heads[i];
    const bodyEnd = i + 1 < heads.length ? html.indexOf('<h2 id=', endIndex) : html.length;
    const body = html.slice(endIndex, bodyEnd === -1 ? html.length : bodyEnd);
    sections.push({ id, label: NCCIH_SECTION_LABELS[id] ?? id, text: htmlToPlainText(body) });
  }
  return sections;
}

// ── Tools ────────────────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'supplement_factsheet',
    description:
      "A specific vitamin, mineral, or supplement's NIH fact sheet — what it does, whether it works, safety, and interactions with medications. Sourced from NIH's Office of Dietary Supplements (ODS). Two reading levels: 'consumer' (short, plain language) or 'professional' (long, clinical, with a references list). Covers ~45 topics (vitamins, minerals, a few botanicals like ashwagandha) — call supplement_factsheets to see the full list. For popular herbs NOT on that list (turmeric, ginkgo, echinacea, garlic, ginseng, milk thistle, St. John's Wort, and more), use herb_at_a_glance instead.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Topic name, e.g. "Vitamin D", "Ashwagandha", "Magnesium". Fuzzy-matched against the bundled ODS topic list.' },
        level: { type: 'string', enum: ['consumer', 'professional'], description: 'Reading level. "consumer" (default) is short and plain-language; "professional" is the long clinical version with a references list.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'supplement_factsheets',
    description:
      "The bundled list of ~45 topics NIH ODS publishes a fact sheet for (vitamins, minerals, a few botanicals) — what to pass as `name` to supplement_factsheet, and which reading levels each has. Optional `query` filters by substring. There is no live NIH endpoint that lists all fact sheets, so this is a point-in-time inventory read from ODS's own list page.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Optional substring filter, e.g. "vitamin" or "iron".' },
      },
    },
  },
  {
    name: 'supplement_labels',
    description:
      "Search real supplement product labels — brand name, ingredients, amounts, claims — from NIH's Dietary Supplement Label Database (DSLD). This is what's printed on a bottle, not the science behind an ingredient (use supplement_factsheet or herb_at_a_glance for that). Search by product name, brand, or ingredient. Returns each label's `id` for use with supplement_label.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free-text search — a product name, brand, or ingredient, e.g. "ashwagandha" or "Nature Made fish oil".' },
        limit: { type: 'number', description: 'Max labels to return (default 20, max 50).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'supplement_label',
    description:
      "One product's full DSLD label detail: manufacturer contact, every ingredient with its amount, other (non-active) ingredients, and the precaution/warning statements printed on the bottle. Takes the numeric `id` a supplement_labels result returned.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: ['string', 'number'], description: 'DSLD label id, from a supplement_labels result.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'supplement_recent_changes',
    description:
      "New supplement product labels entered into NIH's Dietary Supplement Label Database (DSLD) since a given date — the one NIH supplement upstream that publishes a queryable change signal. Returns each new label's id, brand, product name, and entry date, newest first; deterministic on replay. Scope is stated, not guessed: DSLD does not publish off-market (withdrawal) transitions as dated events, and neither ODS fact sheets nor NCCIH herb pages publish a queryable list of content-update dates — the response says so explicitly instead of pretending to cover them. Each supplement_factsheet response carries its own 'reviewed' date for direct sweeping.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        since: { type: 'string', description: 'Cutoff date, YYYY-MM-DD. Labels entered into DSLD on or after this date are returned.' },
        limit: { type: 'number', description: 'Max new labels to return (default 50, max 200). If more entered since the cutoff, the response sets truncated: true.' },
      },
      required: ['since'],
    },
  },
  {
    name: 'herb_at_a_glance',
    description:
      "A popular herb's science-and-safety summary from NIH's National Center for Complementary and Integrative Health (NCCIH) 'Herbs at a Glance' series — what the science says, side effects and cautions, and key references. Covers ~56 widely-used herbs (turmeric, ginkgo, echinacea, garlic, ginseng, milk thistle, St. John's Wort, and more) that NIH's Office of Dietary Supplements does NOT have its own fact sheet for. For a vitamin, mineral, or the handful of botanicals ODS does cover (ashwagandha, black cohosh, valerian), use supplement_factsheet instead.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        herb: { type: 'string', description: 'Herb name, e.g. "turmeric" or "St. John\'s Wort". Fuzzy-matched against the bundled NCCIH herb list.' },
      },
      required: ['herb'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'supplement_factsheet': {
      const nameArg = String(args.name ?? '').trim();
      if (!nameArg) {
        throw new Error('supplement_factsheet requires "name" — a topic from the bundled ODS inventory (call supplement_factsheets to browse it).');
      }
      const levelArg = args.level ? String(args.level).toLowerCase() : 'consumer';
      if (levelArg !== 'consumer' && levelArg !== 'professional') {
        throw new Error(`supplement_factsheet: "level" must be "consumer" or "professional", got "${String(args.level)}".`);
      }

      const topic = resolveTopic(nameArg);
      if (!topic) {
        const herb = resolveHerb(nameArg);
        if (herb) {
          throw new Error(
            `NIH ODS does not publish its own fact sheet for ${herb.name} — that's one of the herbs covered instead by NCCIH's "Herbs at a Glance". Call herb_at_a_glance {"herb": "${herb.slug}"}.`,
          );
        }
        throw new Error(
          `"${nameArg}" is not in the bundled ODS fact-sheet inventory (${ODS_TOPICS.length} topics — vitamins, minerals, and a few botanicals). Call supplement_factsheets to browse it, or try herb_at_a_glance for a wider list of herbs.`,
        );
      }

      const slug = levelArg === 'consumer' ? topic.consumerSlug : topic.professionalSlug;
      if (!slug) {
        const otherLevel = levelArg === 'consumer' ? 'professional' : 'consumer';
        throw new Error(`ODS only publishes a "${otherLevel}" fact sheet for "${topic.name}" — retry with level: "${otherLevel}".`);
      }

      const readingLevel = levelArg === 'consumer' ? 'Consumer' : 'HealthProfessional';
      const url = `https://ods.od.nih.gov/api/?resourcename=${encodeURIComponent(slug)}&readinglevel=${readingLevel}&outputformat=XML`;
      const xml = await spacedFetch(url, 'NIH ODS fact sheet API', { expectHtml: false });
      const parsed = parseFactsheet(xml);

      const REFERENCE_CAP = 40;
      return {
        name: topic.name,
        level: levelArg,
        fsid: parsed.fsid,
        title: parsed.title,
        reviewed: parsed.reviewed,
        source_url: parsed.source_url,
        source: 'NIH Office of Dietary Supplements (ODS) fact sheet',
        sections: parsed.sections,
        references: parsed.references.slice(0, REFERENCE_CAP),
        reference_count: parsed.references.length,
        references_truncated: parsed.references.length > REFERENCE_CAP,
      };
    }

    case 'supplement_factsheets': {
      const q = args.query ? normalize(String(args.query)) : null;
      const matches = ODS_TOPICS.filter(
        (t) =>
          !q ||
          normalize(t.name).includes(q) ||
          (t.consumerSlug && normalize(t.consumerSlug).includes(q)) ||
          (t.professionalSlug && normalize(t.professionalSlug).includes(q)),
      ).map((t) => ({
        name: t.name,
        levels: [t.consumerSlug ? 'consumer' : null, t.professionalSlug ? 'professional' : null].filter((v): v is string => v !== null),
      }));
      return {
        source: 'NIH Office of Dietary Supplements (ODS) fact sheet index (ods.od.nih.gov/factsheets/list-all/)',
        query: args.query ?? null,
        count: matches.length,
        total_topics: ODS_TOPICS.length,
        topics: matches,
      };
    }

    case 'supplement_labels': {
      const query = args.query;
      if (!query || !String(query).trim()) {
        throw new Error('supplement_labels requires "query" — a product name, brand, or ingredient, e.g. {"query": "ashwagandha"}.');
      }
      const limit = Math.min(Math.max(Math.trunc(Number(args.limit) || 20), 1), 50);
      const url = `https://api.ods.od.nih.gov/dsld/v9/search-filter?q=${encodeURIComponent(String(query))}&size=${limit}`;
      const raw = await spacedFetch(url, 'NIH DSLD label search', { expectHtml: false });

      let json: { hits?: Array<{ _id?: string; _source?: Record<string, unknown> }>; stats?: { count?: number } };
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error('upstream_down: NIH DSLD search returned a body that was not valid JSON.');
      }

      const labels = (json.hits ?? []).map((h) => {
        const src = (h._source ?? {}) as Record<string, unknown>;
        const productType = src.productType as { langualCodeDescription?: string } | undefined;
        const ingredients = (src.allIngredients as Array<{ name?: string }> | undefined) ?? [];
        const claims = (src.claims as Array<{ langualCodeDescription?: string }> | undefined) ?? [];
        const netContents = (src.netContents as Array<{ display?: string }> | undefined) ?? [];
        return {
          id: h._id,
          brandName: src.brandName ?? null,
          fullName: src.fullName ?? null,
          productType: productType?.langualCodeDescription ?? null,
          ingredients: ingredients.map((i) => i.name).filter(Boolean),
          claims: claims.map((c) => c.langualCodeDescription).filter(Boolean),
          offMarket: Boolean(src.offMarket),
          netContents: netContents.map((n) => n.display).filter(Boolean),
        };
      });

      return {
        source: "NIH Dietary Supplement Label Database (DSLD) — what's printed on the label, not the science",
        query: String(query),
        count: labels.length,
        total_matches: json.stats?.count ?? labels.length,
        labels,
      };
    }

    case 'supplement_label': {
      const id = args.id;
      if (id === undefined || id === null || String(id).trim() === '') {
        throw new Error('supplement_label requires "id" — a numeric label id from a supplement_labels result.');
      }
      const url = `https://api.ods.od.nih.gov/dsld/v9/label/${encodeURIComponent(String(id))}`;
      const raw = await spacedFetch(url, 'NIH DSLD label detail', { expectHtml: false });

      let json: Record<string, unknown>;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(`upstream_down: NIH DSLD label ${String(id)} returned a body that was not valid JSON.`);
      }

      const productType = json.productType as { langualCodeDescription?: string } | undefined;
      const netContents = (json.netContents as Array<{ display?: string }> | undefined) ?? [];
      const ingredientRows = (json.ingredientRows as Array<Record<string, unknown>> | undefined) ?? [];
      const otherIngredients = (json.otheringredients as { ingredients?: Array<{ name?: string }> } | undefined)?.ingredients ?? [];
      const statements = (json.statements as Array<{ type?: string; notes?: string }> | undefined) ?? [];

      return {
        source: "NIH Dietary Supplement Label Database (DSLD) — what's printed on the label, not the science",
        id: json.id ?? id,
        fullName: json.fullName ?? null,
        brandName: json.brandName ?? null,
        upcSku: json.upcSku ?? null,
        productType: productType?.langualCodeDescription ?? null,
        servingsPerContainer: json.servingsPerContainer ?? null,
        netContents: netContents.map((n) => n.display).filter(Boolean),
        ingredients: ingredientRows.map((r) => {
          const quantities = (r.quantity as Array<{ quantity?: number; unit?: string }> | undefined) ?? [];
          return {
            name: r.name ?? null,
            category: r.category ?? null,
            amounts: quantities.map((q) => `${q.quantity ?? ''} ${q.unit ?? ''}`.trim()).filter(Boolean),
          };
        }),
        otherIngredients: otherIngredients.map((i) => i.name).filter(Boolean),
        statements: statements.map((s) => ({ type: s.type ?? null, text: s.notes ?? null })),
        offMarket: Boolean(json.offMarket),
        entryDate: json.entryDate ?? null,
      };
    }

    case 'supplement_recent_changes': {
      const sinceRaw = String(args.since ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceRaw) || Number.isNaN(Date.parse(`${sinceRaw}T00:00:00Z`))) {
        throw new Error('supplement_recent_changes requires "since" as a real YYYY-MM-DD date, e.g. {"since": "2025-09-01"}.');
      }
      const limit = Math.min(Math.max(Math.trunc(Number(args.limit) || 50), 1), 200);

      // DSLD's search API sorts by entryDate ("Date entered into DSLD") with a
      // stable id tiebreak, so paging newest-first to the cutoff is
      // deterministic — the same `since` replays to the same answer until NIH
      // adds labels. Verified against the live API 2026-09-08.
      const PAGE = 50;
      interface RecentLabel {
        id: string | undefined;
        entryDate: string;
        brandName: unknown;
        fullName: unknown;
        offMarket: boolean;
      }
      const newLabels: RecentLabel[] = [];
      let reachedCutoff = false;
      let exhausted = false;
      for (let from = 0; from < 400 && newLabels.length < limit && !reachedCutoff; from += PAGE) {
        const url = `https://api.ods.od.nih.gov/dsld/v9/search-filter?q=${encodeURIComponent('*')}&size=${PAGE}&from=${from}&sort_by=entryDate&sort_order=desc`;
        const raw = await spacedFetch(url, 'NIH DSLD label search', { expectHtml: false });
        let json: { hits?: Array<{ _id?: string; _source?: Record<string, unknown> }> };
        try {
          json = JSON.parse(raw);
        } catch {
          throw new Error('upstream_down: NIH DSLD search returned a body that was not valid JSON.');
        }
        const hits = json.hits ?? [];
        if (hits.length === 0) {
          exhausted = true;
          break;
        }
        for (const h of hits) {
          const src = (h._source ?? {}) as Record<string, unknown>;
          const entry = typeof src.entryDate === 'string' ? src.entryDate : null;
          if (!entry) continue; // undated label: cannot place it in the window, so it is neither included nor guessed at
          if (entry < sinceRaw) {
            reachedCutoff = true;
            break;
          }
          if (newLabels.length >= limit) break;
          newLabels.push({
            id: h._id,
            entryDate: entry,
            brandName: src.brandName ?? null,
            fullName: src.fullName ?? null,
            offMarket: Boolean(src.offMarket),
          });
        }
        if (hits.length < PAGE) {
          exhausted = true;
          break;
        }
      }
      const truncated = !reachedCutoff && !exhausted;

      return {
        source: "NIH Dietary Supplement Label Database (DSLD) — new labels by their 'Date entered into DSLD'",
        source_url: 'https://dsld.od.nih.gov/',
        since: sinceRaw,
        count: newLabels.length,
        truncated,
        ...(truncated
          ? { truncated_note: `More than ${limit} labels entered since ${sinceRaw} — raise "limit" (max 200) or use a later "since".` }
          : {}),
        new_labels: newLabels,
        withdrawn: {
          status: 'unknown',
          note: 'DSLD marks labels offMarket but does not publish that transition as a dated, queryable event, so withdrawals since a date cannot be listed — absence from this response is not evidence a label is still marketed.',
        },
        factsheets: {
          status: 'not_diffable_upstream',
          note: "Neither ODS fact sheets nor NCCIH's herb pages publish a queryable list of content-update dates (no list endpoint; no sitemap lastmod — checked 2026-09-08). Each supplement_factsheet response carries its own 'reviewed' date, and both corpora are small and fully enumerable (supplement_factsheets, herb_at_a_glance's bundled list), so a periodic refresher should sweep details directly.",
        },
      };
    }

    case 'herb_at_a_glance': {
      const herbArg = String(args.herb ?? '').trim();
      if (!herbArg) {
        throw new Error('herb_at_a_glance requires "herb" — e.g. {"herb": "turmeric"}.');
      }
      const herb = resolveHerb(herbArg);
      if (!herb) {
        throw new Error(
          `"${herbArg}" is not in the bundled NCCIH "Herbs at a Glance" list (${NCCIH_HERBS.length} herbs). If it's a vitamin, mineral, or one of ashwagandha/black cohosh/valerian, try supplement_factsheet instead.`,
        );
      }
      const url = `https://www.nccih.nih.gov/health/${herb.slug}`;
      const html = await spacedFetch(url, 'NCCIH Herbs at a Glance', { expectHtml: true });
      const sections = parseNccihSections(html);
      if (sections.length === 0) {
        throw new Error(
          `upstream_down: NCCIH's page for ${herb.name} (${url}) didn't contain the expected section headings — the page template may have changed since this extractor was written (2026-09-07).`,
        );
      }
      return {
        herb: herb.name,
        source: 'NIH National Center for Complementary and Integrative Health (NCCIH), "Herbs at a Glance"',
        source_url: url,
        sections,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
