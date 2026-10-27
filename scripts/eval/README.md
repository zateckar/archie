# Retrieval evaluation harness

Scores the retrieval layer against a hand-labelled golden set, so changes to the
pipeline can be judged instead of guessed at.

## Why this exists

The retrieval pipeline is governed by constants that were picked by feel and
have never been measured:

| Constant | Where | Controls |
|---|---|---|
| `MIN_TOPIC_RELEVANCE = 0.45` | `rag.ts` | Cosine floor for topic search |
| `MIN_CLAIM_RELEVANCE = 0.4` | `rag.ts` | Cosine floor for claim search |
| `MIN_COMMUNITY_RELEVANCE = 0.35` | `rag.ts` | Cosine floor for the thematic path |
| `MAX_CONTEXT_COMMUNITIES = 2` | `rag.ts` | Community reports allowed into context |
| `COMMUNITY_REPORT_MIN_SIZE = 3` | `communities.ts` | Smallest community that gets a report |
| `ALIGNMENT_SIMILARITY_THRESHOLD = 0.35` | `knowledge.ts` | Claim → `flagged` |
| `CHUNK_COVERAGE_THRESHOLD = 0.8` | `rag.ts` | Semantic-chunk fallback trigger |
| `MIN_FILLER_CLAIM_RELEVANCE = 0.3` | `rag.ts` | Topic-restricted claims allowed into spare slots |
| `CHAT_SYNTHESIS` (`auto`/`off`/`always`) | env, `chat-pipeline.ts` | Whether context is rewritten before answering |
| `CHAT_VERBATIM_CHUNKS` (default 3) | env, `chat-pipeline.ts` | Verbatim passages on the primary pass |

(The `1.5×` negation boost that used to be listed here was removed: it was
applied after selection and could not change what the model saw.)

Moving any of them is currently a coin flip. With a golden set, it's a
measurement.

### The thematic path needs its own cases

`MIN_COMMUNITY_RELEVANCE` is the least-grounded number in the table — it was
picked by reasoning that a 150-300 word community summary necessarily embeds
further from a short query than a tight topic embedding does, so it has to sit
below the topic floor or the path never fires. That reasoning gives a direction,
not a value.

The golden set can't measure it yet, because corpus-probe cases are all
"what is X" questions that a single topic answers. What's needed is cases of the
kind the community layer exists for:

- broad area questions — "what does our release governance cover?"
- comparisons spanning topics — "how do the approval rules differ by risk level?"
- questions whose answer is a *shape* — "which areas depend on the security team?"

For those, set `expectedTopics` to the topics that should be pulled in via the
community, and use `mustNotRetrieve` to catch the failure mode that matters:
an unrelated community's summary getting injected because the floor is too low.

## Usage

```bash
npm run eval:seed
```

Generates draft cases and merges them into `golden-set.json`. Drafts are written
with `"reviewed": false`.

**Then edit them.** A draft is a starting point, not a label — the seeder knows
what is in the corpus, not what the right answer is. For each case:

- rewrite `query` as a question someone would actually ask
- set `expectedTopics` to the topics that *should* answer it
- trim `expectedClaimSubstrings` to short, distinctive fragments
- set `"reviewed": true`

```bash
npm run eval
```

Runs reviewed cases only. Unreviewed drafts are skipped by design: scoring
against guesses manufactures confidence rather than producing information.

```bash
npm run eval -- --all              # include unreviewed drafts
npm run eval -- --case topic-42    # one case
npm run eval -- --k 10             # change the top-k cutoff
npm run eval -- --json before.json # save results to compare against
```

### Comparing a change

```bash
npm run eval -- --json before.json
```

make the change, then:

```bash
npm run eval -- --json after.json
```

and diff the two summaries.

```bash
npm run eval -- --area application-integration   # one subject area
npm run eval -- --raw                            # skip query analysis
npm run eval -- --answers                        # also generate + judge answers
CHAT_SYNTHESIS=off npm run eval -- --answers --json raw.json   # A/B the synthesis pass
```

## What it measures

By default the query first goes through `analyzeAndCondenseQuery`, exactly as a
chat turn does, and its keyword sets drive retrieval (`--raw` skips that). Before
2026-10 the harness skipped it, so it scored a code path no user hit.

- **topic recall / precision / MRR** over `searchTopics(query, k, floor, rerank)`
- **claim hit rate** — expected substrings present in the knowledge context or the retrieved passages
- **source recall** — `expectedSources` (path substrings) among the verbatim chunks the chat would retrieve
- **leaks** — `mustNotRetrieve` substrings that appeared anyway
- **latency** — median per case

With `--answers`, each case also builds the real answer context
(`buildAnswerContext`), generates the answer and has an LLM judge
(`judge.ts`) report:

- **answer facts** — which of the expert-written `expectedFacts` the answer states correctly
- **unsupported** — answer statements the retrieved context does not support (hallucination signal)
- **cited** — share of factual statements carrying an inline `[source]`
- **off-topic** — answers that do not address the question asked (answer a
  different question, or lead with an incidental rule when asked what something
  is). An off-topic answer fails the case even if it states every expected fact.

This is the only mode that says whether answers are *right*, and the way to
choose `CHAT_SYNTHESIS` and `CHAT_VERBATIM_CHUNKS` on evidence. It costs several
model calls per case, and the judge is itself a model: compare aggregates across
runs and read the per-case lists before trusting a single number.

## Case fields

| Field | Used for |
|---|---|
| `query` | The question, as a user would ask it (Czech or English) |
| `expectedTopics` | Topic recall/MRR. Brittle while the graph has synonym topics — leave empty if unsure |
| `expectedClaimSubstrings` | Short verbatim fragments that must reach the context |
| `expectedSources` | Path substrings of documents that should supply passages |
| `expectedFacts` | Plain-language facts a correct answer states (`--answers`) |
| `mustNotRetrieve` | Regressions to lock out |
| `area` | `--area` filter |
| `reviewed` | Only reviewed cases run by default |

The `application-integration` cases were drafted from `integration-rules.md` and
`integration-patterns-guide.md` and reviewed by the domain expert on 2026-10-27.

Before running, the harness warns `STALE <id>` for any `expectedTopics` entry
that no longer exists as a topic or alias. Topic names change when the graph is
re-extracted, and a stale case otherwise looks like a retrieval miss.

## Sources for cases

1. **`response_feedback`** (thumbs-down rows) — the best source, because a human
   already judged the answer wrong. The table is written by the chat UI but is
   **currently empty**, so this yields nothing until feedback accumulates. It is
   worth checking back once it has rows.
2. **Corpus probes** — auto-generated "what is X" questions over well-populated
   topics. Weak by construction (they mostly test that a topic retrieves
   itself); they exist to give the set shape. The expected fragment comes from
   a claim that *defines* the topic ("X is…", "X stands for…", "X je…"), never
   a duty or a rule, and is cut at a clause boundary (`probe.ts`). Topics with
   no defining claim, or named after a document code, get no probe. The first
   seeder used each topic's longest claim, which produced pairs like
   "Co je Microsoft Teams?" → "Effective June 1, 2023, placing emergency calls (such".
3. **Regressions** — the most valuable cases you will write. When retrieval gets
   something wrong, add the query with the correct expectations, and add the
   wrong answer to `mustNotRetrieve`.

## Quantization benchmark (`quantization.ts`)

Separate harness, separate question: not "does retrieval find the right thing"
but "does the approximate index find what the exact scan finds".

```bash
npx tsx scripts/eval/quantization.ts                      # qbits=4, all tables
npx tsx scripts/eval/quantization.ts --qbits 2 --queries 100
npx tsx scripts/eval/quantization.ts --table topics --json turbo4.json
```

Ground truth is `vector_full_scan`'s own top-k for the same query vector, so it
needs no labels and makes **no embedding-provider calls** — query vectors are
drawn from stored embeddings, optionally perturbed (`--noise`) to model a query
that lands near a document rather than on top of one. Runs against a snapshot of
the DB (WAL included) unless `--in-place`.

Reports recall@k, how often the exact top hit survives, and the speedup, per
table. Results that motivated `qbits=4` in `lib/server/vector-index.ts`:

| table | rows | recall@10 | recall@20 | exact top-1 kept | speedup |
|---|---|---|---|---|---|
| chunks | 445 | 97.5% | 97.6% | 100% | 1.8× |
| topics | 1585 | 97.2% | 98.0% | 100% | 3.2× |
| knowledge_claims | 2163 | 96.7% | 98.4% | 100% | 3.0× |

`qbits=2` drops recall@20 to ~93%; `qbits=3` has no SIMD path in sqlite-vector
1.0.0 and measured *slower* than the exact scan. Re-run this after any embedding
model change — recall is a property of the vectors, not of the code.

## Note on determinism

`searchTopics` is called with reranking enabled to match a real chat turn. When
`LLM_RERANK_ENABLED=false` (the default) the fallback is an LLM-as-reranker at
`temperature: 0`, which is close to but not perfectly deterministic. Treat small
movements in MRR as noise; recall and leak counts are the stable signals.
