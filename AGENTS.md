# AGENTS.md

For a coding agent working in this repository. What the package is and how it is used is in `README.md`.

## Commands

```bash
npm ci               # once
npm test             # vitest, offline: the network is refused to every host but 127.0.0.1
npm run typecheck    # tsc over src/ and test/
npm run build        # tsc to dist/; prepare runs it, so the package installs from its git URL
```

## Rules the code keeps

- No model call anywhere. No network call outside `src/prices.ts`, and that one only toward `config.json`'s
  `prices.url`, with the fetch it is given.
- Every `.jsonl` file of the home is only appended to, through `src/log.ts`. Nothing rewrites or removes a line, but
  cutting a partial last line (a whole last line that lacks only its newline is given one).
- No agent-facing function arms, retires or edits a card. The owner's acts live in `Memory.owner` and the command
  line, nowhere else; the MCP server has no tool for them, and an agent may not write as `owner`.
- The home is never inside a git work tree, and the tests use temporary homes under the system's temporary
  directory.
- macOS, Windows and Linux: no shell-outs, `node:path` for every path, file modes only where `process.platform` is
  not `win32`.
- The repository is public. It holds no path of anyone's machine, no name of a person, no real decision and no
  lesson of anyone's; the only lesson texts are stand-ins in `test/`; none is anyone's real lesson. Never commit a
  home.
  `test/package.test.ts` checks every file git lists.
- Characters in a limit are code points; bytes are UTF-8. Every limit is in `src/limits.ts`.

## Where each thing lives

| File | What it holds |
|---|---|
| `src/cards.ts` | lesson card files: parsing, rendering, and each card's state (armed, changed, broken, unarmed, retired, refused) |
| `src/cli.ts` | the owner's door: the command line, its commands, and the owner's acts at a terminal with the typed word yes |
| `src/decisions.ts` | decisions and their amendments, the lines of `decisions.jsonl` |
| `src/errors.ts` | `MemoryError` and its codes |
| `src/home.ts` | the home: making it, finding it, its files and `DEFAULT_CONFIG`, reading `config.json` |
| `src/ids.ts` | line ids and the SHA-256 every chain uses |
| `src/index.ts` | `openMemory`: the core as one object that both doors are built on, and the package's exports |
| `src/limits.ts` | every number the package pins |
| `src/lock.ts` | the home's lock: one writer at a time |
| `src/log.ts` | the append-only, hash-chained JSONL files, their reading and their reseal |
| `src/match.ts` | whether a card applies to a question, cannot be told, or does not apply |
| `src/mcp.ts` | the agent's door: the stdio MCP server, its seven tools and its instructions |
| `src/outcomes.ts` | measuring a decision close to close from one reading of the bars |
| `src/owner.ts` | the owner's acts on a card: arm, retire, discard |
| `src/prices.ts` | reading daily bars from the price source; the only network call |
| `src/proposals.ts` | agents' proposals of lessons and the owner's answers: accept, edit, reject |
| `src/recall.ts` | answering a recall before a decision, and its line in `recalls.jsonl` |
| `src/reconcile.ts` | asking the price source for every decision with something to measure, and appending outcomes |
| `src/records.ts` | occasions, and each card's record of them |
| `src/render.ts` | a recall's text, in its fixed order within 4,000 bytes; the quoting and the unseen-character escapes every text shares |
| `src/review.ts` | the review's material and the home's status |
| `src/schema.ts` | every input's fields and limits, and the sentences that name a refused field |
| `src/texts.ts` | the text of memory_status, memory_review and memory_reconcile: their content, each within its cap |
| `src/types.ts` | the line, card and config types |
| `src/verify.ts` | whether the home holds together: chains, ids pointed at, armed copies |
