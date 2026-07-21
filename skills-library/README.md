# Agent Factory — SKILLS library

Reusable agent-design know-how the factory brain **authors at runtime** and
persists here, so later runs (in any domain) can discover and reuse it. The
factory compounds its own experience instead of re-deriving it every run.

## Layout

```
skills-library/
  <skill-slug>/
    SKILL.md     ← one skill: frontmatter + the prompt fragment it weaves in
```

**Each sub-folder is exactly one SKILL.** `SKILL.md` frontmatter:

| field | meaning |
|---|---|
| `name` | human name |
| `slug` | folder name |
| `purpose` | what problem it solves |
| `domain` | the domain it was authored in, or `*` for general (reusable anywhere) |
| `tools` | tools the skill recommends an agent bind |
| `decisionRule` | the one-line rule it encodes |
| `useCount` | how many later runs adopted it (a reuse signal) |

The body (after the frontmatter) is the guidance woven into a generated agent's
system prompt.

## Lifecycle

1. The brain calls `create_skill` → the skill is written here **and** used in the
   current run.
2. On the next `brain.start`, `loadSkills(domain)` surfaces this domain's skills
   + general skills to the brain (via `read_ontology` → `reusable_skills`).
3. The brain calls `use_skill` to adopt one → it's woven into the agents it
   designs, and the skill's `useCount` is bumped.

Skills are plain documents — open, edit, or delete a folder by hand at will.
