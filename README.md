# gravit-memory

An investing memory that any agent speaking MCP can connect to. Its unit is the decision: what was decided, why, and
what would show it wrong, registered before anyone knows how it turns out. Beside the decisions sit the owner's
lessons, rules in the owner's own words that only the owner arms, and what followed each decision is measured later
from daily closing prices.

It was built first for Gravit, an investing agent, and it serves any agent the same way.

## What it is not

- It does not trade. It holds no account, no broker and no key, and nothing it answers tells an agent to trade.
- It calls no model. Every answer is computed from the files in its home.
- It runs no server. The agent's door is a process an agent starts over stdio; the owner's door is a command line.
- It has no market data of its own. Outcomes are measured from a price source you name, and with none named,
  nothing is measured.

## Install

Node 22.19 or later (or 24 and later). The package is not published to npm; it installs from its repository, and
building it is part of the install.

```bash
npm install -g github:KairosPan/gravit-memory
gravit-memory init
```

`gravit-memory init` makes the home, `~/.gravit-memory` unless `GRAVIT_MEMORY_HOME` names another directory, and
says where it is. It refuses a directory inside a git work tree (the memory never lives in a repository) and a
directory that already holds something else. Every command takes `--home <path>` in place of the variable.

## Connecting an agent

Give the agent one MCP server, started with this line:

```bash
npx -y github:KairosPan/gravit-memory mcp --as <name>
```

In a client that takes JSON, that is:

```json
{ "mcpServers": { "gravit-memory": { "command": "npx", "args": ["-y", "github:KairosPan/gravit-memory", "mcp", "--as", "research"] } } }
```

`--as` is the agent's name, 2 to 32 lower-case letters, digits or dashes, and never `owner`. Every line the agent
writes carries it, so that a decision, a recall or a proposal says which agent wrote it. Give each agent its own name.
The name is a label, not a proof: see "What is protected" below.

Every agent connected to a home reads the whole record: every decision, every lesson, whoever wrote it. Connect only
agents you would show all of it to.

`gravit-memory mcp` serves the agent's door until its input closes. It also reads `GRAVIT_MEMORY_HOME`, or takes
`--home <path>`.

## The seven tools

The server gives the agent short instructions of its own on when to call each tool.

- `memory_status` — which facts the owner's lessons need and how each is defined, and the state of the memory.
- `memory_reconcile` — measures registered decisions against the price source's daily closes; called when work
  starts.
- `memory_recall` — called before recommending, placing or advising on a trade, or advising to hold or stay out:
  given the actions that might be taken and the facts at hand, it answers the lessons that apply with their record,
  the lessons it cannot tell without a missing fact, and past decisions on the same name.
- `memory_record` — registers a decision before its outcome is known: the owner's (`whose: "owner"`, naming the
  recall) or the agent's own call (`whose: "agent"`), including a decision not to act.
- `memory_amend` — adds to a registered decision: a reference, its close, a review of its thesis, a correction, or
  a void of the agent's own line within 24 hours.
- `memory_propose` — proposes a new lesson, a change to one, or its retirement, with a reason and evidence. It waits
  for the owner.
- `memory_review` — the review's material: decisions measured since a date, each lesson's record, decisions past
  their horizon, proposals waiting.

No tool arms, changes or retires a lesson. A decision is never changed either: what follows it is an amendment, a
new line naming it.

A recall's text is at most 4,000 bytes, in a fixed order: the lessons that apply, the lessons it cannot tell, the
same instrument's past decisions, like decisions, then the state of the memory. When it would run longer it yields
in a fixed order, and an applying lesson's words are never cut.

## A lesson card

A lesson is a file in the home, `lessons/<id>.md`: a block of fields between two lines of three dashes, then the
words. This one is the stand-in card the package's own tests use:

```markdown
---
id: no-chasing-after-a-run
says: dont
actions: [buy, add]
strength: caveat
scope:
  market: [US]
check:
  - { fact: sector, op: in, value: [semiconductors, software] }
  - { fact: change_5d_pct, op: ">=", value: 20 }
facts:
  sector: the stock's sector, as the price source's listing names it
  change_5d_pct: today's close over the close five sessions earlier, minus 1, in percent
source: ["owner, 2026-01-05"]
---
No new position in a name that ran 20% in five sessions.
```

- `id` — the lesson's id, the same as its file's name: lower-case letters, digits and dashes, 2 to 40.
- `says` — `dont`, `do` or `careful`.
- `actions` — the actions it speaks to, of `buy`, `add`, `trim`, `sell`, `short`, `cover`, `hold`, `pass`. A
  recall considering none of them does not meet it.
- `strength` — `caveat` or `red-line`. Red lines are shown first.
- `scope` — optional: the markets (`market`) and the symbols (`symbols`) it is limited to.
- `check` — optional: conditions on facts, each `{ fact, op, value }`, with `op` one of `in`, `>=`, `>`, `<=`,
  `<`, `==`, `!=`. Every check must hold for the lesson to apply. A check that is false on a fact given means it
  does not apply. A fact not given is not taken as false: the recall names it, with its definition, as a fact
  missing, and the agent can fetch it and ask again.
- `facts` — the definition of every fact a check names, so that every agent measures it the same way.
  `memory_status` gives them out.
- `source` — optional: where the lesson came from.
- The words after the second line of dashes — the lesson in the owner's words, at most 200 characters. An agent
  shows them as written.

A card applies only once the owner arms it:

```bash
gravit-memory arm no-chasing-after-a-run
```

The command shows the file as it is now, asks you to type `yes`, and arms exactly the bytes it showed: a copy is
kept under `armed/`, and a line in `owner.jsonl` names its SHA-256. If the file is edited afterwards, the card goes on
applying as it was armed until you arm it again or discard the edit.

An agent never writes a lesson. It proposes one with `memory_propose`, and you answer it in `gravit-memory review`.
An answer to a proposal never writes over a lessons file of yours that you have not armed.

## The owner's commands

| Command | What it does |
|---|---|
| `gravit-memory init` | makes the home and says where it is |
| `gravit-memory status [--json]` | the home: its files, chains, cards, the facts they need, the price source |
| `gravit-memory lessons [--json]` | each lesson card, its state and its words |
| `gravit-memory show <id> [--json]` | a decision with its amendments and figures, or a card with its record |
| `gravit-memory review` | the review's material, then each proposal (accept, edit, reject or skip) and each changed card (arm, discard or skip) |
| `gravit-memory arm <lesson>` | arms a card as its file is now |
| `gravit-memory retire <lesson> --reason <words>` | retires an armed card |
| `gravit-memory void <decision> --reason <words>` | voids a decision |
| `gravit-memory reconcile` | measures the decisions against the price source |
| `gravit-memory verify [--json]` | checks every chain, every id a line points at, every armed copy |
| `gravit-memory reseal` | restarts each broken chain from where it broke |
| `gravit-memory mcp --as <name>` | serves the agent's door over stdio |

`review`, `arm`, `retire`, `void` and `reseal` are the owner's acts. Each runs only at a terminal, shows what will
change, and asks you to type `yes` to an act it names with its object (`Type yes to arm no-chasing-after-a-run
(caveat, dont buy/add, sha 1a2b3c4d5e6f):`); anything else changes nothing, and no flag answers for you. Text from
the home is shown beneath its label behind a fence (`  | ` before each line), with control and format characters
written out as escapes, and every line is cut to the terminal's width with the fence on each further row, so that
nothing in a card or a decision can pose as the command's own words, however long it is. An owner's act refuses a
terminal narrower than 20 columns.

`gravit-memory reconcile` writes its outcome lines under the name `command-line`; do not give an agent that name.

Exit codes: 0 done, 1 nothing changed or refused (and `verify` not sound), 2 misuse.

## Outcomes and the price source

What followed a decision is measured close to close. Day 0 is the decision's date in its market's zone, or the next
session when it was made after the market's close. Each horizon, by default 1, 5, 20 and 60 sessions, is the close
that many sessions after day 0 over day 0's close, and each is measured once, from one reading of the bars: every
figure of a line comes from the same answer of the source. In a market with a benchmark the line also carries the
benchmark's change over the same days, and the decision's change relative to it. When a decision gives the price it
was taken at, the price leg (day 0's close over that price) is taken once: its figure is kept only when the bars are
read within 5 sessions of day 0 and the leg is within ±50%; otherwise the line says it was not taken and why.

The price source is named in the home's `config.json`:

```json
{
  "prices": {
    "url": "",
    "markets": {
      "US": { "venue": "cboe", "benchmark": "SPY", "zone": "America/New_York", "close": "16:00" },
      "CN": { "venue": "china", "zone": "Asia/Shanghai", "close": "15:00" }
    }
  },
  "horizons": [1, 5, 20, 60]
}
```

With `url` empty, nothing is measured. With it set, `memory_reconcile` and `gravit-memory reconcile` ask, for each
symbol with something left to measure, `GET <url>/api/candles` with `venue` and `symbol` and, for a venue other than
`china`, `interval=1d&range=MAX&limit=750` (once more with `limit=5000` when day 0 is older than the bars), or
`range=1Y` for `china`. This is the only network call the package makes; it waits ten seconds and follows no
redirect. The source must answer status 200 with JSON:

```json
{ "ok": true, "candles": [{ "t": 1767571200000, "c": 101.5 }], "adjustment": "split-adjusted" }
```

- `candles` — the daily bars, oldest first, one per date: `t` the bar's time in milliseconds (its date is read in
  UTC) and `c` its close, a number above 0. Other keys of a candle are ignored.
- `adjustment` — optional: how the closes are adjusted, in words; kept on each line measured.
- `today` — optional: `{ "t": … }` marking the last bar as provisional, which is not measured.

A refusal is `{ "ok": false, "refusal": { "message": "…" } }` (or `{ "ok": false, "error": "…" }`); the symbol is
reported refused and asked again at the next reconcile. Anything else is reported as not an answer of daily bars.

When the bars a source gives no longer reach a decision's day 0, the decision is closed as "not measurable from
this source" and is not asked again. An A share (`venue: "china"`) is read a year at a time, about 250 daily bars, so
it is measurable for about a year after its decision; a decision reconciled later than that is closed so.

## What is protected, and what is not

The owner's acts are a gate, not containment. A process that can write the home can write anything in it, including
a line that looks like the owner's. The command line keeps the owner's acts to a person at a terminal who types
`yes`; it cannot keep out a program that writes the files directly.

Each line of each ledger carries the hash of the line before it and the hash of its own text, so `gravit-memory
verify` shows a line that was edited, unless every hash from that line on was recomputed. It does not see lines cut
from the end of a file unless another line points at what was cut. A broken chain stays broken until the owner reseals it; while
`owner.jsonl`'s chain is broken, no lesson applies.

An agent's name is a name, not a proof: any process can start the server under any name but `owner`.

## Where the files are

All of the memory is the home, `~/.gravit-memory` unless `GRAVIT_MEMORY_HOME` or `--home` names another:

| File | What it holds |
|---|---|
| `VERSION` | the home's format version |
| `config.json` | the price source, its markets and the horizons |
| `decisions.jsonl` | decisions and their amendments |
| `recalls.jsonl` | every recall and the lessons it met |
| `outcomes.jsonl` | what was measured after each decision |
| `proposals.jsonl` | the agents' proposals of lessons |
| `owner.jsonl` | the owner's acts: arming, retiring, discarding, answering proposals |
| `lessons/` | the lesson cards as the owner writes them |
| `armed/` | each card as it was armed, byte for byte |
| `last-reconcile.json` | whether the price source answered last time |

Every `.jsonl` file is only appended to. On macOS and Linux the home is readable by its user alone.

To back the memory up, copy the whole directory while no agent and no command is writing to it, and run
`gravit-memory verify --home <the copy>` on the copy. Keep it out of any repository.

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`.
