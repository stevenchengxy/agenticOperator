// The persistent SKILLS library — save → load → reuse round-trip on the real
// on-disk folder (cleans up its own temp skill afterward).

import { describe, it, expect, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { saveSkill, loadSkills, readSkill, bumpUseCount, slugifySkill, skillsRoot } from "./skills-library";

const NAME = "测试技能-vitest-临时";
const slug = slugifySkill(NAME);
const GEN_NAME = "通用技能-vitest-临时";
const genSlug = slugifySkill(GEN_NAME);

afterAll(async () => {
  await fs.rm(path.join(skillsRoot(), slug), { recursive: true, force: true }).catch(() => {});
  await fs.rm(path.join(skillsRoot(), genSlug), { recursive: true, force: true }).catch(() => {});
});

describe("skills-library", () => {
  it("save → read round-trips a skill (frontmatter + multiline body)", async () => {
    const saved = await saveSkill(
      { name: NAME, purpose: "解决 X", promptFragment: "织入指导\n第二行", tools: ["robohire.parseResume"], decisionRule: "命中即拦截", general: false },
      "recruit-gen-v1",
    );
    expect(saved.slug).toBe(slug);
    expect(saved.domain).toBe("recruit-gen-v1");
    const back = await readSkill(slug);
    expect(back?.name).toBe(NAME);
    expect(back?.promptFragment).toContain("织入指导");
    expect(back?.promptFragment).toContain("第二行");
    expect(back?.tools).toEqual(["robohire.parseResume"]);
  });

  it("loadSkills returns this domain's skills but not another domain's", async () => {
    const inDomain = await loadSkills("recruit-gen-v1");
    expect(inDomain.some((s) => s.slug === slug)).toBe(true);
    const otherDomain = await loadSkills("feikong");
    expect(otherDomain.some((s) => s.slug === slug)).toBe(false); // domain-scoped, not general
  });

  it("a general (*) skill is visible from ANY domain", async () => {
    await saveSkill({ name: GEN_NAME, purpose: "通用", promptFragment: "通用指导", general: true }, "recruit-gen-v1");
    const fromOther = await loadSkills("feikong");
    expect(fromOther.some((s) => s.slug === genSlug)).toBe(true);
  });

  it("bumpUseCount increments useCount + preserves createdAt", async () => {
    const before = await readSkill(slug);
    await bumpUseCount(slug);
    const after = await readSkill(slug);
    expect(after!.useCount).toBe(before!.useCount + 1);
    expect(after!.createdAt).toBe(before!.createdAt); // history preserved on overwrite
  });
});
