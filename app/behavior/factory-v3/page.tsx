"use client";
import { Shell } from "@/components/shared/Shell";
import { FactoryV3Content } from "@/components/behavior/factory-v3/FactoryV3Content";
import { useApp } from "@/lib/i18n";

export default function FactoryV3Page() {
  const { t } = useApp();
  return (
    <Shell crumbs={[t("nav_factory_v2"), "自我验证生成大脑"]} directionTag="Behavior · Agent Factory v3">
      <FactoryV3Content />
    </Shell>
  );
}
