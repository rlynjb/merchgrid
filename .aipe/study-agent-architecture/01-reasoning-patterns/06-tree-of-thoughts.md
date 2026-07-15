# Tree of Thoughts

Industry standard, rarely worth its cost in production. Explore multiple reasoning branches, score them, pick the best.

## Zoom out, then zoom in

```
Zoom out — why this pattern barely applies here

┌─ This codebase, today ───────────────────────────────────────┐
│  every check has exactly one deterministic answer — there's   │
│  no "branch and score" step because there's nothing to branch │
│  on. MG-001 either finds a zero-price active variant or it     │
│  doesn't; there's no alternative interpretation to weigh.      │
└──────────────────────────────────────────────────────────────────┘

┌─ Hypothetical Bulk AI, and even there — be skeptical ────────┐
│  branching over multiple possible fixes, scoring each          │
│  ★ almost certainly not worth the token multiplier here either│
└──────────────────────────────────────────────────────────────────┘
```

Tree of Thoughts (ToT) explores several candidate reasoning paths in parallel, scores each, and commits to the best-scoring one — instead of committing to a single line of reasoning the way ReAct does.

**In this codebase:** not yet implemented, and unlikely to ever be a good fit. Even for the hypothetical Bulk AI agent, ToT's branching cost is hard to justify for a task (proposing a catalog fix) that usually has one clearly correct answer per finding, not several plausible ones worth weighing against each other.

## The structure pass

**Axis to trace: cost.** ToT multiplies token cost by the branch factor — three branches means roughly three times the reasoning cost of a single ReAct path, for a benefit that only exists when multiple genuinely distinct approaches are plausible.

## How it works

### Move 1 — the mental model

Picture chess move evaluation: instead of committing to the first plausible move, you look several moves ahead down a few candidate lines and pick the one that scores best.

```
         root question
        ┌──────┼──────┐
        ▼      ▼      ▼
      path A  path B  path C
        │      │      │
      score  score  score
        └──────┼──────┘
               ▼
          best path wins
```

### Move 2 — the step-by-step walkthrough

**Be blunt about the cost:** this is rarely worth it in production. The branching multiplies token cost by the branch factor and rarely beats a well-prompted ReAct loop on real tasks — most problems that look like they need multiple candidate paths turn out, on inspection, to have one dominant approach once the prompt is tightened. Covering this pattern matters for a different reason than using it: recognizing it, and being able to say *why you didn't reach for it*, is the more common and more valuable interview answer than having used it.

**Applied to this codebase's hypothetical future:** a catalog finding like "this variant's price is below cost" doesn't have several equally plausible fixes worth scoring against each other — the fix is close to mechanical once the finding's evidence is read (`evidence: { price: v.price }` in `mg-001.ts:22`, for example, already tells you exactly what's wrong). ToT would burn 2-3x tokens branching over fixes that a single well-grounded ReAct pass would get right the first time.

### Move 3 — the principle

ToT earns its overhead only when a task genuinely has several distinct, non-obvious approaches worth comparing — most tasks that look like that turn out to be a prompting problem in disguise. Default away from it; name the specific case where multiple approaches are genuinely plausible before reaching for it.

## Primary diagram

```
Where ToT's cost multiplier would show up, if ever used here

  1 finding → 1 ReAct pass  = 1x reasoning cost
  1 finding → 3 ToT branches = ~3x reasoning cost, for a
                                task with usually one right answer
```

## Elaborate

ToT (Yao et al., 2023) was built for genuinely combinatorial problems — puzzles, planning tasks with real branching factor — where a single reasoning path is likely to get stuck. Most production agent tasks, including anything this codebase's future Bulk AI would do, don't have that shape; they have one obviously correct move once the context is right, which is a ReAct/plan-and-execute problem, not a search problem.

## Interview defense

**Q: "When would you use Tree of Thoughts?"**
A: Only when a task has a genuine branching factor — several plausible, meaningfully different approaches worth scoring against each other — and a single reasoning path is measurably prone to getting stuck. That's rare in production; most tasks that look branchy are actually a prompting or context problem.

**Q: "Would Bulk AI ever need this?"**
A: Almost certainly not. Catalog fixes derived from deterministic findings tend to have one dominant correct fix, not several worth comparing — the evidence attached to each finding (see `mg-001.ts`'s `evidence` field) already narrows the space enough that branching wouldn't pay for itself.

## See also

- `01-reasoning-patterns/03-react.md` — the pattern ToT is being compared against and usually loses to.
- `01-reasoning-patterns/05-reflexion-self-critique.md` — a cheaper way to get a "second opinion" on one path, instead of branching N ways up front.
- `03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md` — the same overhead-vs-benefit discipline this file applies to branching, applied one level up to whether to add more agents at all.
