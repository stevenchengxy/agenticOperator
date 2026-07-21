import { describe, expect, it } from "vitest";
import {
  recoveryActionLabel,
  technicalCauseLabel,
  technicalOutcomeLabel,
} from "./OutcomeBadges";

describe("monitor outcome labels", () => {
  it("keeps the machine degraded state but renders it as a generic technical anomaly", () => {
    expect(technicalOutcomeLabel("degraded", "zh")).toBe("技术异常");
    expect(technicalOutcomeLabel("degraded", "en")).toBe("Technical anomaly");
  });

  it("renders a paid-dependency exhaustion with an actionable recovery label", () => {
    expect(technicalCauseLabel("quota_exhausted", "zh")).toBe("额度不足");
    expect(recoveryActionLabel("top_up_then_retry", "zh")).toBe("充值后自动续跑");
  });
});
