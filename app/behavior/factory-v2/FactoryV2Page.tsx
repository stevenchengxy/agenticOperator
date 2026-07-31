"use client";
import { Shell } from "@/components/shared/Shell";
import { FactoryV2Content } from "@/components/behavior/factory-v2/FactoryV2Content";
import { useApp } from "@/lib/i18n";

export default function FactoryV2Page() {
  const { t } = useApp();
  return (
    <Shell crumbs={[t("nav_factory_v2"), "自我验证生成"]} directionTag="Behavior · Agent Factory v2">
      <FactoryV2Content />
    </Shell>
  );
}
